import { SlackApp } from "slack-cloudflare-workers";
import type { Env } from "../config";
import * as repo from "../db/repo";
import { createMoodleClient } from "../moodle";
import { syncMoodle } from "../sync/reconcile";
import { startTracking, stopTracking } from "../toggl/tracking";
import { nowSec, startOfLocalDay } from "../time";
import { ACTION } from "./blocks";
import { publishHome } from "./home";

/**
 * Slack からの操作を受けるハンドラ群。
 *
 * ack は 3 秒以内に返す必要があるため、実処理はすべて lazy 側で行う
 * （slack-cloudflare-workers が ack 後に走らせてくれる）。
 */
export const SLACK_EVENTS_PATH = "/slack/events";

export function createSlackApp(env: Env): SlackApp<Env> {
  // Slack アプリ側の Request URL はこのパスに合わせる。
  const app = new SlackApp({ env, routes: { events: SLACK_EVENTS_PATH } });

  app.event("app_home_opened", async ({ context }) => {
    await publishHome(env, context.client, nowSec());
  });

  app.action(
    { type: "button", action_id: ACTION.start },
    async () => {},
    async ({ context, payload }) => {
      const taskId = buttonValue(payload);
      if (!taskId) return;
      const result = await startTracking(env, taskId);
      await publishHome(env, context.client, nowSec(), result.ok ? null : result.message);
    },
  );

  app.action(
    { type: "button", action_id: ACTION.stop },
    async () => {},
    async ({ context }) => {
      const result = await stopTracking(env);
      await publishHome(env, context.client, nowSec(), result.ok ? null : result.message);
    },
  );

  app.action(
    { type: "button", action_id: ACTION.done },
    async () => {},
    async ({ context, payload }) => {
      const taskId = buttonValue(payload);
      if (!taskId) return;
      const running = await repo.getRunningSession(env.DB);
      if (running?.task_id === taskId) await stopTracking(env);
      await repo.markDone(env.DB, taskId, nowSec());
      await publishHome(env, context.client, nowSec());
    },
  );

  app.action(
    { type: "button", action_id: ACTION.undone },
    async () => {},
    async ({ context, payload }) => {
      const taskId = buttonValue(payload);
      if (!taskId) return;
      await repo.markUndone(env.DB, taskId);
      await publishHome(env, context.client, nowSec());
    },
  );

  app.action(
    { type: "button", action_id: ACTION.snooze },
    async () => {},
    async ({ context, payload }) => {
      const taskId = buttonValue(payload);
      if (!taskId) return;
      const now = nowSec();
      await repo.snoozeTask(env.DB, taskId, snoozeUntilTomorrowMorning(now));
      await publishHome(env, context.client, now);
    },
  );

  app.action(
    { type: "button", action_id: ACTION.sync },
    async () => {},
    async ({ context }) => {
      const now = nowSec();
      let warning: string | null = null;
      try {
        await syncMoodle(env.DB, createMoodleClient(env), now);
      } catch (e) {
        warning = `同期に失敗しました: ${e instanceof Error ? e.message : String(e)}`;
      }
      await publishHome(env, context.client, now, warning);
    },
  );

  // URL 付きボタン（Moodle を開く）にも block_actions が飛んでくるので、ack だけ返す。
  app.action(/^open_moodle_/, async () => {});

  return app;
}

function buttonValue(payload: { actions?: { value?: string }[] }): string | null {
  return payload.actions?.[0]?.value ?? null;
}

/** 「😴 明日」= 翌日 9:00 JST まで黙る。 */
export function snoozeUntilTomorrowMorning(now: number): number {
  return startOfLocalDay(now) + 24 * 60 * 60 + 9 * 60 * 60;
}
