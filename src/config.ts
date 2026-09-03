import type { SlackEdgeAppEnv } from "slack-cloudflare-workers";

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
 * 画面に出さない調整値の既定。
 *
 * 利用者が触る設定は Slack から変更でき、D1 に入る（src/settings.ts）。
 * ここにあるのは、その既定値と、設定画面に出すほどではない内部の上限。
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
  /**
   * 計測中の突き合わせで Toggl に問い合わせる間隔。
   * App Home は毎分描き直すが、手動停止の検知まで毎分やる必要はない。
   */
  trackingCheckIntervalSec: 5 * 60,

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

  /**
   * 分類の既定の選択肢。そのまま Toggl のプロジェクト名になる。
   *
   * **先頭が Moodle 由来のタスクの分類**。科目ごとにプロジェクトを作ると
   * 履修数だけ増えて集計が読めなくなるので、大学の課題は 1 つにまとめる。
   * 利用者はホームタブの「接続設定」から並びも中身も変えられる。
   */
  defaultCategories: ["Waseda", "バイト", "研究", "自習"],
  /** 分類の選択肢の上限（Slack のラジオボタンが縦に伸びすぎない範囲） */
  maxCategories: 8,

  /** 連続日数をさかのぼって数える日数。ここより長い連続は頭打ちになる */
  streakWindowDays: 120,
} as const;

export const SOURCE_BY_MODE = {
  ws: "moodle_ws",
  ical: "moodle_ical",
} as const;
