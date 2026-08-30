import type { SlackEdgeAppEnv } from "slack-cloudflare-workers";
import { DEFAULT_TZ_OFFSET_MIN } from "./time";

/** wrangler.toml の [vars] と wrangler secret で注入される値。 */
export type Env = SlackEdgeAppEnv & {
  DB: D1Database;

  // Moodle
  MOODLE_BASE_URL: string;
  MOODLE_MODE: "ws" | "ical";
  MOODLE_TOKEN?: string;
  MOODLE_ICAL_URL?: string;
  /** 表示・判定に使うタイムゾーンの UTC からのオフセット（分）。既定は 540（JST） */
  TIMEZONE_OFFSET_MIN?: string;

  // Slack
  SLACK_BOT_TOKEN: string;
  SLACK_USER_ID: string;
  SLACK_TARGET_CHANNEL?: string;

  // Toggl
  TOGGL_API_TOKEN: string;
  TOGGL_WORKSPACE_ID?: string;
  TOGGL_ORGANIZATION_ID?: string;
};

/**
 * 挙動を決める定数。ここを触れば通知の量と同期の重さが変わる。
 */
export const CONFIG = {
  /** 何日先までの課題を取り込むか */
  lookaheadDays: 21,
  /** 期限超過を拾うために何日過去まで遡るか */
  lookbehindDays: 3,
  /** 1 回の同期で扱うタスクの上限（Workers の CPU 10ms / サブリクエスト 50 への保険） */
  maxTasksPerSync: 60,
  /** 1 回の同期で提出状況を問い合わせる件数の上限。続きは次の cron が処理する */
  maxSubmissionChecksPerSync: 8,
  /** 提出状況をチェックする間隔 */
  submissionCheckIntervalSec: 60 * 60,

  /** 締切から何秒後に自動アーカイブするか */
  archiveAfterDueSec: 24 * 60 * 60,
  /** 「あと少し」の閾値 */
  dueSoonSec: 3 * 60 * 60,
  /** この時間以上計測したタスクに「着手済み」を出す */
  startedThresholdSec: 20 * 60,

  /** 静音時間。この間は送信せず朝のダイジェストに合流させる */
  quietStartHour: 0,
  quietEndHour: 7,
  /** 「明日締切」を送る時刻 */
  dueTomorrowHour: 21,

  /** 週次サマリを送る曜日（0=日曜）と時刻 */
  weeklySummaryWeekday: 0,
  weeklySummaryHour: 21,

  /** App Home に出すタスクの上限（view は 100 ブロックまで） */
  maxTasksOnHome: 25,
  /**
   * 1 通の DM にボタン付きで並べるタスクの上限。
   * chat.postMessage は 50 ブロックまでで、1 タスク = 2 ブロック消費する。
   * 溢れた分は件数だけ添えて App Home に誘導する。
   */
  maxTasksPerMessage: 12,

  /** 朝のダイジェストを送る時刻 */
  digestHour: 7,

  /**
   * 定時通知の遅れをどこまで許すか。
   * cron の取りこぼしは拾いたいが、デプロイ直後や長い停止のあとに
   * 「おはようございます」が夜に届くのは誤りなので、窓を切る。
   */
  catchUpWindowSec: 2 * 60 * 60,

  /** App Home の「最近完了したもの」に出す件数（押し間違いの復旧用） */
  maxRecentlyCompletedOnHome: 5,
} as const;

export const SOURCE_BY_MODE = {
  ws: "moodle_ws",
  ical: "moodle_ical",
} as const;

/** 未設定の必須項目を返す。/health の自己診断にも使う。 */
/** 表示タイムゾーンの解決。未設定・不正な値なら JST にフォールバックする。 */
export function resolveTimezoneOffsetMin(env: Env): number {
  const raw = Number(env.TIMEZONE_OFFSET_MIN);
  return Number.isFinite(raw) && Math.abs(raw) <= 14 * 60 ? raw : DEFAULT_TZ_OFFSET_MIN;
}

export function missingConfig(env: Env): string[] {
  const missing: string[] = [];
  if (!env.MOODLE_BASE_URL) missing.push("MOODLE_BASE_URL");
  if (env.MOODLE_MODE === "ws" && !env.MOODLE_TOKEN) missing.push("MOODLE_TOKEN");
  if (env.MOODLE_MODE === "ical" && !env.MOODLE_ICAL_URL) missing.push("MOODLE_ICAL_URL");
  if (!env.SLACK_BOT_TOKEN) missing.push("SLACK_BOT_TOKEN");
  if (!env.SLACK_USER_ID) missing.push("SLACK_USER_ID");
  // TOGGL_API_TOKEN は必須にしない。時間計測が未設定でも
  // Moodle の同期・通知・TODO は動くべきなので、ここで止めない。
  return missing;
}

export function assertEnv(env: Env): void {
  const missing = missingConfig(env);
  if (missing.length > 0) {
    throw new Error(
      `設定が足りません: ${missing.join(", ")} — .dev.vars か wrangler secret put で登録してください`,
    );
  }
}

/** 時間計測が使える状態か。未設定なら Toggl に触れる処理をすべて飛ばす。 */
export function isTogglConfigured(env: Env): boolean {
  return typeof env.TOGGL_API_TOKEN === "string" && env.TOGGL_API_TOKEN.length > 0;
}
