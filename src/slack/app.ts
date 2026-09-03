import { SlackApp } from "slack-cloudflare-workers";
import type { Env } from "../config";
import * as repo from "../db/repo";
import { createMoodleClient } from "../moodle";
import { loadSettings, moodleCategory, saveSettings, type SettingKey } from "../settings";
import { syncMoodle } from "../sync/reconcile";
import { beginStart, beginStop, finishStart, finishStop } from "../toggl/tracking";
import { nowSec, setTimezoneOffsetMin } from "../time";
import { ACTION, FILTER_ALL } from "./blocks";
import { publishHome } from "./home";
import { reportSaved } from "./messages";
import {
  manualTask,
  parseDue,
  parseOrganizationId,
  snoozeUntilTomorrowMorning,
  splitMoodleCredential,
} from "./parse";
import {
  CALLBACK,
  addTaskModal,
  categoryModal,
  connectionModal,
  notificationModal,
  readValue,
} from "./views";

export const SLACK_EVENTS_PATH = "/slack/events";

/**
 * Slack からの操作を受けるハンドラ群。
 *
 * ack は 3 秒以内に返す必要があるため、実処理はすべて lazy 側で行う。
 * 設定は D1 にあるので、各ハンドラの冒頭で読み直す。
 *
 * 押してから画面が変わるまでを短くするため、外部サービスと往復する処理は
 * 「D1 だけ先に更新 → App Home を描き直す → 外部サービスを追いかける」の順に並べる。
 * 失敗したときだけ、取り消して警告付きでもう一度描き直す。
 */
