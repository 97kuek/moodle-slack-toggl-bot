import { SlackApp } from "slack-cloudflare-workers";
import type { Env } from "../config";
import * as repo from "../db/repo";
import { createMoodleClient } from "../moodle";
import { loadSettings, saveSettings, type SettingKey } from "../settings";
import { syncMoodle } from "../sync/reconcile";
import { startTracking, stopTracking } from "../toggl/tracking";
import { nowSec, setTimezoneOffsetMin } from "../time";
import { ACTION } from "./blocks";
import { publishHome } from "./home";
import { reportSaved } from "./messages";
import {
  manualTask,
  parseDue,
  parseOrganizationId,
  snoozeUntilTomorrowMorning,
  splitMoodleCredential,
} from "./parse";
import { CALLBACK, addTaskModal, connectionModal, notificationModal, readValue } from "./views";

export const SLACK_EVENTS_PATH = "/slack/events";

/**
 * Slack からの操作を受けるハンドラ群。
 *
 * ack は 3 秒以内に返す必要があるため、実処理はすべて lazy 側で行う。
 * 設定は D1 にあるので、各ハンドラの冒頭で読み直す。
 */
export function createSlackApp(env: Env): SlackApp<Env> {
  const app = new SlackApp({ env, routes: { events: SLACK_EVENTS_PATH } });

  const withSettings = async () => {
    const settings = await loadSettings(env);
    setTimezoneOffsetMin(settings.timezoneOffsetMin);
    // Slack からの受信が実際に届いているかを後から確認できるようにする。
    // publishHome は cron からも呼ばれるため、それとは別に記録する。
    await repo.setState(env.DB, "last_slack_event_at", String(nowSec()));
    return settings;
  };

  app.event("app_home_opened", async ({ context }) => {
    await publishHome(env, await withSettings(), context.client, nowSec());
  });

  // ---------------------------------------------------------- タスク操作

  app.action(
    { type: "button", action_id: ACTION.start },
    async () => {},
    async ({ context, payload }) => {
      const taskId = buttonValue(payload);
      if (!taskId) return;
      const settings = await withSettings();
      const result = await startTracking(env, settings, taskId);
      await publishHome(env, settings, context.client, nowSec(), result.ok ? null : result.message);
    },
  );

  app.action(
    { type: "button", action_id: ACTION.stop },
    async () => {},
    async ({ context }) => {
      const settings = await withSettings();
      const result = await stopTracking(env, settings);
      await publishHome(env, settings, context.client, nowSec(), result.ok ? null : result.message);
    },
  );

  app.action(
    { type: "button", action_id: ACTION.done },
    async () => {},
    async ({ context, payload }) => {
      const taskId = buttonValue(payload);
      if (!taskId) return;
      const settings = await withSettings();
      const running = await repo.getRunningSession(env.DB);
      if (running?.task_id === taskId) await stopTracking(env, settings);
      await repo.markDone(env.DB, taskId, nowSec());
      await publishHome(env, settings, context.client, nowSec());
    },
  );

  app.action(
    { type: "button", action_id: ACTION.undone },
    async () => {},
    async ({ context, payload }) => {
      const taskId = buttonValue(payload);
      if (!taskId) return;
      await repo.markUndone(env.DB, taskId);
      await publishHome(env, await withSettings(), context.client, nowSec());
    },
  );

  // 「…」にまとめた操作。値は "コマンド:タスクid" の形で入れてある。
  app.action(
    { type: "overflow", action_id: ACTION.more },
    async () => {},
    async ({ context, payload }) => {
      const raw = payload.actions?.[0]?.selected_option?.value ?? "";
      const [command, taskId] = raw.split(":");
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
          return; // "open" はリンクを開くだけなので、ここでは何もしない
      }
      await publishHome(env, await withSettings(), context.client, now);
    },
  );

  app.action(
    { type: "button", action_id: ACTION.sync },
    async () => {},
    async ({ context }) => {
      const settings = await withSettings();
      const now = nowSec();
      let warning: string | null = null;
      try {
        await syncMoodle(env.DB, createMoodleClient(settings), now);
      } catch (e) {
        warning = `同期に失敗しました: ${e instanceof Error ? e.message : String(e)}`;
      }
      await publishHome(env, settings, context.client, now, warning);
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
    await context.client.views.open({ trigger_id: context.triggerId, view: addTaskModal() });
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
      const course = readValue(state, "course");
      const task = manualTask(
        title,
        course,
        parseDue(readValue(state, "due_date"), readValue(state, "due_time")),
        now,
      );
      await repo.insertTaskStmt(env.DB, task).run();
      await publishHome(env, settings, context.client, now);
    },
  );

  return app;
}

function buttonValue(payload: { actions?: { value?: string }[] }): string | null {
  return payload.actions?.[0]?.value ?? null;
}
