import { SlackAPIClient } from "slack-cloudflare-workers";
import { assertEnv, isTogglConfigured, missingConfig, type Env } from "./config";
import * as repo from "./db/repo";
import { MoodleAuthError, createMoodleClient } from "./moodle";
import { runNotifications, sendDigest, notifyTokenExpired } from "./sync/notify";
import { syncMoodle, syncSubmissions } from "./sync/reconcile";
import { createSlackApp } from "./slack/app";
import { publishHome } from "./slack/home";
import { reconcileRunningEntry } from "./toggl/tracking";
import { nowSec } from "./time";

/** wrangler.toml の crons と 1 対 1 で対応させる。 */
const CRON = {
  sync: "*/15 * * * *",
  tracking: "*/5 * * * *",
  digest: "0 22 * * *",
} as const;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      // セットアップ中の自己診断。値は返さず、設定済みかどうかだけを返す。
      const missing = missingConfig(env);
      if (!env.SLACK_SIGNING_SECRET) missing.push("SLACK_SIGNING_SECRET");
      const lastSync = await repo.getStateNumber(env.DB, "last_sync_at");
      return Response.json({
        ok: missing.length === 0,
        moodle_mode: env.MOODLE_MODE,
        missing,
        toggl: isTogglConfigured(env) ? "有効" : "未設定（計測ボタンのみ無効）",
        last_sync_at: lastSync,
        now: nowSec(),
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
    assertEnv(env);
    const now = nowSec();
    const client = new SlackAPIClient(env.SLACK_BOT_TOKEN);

    switch (event.cron) {
      case CRON.sync:
        ctx.waitUntil(runSync(env, client, now));
        return;
      case CRON.tracking:
        ctx.waitUntil(runTrackingSync(env, client, now));
        return;
      case CRON.digest:
        ctx.waitUntil(runDigest(env, client, now));
        return;
      default:
        // 未知の cron は同期として扱っておく（wrangler.toml を触ったときの保険）
        ctx.waitUntil(runSync(env, client, now));
    }
  },
};

/** 15 分ごと: Moodle と突き合わせて、必要なら通知を出す。 */
async function runSync(env: Env, client: SlackAPIClient, now: number): Promise<void> {
  try {
    const moodle = createMoodleClient(env);
    const outcome = await syncMoodle(env.DB, moodle, now);
    await syncSubmissions(env.DB, moodle, now);
    await runNotifications(env, client, now, outcome.inserted);
    await publishHome(env, client, now);
  } catch (e) {
    if (e instanceof MoodleAuthError) {
      await notifyTokenExpired(env, client, now, e.message);
      return;
    }
    // 一時的な失敗は通知しない。次の cron で自然に回復する（§10）。
    console.error("sync failed", e);
  }
}

/** 5 分ごと: Toggl の計測状態を App Home に反映する。 */
async function runTrackingSync(env: Env, client: SlackAPIClient, now: number): Promise<void> {
  try {
    const running = await repo.getRunningSession(env.DB);
    if (!running) return; // 計測していないなら描き直す理由がない
    await reconcileRunningEntry(env);
    await publishHome(env, client, now);
  } catch (e) {
    console.error("tracking sync failed", e);
  }
}

/** 毎朝 7:00 JST: 3 日以内の課題を 1 通にまとめて送る。 */
async function runDigest(env: Env, client: SlackAPIClient, now: number): Promise<void> {
  try {
    await sendDigest(env, client, now);
    await publishHome(env, client, now);
  } catch (e) {
    console.error("digest failed", e);
  }
}