export function createSlackApp(env: Env): SlackApp<Env> {
  const app = new SlackApp({ env, routes: { events: SLACK_EVENTS_PATH } });

  const withSettings = async () => {
    const settings = await loadSettings(env);
    setTimezoneOffsetMin(settings.timezoneOffsetMin);
    return settings;
  };

  app.event("app_home_opened", async ({ context }) => {
    await publishHome(env, await withSettings(), context.client, nowSec(), { fromSlack: true });
  });

  // ---------------------------------------------------------- タスク操作

  app.action(
    { type: "button", action_id: ACTION.start },
    async () => {},
    async ({ context, payload }) => {
      const taskId = buttonValue(payload);
      if (!taskId) return;
      const settings = await withSettings();
      const now = nowSec();

      const begun = await beginStart(env, settings, taskId, now);
      if ("error" in begun) {
        await publishHome(env, settings, context.client, now, {
          warning: begun.error,
          fromSlack: true,
        });
        return;
      }

      // ここまでで画面は「計測中」になる。Toggl はそのあとで追いかける。
      await publishHome(env, settings, context.client, now, { fromSlack: true });

      const result = await finishStart(env, settings, begun.pending);
      if (!result.ok) {
        await publishHome(env, settings, context.client, nowSec(), { warning: result.message });
      }
    },
  );

  app.action(
    { type: "button", action_id: ACTION.stop },
    async () => {},
    async ({ context }) => {
      const settings = await withSettings();
      const now = nowSec();

      const pending = await beginStop(env, now);
      await publishHome(env, settings, context.client, now, { fromSlack: true });
      if (!pending) return;

      try {
        await finishStop(settings, pending);
      } catch (e) {
        // こちらの記録は閉じ終わっている。Toggl 側に残っていることだけを伝える。
        await publishHome(env, settings, context.client, nowSec(), {
          warning: `Toggl 側の計測を止められませんでした: ${describe(e)}`,
        });
      }
    },
  );

  app.action(
    { type: "button", action_id: ACTION.done },
    async () => {},
    async ({ context, payload }) => {
      const taskId = buttonValue(payload);
      if (!taskId) return;
      const settings = await withSettings();
      const now = nowSec();

      // 完了と、そのタスクの計測停止を 1 回の書き込みにまとめる。
      const running = await repo.getRunningWithTask(env.DB);
      const isRunning = running?.session.task_id === taskId;
      const statements: D1PreparedStatement[] = [repo.markDoneStmt(env.DB, taskId, now)];
      if (running && isRunning) {
        const duration = Math.max(0, now - running.session.started_at);
        statements.push(
          repo.stopSessionStmt(env.DB, running.session.id, now, duration),
          repo.addTrackedSecStmt(env.DB, taskId, duration),
        );
      }
      await env.DB.batch(statements);
      await publishHome(env, settings, context.client, now, { fromSlack: true });

      if (running && isRunning && running.session.toggl_entry_id) {
        await finishStop(settings, {
          entryId: running.session.toggl_entry_id,
          stoppedAt: now,
        });
      }
    },
  );

  app.action(
    { type: "button", action_id: ACTION.undone },
    async () => {},
    async ({ context, payload }) => {
      const taskId = buttonValue(payload);
      if (!taskId) return;
      await repo.markUndone(env.DB, taskId);
      await publishHome(env, await withSettings(), context.client, nowSec(), { fromSlack: true });
    },
  );

  // 「…」にまとめた操作。値は "コマンド:タスクid" の形で入れてある。
  //
  // 「分類を変える」はモーダルを開くので ack 側で処理する。trigger_id は
  // 3 秒で失効するため、lazy に回すと取りこぼす。
  app.action(
    { type: "overflow", action_id: ACTION.more },
    async ({ context, payload }) => {
      const [command, taskId] = selectedValue(payload).split(":");
      if (command !== "category" || !taskId || !context.triggerId) return;
      const [settings, task] = await Promise.all([withSettings(), repo.getTask(env.DB, taskId)]);
      if (!task) return;
      await context.client.views.open({
        trigger_id: context.triggerId,
        view: categoryModal(task.id, task.title, settings.categories, task.category),
      });
    },
    async ({ context, payload }) => {
      const [command, taskId] = selectedValue(payload).split(":");
      if (!taskId) return;
      const now = nowSec();
      switch (command) {
        case "snooze":
          await repo.snoozeTask(env.DB, taskId, snoozeUntilTomorrowMorning(now));
          break;
        case "remove":
          await repo.deleteManualTask(env.DB, taskId);
          break;
        default:
          // "open" はリンクを開くだけ、"category" は ack 側で処理済み
          return;
      }
      await publishHome(env, await withSettings(), context.client, now, { fromSlack: true });
    },
  );

  // 分類での絞り込み。選択は D1 に残す。cron からの描き直しで戻ってしまうため。
  app.action(
    { type: "static_select", action_id: ACTION.filter },
    async () => {},
    async ({ context, payload }) => {
      const selected = selectedValue(payload);
      await repo.setState(env.DB, "home_filter", selected === FILTER_ALL ? "" : selected);
      await publishHome(env, await withSettings(), context.client, nowSec(), { fromSlack: true });
    },
  );

  app.action(
    { type: "button", action_id: ACTION.sync },
    async () => {},
    async ({ context }) => {
      const settings = await withSettings();
      const now = nowSec();

      // Moodle の取得は数秒かかる。押したことが分かるよう先に描き直す。
      await publishHome(env, settings, context.client, now, {
        notice: "同期しています…",
        fromSlack: true,
      });

      let warning: string | null = null;
      try {
        await syncMoodle(env.DB, createMoodleClient(settings), now, moodleCategory(settings));
      } catch (e) {
        warning = `同期に失敗しました: ${describe(e)}`;
      }
      await publishHome(env, settings, context.client, nowSec(), { warning });
    },
  );

  // URL 付きボタン（Moodle を開く）にも block_actions が飛んでくるので、ack だけ返す。
  app.action(/^open_moodle_/, async () => {});

  // ------------------------------------------------------------ モーダル

  // モーダルを開く処理は ack 側で行う。trigger_id は 3 秒で失効するため、
  // lazy に回すと取りこぼす。views.open は 1 リクエストなので ack 内でも間に合う。
  app.action({ type: "button", action_id: ACTION.settingsConnection }, async ({ context }) => {
    if (!context.triggerId) return;
    await context.client.views.open({
      trigger_id: context.triggerId,
      view: connectionModal(await withSettings()),
    });
  });

  app.action({ type: "button", action_id: ACTION.settingsNotification }, async ({ context }) => {
    if (!context.triggerId) return;
    await context.client.views.open({
      trigger_id: context.triggerId,
      view: notificationModal(await withSettings()),
    });
  });

  app.action({ type: "button", action_id: ACTION.addTask }, async ({ context }) => {
    if (!context.triggerId) return;
    const settings = await withSettings();
    await context.client.views.open({
      trigger_id: context.triggerId,
      view: addTaskModal(settings.categories),
    });
  });

  app.view(
    CALLBACK.connection,
    async () => {},
    async ({ context, payload }) => {
      const state = payload.view.state;
      const values: Partial<Record<SettingKey, string | null>> = {
        moodle_base_url: readValue(state, "moodle_base_url"),
        toggl_api_token: readValue(state, "toggl_api_token"),
        toggl_organization_id: parseOrganizationId(readValue(state, "toggl_org")),
        categories: readValue(state, "categories"),
        ...splitMoodleCredential(readValue(state, "moodle_credential")),
      };
      await saveSettings(env.DB, values, nowSec());
      await reportSaved(env, context.client, values);
      await publishHome(env, await withSettings(), context.client, nowSec());
    },
  );

  app.view(
    CALLBACK.notification,
    async () => {},
    async ({ context, payload }) => {
      const state = payload.view.state;
      const values: Partial<Record<SettingKey, string | null>> = {
        timezone_offset_min: readValue(state, "timezone_offset_min"),
        due_tomorrow_hour: readValue(state, "due_tomorrow_hour"),
        due_soon_hours: readValue(state, "due_soon_hours"),
        digest_hour: readValue(state, "digest_hour"),
        weekly_summary_weekday: readValue(state, "weekly_summary_weekday"),
        weekly_summary_hour: readValue(state, "weekly_summary_hour"),
        quiet_start_hour: readValue(state, "quiet_start_hour"),
        quiet_end_hour: readValue(state, "quiet_end_hour"),
        // チェックボックスは未チェックが null になるため、明示的に "0" を書く
        notify_new: readValue(state, "notify_new") === "1" ? "1" : "0",
      };
      await saveSettings(env.DB, values, nowSec());
      await reportSaved(env, context.client, values);
      await publishHome(env, await withSettings(), context.client, nowSec());
    },
  );

  app.view(
    CALLBACK.addTask,
    async () => {},
    async ({ context, payload }) => {
      const state = payload.view.state;
      const title = readValue(state, "title");
      if (!title) return;
      const settings = await withSettings();
      const now = nowSec();
      const task = manualTask(
        title,
        readValue(state, "category"),
        parseDue(readValue(state, "due_date"), readValue(state, "due_time")),
        now,
      );
      await repo.insertTaskStmt(env.DB, task).run();
      await publishHome(env, settings, context.client, now, { fromSlack: true });
    },
  );

  app.view(
    CALLBACK.category,
    async () => {},
    async ({ context, payload }) => {
      const taskId = payload.view.private_metadata;
      if (!taskId) return;
      await repo.setCategory(env.DB, taskId, readValue(payload.view.state, "category"));
      await publishHome(env, await withSettings(), context.client, nowSec(), { fromSlack: true });
    },
  );

  return app;
}

function buttonValue(payload: { actions?: { value?: string }[] }): string | null {
  return payload.actions?.[0]?.value ?? null;
}

function selectedValue(payload: {
  actions?: { selected_option?: { value?: string } | null }[];
}): string {
  return payload.actions?.[0]?.selected_option?.value ?? "";
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
