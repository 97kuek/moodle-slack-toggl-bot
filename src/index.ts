import { SlackAPIClient } from "slack-cloudflare-workers";
import { CONFIG, type Env } from "./config";
import * as repo from "./db/repo";
import type { TaskRow } from "./db/types";
import { MoodleAuthError, createMoodleClient } from "./moodle";
import {
  maybeSendDigest,
  maybeSendWeeklySummary,
  notifyTokenExpired,
  runNotifications,
} from "./sync/notify";
import { syncMoodle, syncSubmissions } from "./sync/reconcile";
import {
  isTogglReady,
  loadSettings,
  missingSettings,
  moodleCategory,
  type Settings,
} from "./settings";
import { createSlackApp } from "./slack/app";
import { publishHome } from "./slack/home";
import { reconcileRunningEntry } from "./toggl/tracking";
import { nowSec, setTimezoneOffsetMin } from "./time";

/**
 * wrangler.toml の crons と 1 対 1 で対応させる。
 * ここが食い違うと、想定外の cron がすべて runSync に流れて Moodle を叩き続ける。
 */
const CRON = {
  sync: "*/15 * * * *",
  tracking: "* * * * *",
} as const;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      // セットアップ中の自己診断。値は返さず、設定済みかどうかだけを返す。
      const settings = await loadSettings(env);
      setTimezoneOffsetMin(settings.timezoneOffsetMin);
      const missing = missingSettings(settings);
      if (!env.SLACK_BOT_TOKEN) missing.push("Slack の Bot Token");
      if (!env.SLACK_SIGNING_SECRET) missing.push("Slack の Signing Secret");
      if (!env.SLACK_USER_ID) missing.push("Slack のユーザー ID");
      return Response.json({
        ok: missing.length === 0,
        moodle_mode: settings.moodleMode,
        missing,
        toggl: isTogglReady(settings) ? "有効" : "未設定（計測ボタンのみ無効）",
        timezone_offset_min: settings.timezoneOffsetMin,
        last_sync_at: await repo.getStateNumber(env.DB, "last_sync_at"),
        last_slack_event_at: await repo.getStateNumber(env.DB, "last_slack_event_at"),
        last_settings_saved_at: await repo.getStateNumber(env.DB, "last_settings_saved_at"),
        now: nowSec(),
      });
    }

    // Slack 側が今どう認識しているかを確認するための診断。
    // 表示名を変えたのに反映されない、といった切り分けに使う。追加スコープは不要。
    if (url.pathname === "/whoami") {
      const res = await new SlackAPIClient(env.SLACK_BOT_TOKEN).auth.test();
      return Response.json({
        bot_handle: (res as { user?: string }).user ?? null,
        bot_user_id: (res as { user_id?: string }).user_id ?? null,
        team: (res as { team?: string }).team ?? null,
      });
    }

    // 署名検証ができない状態で Slack を受けると原因が分かりにくいので、先に落とす。
    if (!env.SLACK_SIGNING_SECRET) {
      return new Response(
        "SLACK_SIGNING_SECRET が未設定です。npx wrangler secret put SLACK_SIGNING_SECRET で登録してください。",
        { status: 503 },
      );
    }

    return await createSlackApp(env).run(request, ctx);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Slack に話しかけられない状態では何もしない。
    // Worker を作り直したときなど、シークレット未設定の個体が同じ D1 を触って
    // 通知の権利だけ取って失敗する、という競合を防ぐ。
    if (!env.SLACK_BOT_TOKEN || !env.SLACK_USER_ID) return;

    const settings = await loadSettings(env);
    setTimezoneOffsetMin(settings.timezoneOffsetMin);
    const now = nowSec();
    const client = new SlackAPIClient(env.SLACK_BOT_TOKEN);

    switch (event.cron) {
      case CRON.tracking:
        ctx.waitUntil(runTrackingSync(env, settings, client, now));
        return;
      case CRON.sync:
      default:
        ctx.waitUntil(runSync(env, settings, client, now));
    }
  },
};

/** 15 分ごと: 突き合わせ、必要なら通知、時刻が来ていればダイジェストと週次サマリ。 */
async function runSync(
  env: Env,
  settings: Settings,
  client: SlackAPIClient,
  now: number,
): Promise<void> {
  // Moodle は任意。未設定でも、手で足したタスクの通知とサマリは動かす。
  let newTasks: TaskRow[] = [];
  if (missingSettings(settings).length === 0) {
    try {
      const moodle = createMoodleClient(settings);
      newTasks = (await syncMoodle(env.DB, moodle, now, moodleCategory(settings))).inserted;
      await syncSubmissions(env.DB, moodle, now);
    } catch (e) {
      if (e instanceof MoodleAuthError) {
        await notifyTokenExpired(env, client, now, e.message);
      } else {
        // 一時的な失敗は通知しない。次の cron で自然に回復する。
        console.error("moodle sync failed", e);
      }
    }
  }

  try {
    await runNotifications(env, settings, client, now, newTasks);
    await maybeSendDigest(env, settings, client, now);
    await maybeSendWeeklySummary(env, settings, client, now);
    await publishHome(env, settings, client, now);
  } catch (e) {
    console.error("notify failed", e);
  }
}

/**
 * 毎分: 計測中なら App Home を描き直す。
 *
 * Slack のブロックは静的なので、経過時間は描画した瞬間のスナップショットにしかならない。
 * 5 分ごとだと数字が止まって見えるため、計測中だけ毎分描き直す。
 * 計測していないときは 1 クエリで抜けるので、止まっている間はほぼ何もしない。
 *
 * Toggl への問い合わせ（手動停止の検知）まで毎分やる必要はないので、そこだけ間隔を空ける。
 */
async function runTrackingSync(
  env: Env,
  settings: Settings,
  client: SlackAPIClient,
  now: number,
): Promise<void> {
  try {
    if (!(await repo.getRunningSession(env.DB))) return; // 計測していないなら描き直す理由がない

    const lastCheck = await repo.getStateNumber(env.DB, "last_tracking_check_at");
    if (lastCheck === null || now - lastCheck >= CONFIG.trackingCheckIntervalSec) {
      await repo.setState(env.DB, "last_tracking_check_at", String(now));
      await reconcileRunningEntry(env, settings);
    }

    await publishHome(env, settings, client, now);
  } catch (e) {
    console.error("tracking sync failed", e);
  }
}
