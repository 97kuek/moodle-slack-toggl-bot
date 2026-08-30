import type { AnyModalBlock, ModalView } from "slack-cloudflare-workers";
import type { Settings } from "../settings";

/**
 * 設定とタスク追加のモーダル。
 *
 * 認証情報の入力欄は空欄を「変更しない」として扱う（Slack の input は伏字にできないため、
 * 既存の値を初期表示すると画面共有などで漏れる）。消したいときは値を消すのではなく
 * 別の値を入れ直す運用にしている。
 */

export const CALLBACK = {
  connection: "settings_connection",
  notification: "settings_notification",
  addTask: "add_task",
} as const;

function text(
  blockId: string,
  label: string,
  opts: {
    initial?: string | null;
    placeholder?: string;
    hint?: string;
    optional?: boolean;
    multiline?: boolean;
  } = {},
): AnyModalBlock {
  return {
    type: "input",
    block_id: blockId,
    optional: opts.optional ?? false,
    label: { type: "plain_text", text: label, emoji: true },
    ...(opts.hint ? { hint: { type: "plain_text" as const, text: opts.hint, emoji: true } } : {}),
    element: {
      type: "plain_text_input",
      action_id: "value",
      ...(opts.initial ? { initial_value: opts.initial } : {}),
      ...(opts.placeholder
        ? { placeholder: { type: "plain_text" as const, text: opts.placeholder, emoji: true } }
        : {}),
      ...(opts.multiline ? { multiline: true } : {}),
    },
  };
}

function select(
  blockId: string,
  label: string,
  options: { text: string; value: string }[],
  initial: string,
  hint?: string,
): AnyModalBlock {
  const opts = options.map((o) => ({
    text: { type: "plain_text" as const, text: o.text, emoji: true },
    value: o.value,
  }));
  const initialOption = opts.find((o) => o.value === initial) ?? opts[0];
  return {
    type: "input",
    block_id: blockId,
    label: { type: "plain_text", text: label, emoji: true },
    ...(hint ? { hint: { type: "plain_text" as const, text: hint, emoji: true } } : {}),
    element: {
      type: "static_select",
      action_id: "value",
      options: opts,
      ...(initialOption ? { initial_option: initialOption } : {}),
    },
  };
}

const HOURS = Array.from({ length: 24 }, (_, h) => ({ text: `${h}:00`, value: String(h) }));
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"].map((d, i) => ({
  text: `${d}曜日`,
  value: String(i),
}));

const NOTIFY_NEW_OPTION = {
  text: { type: "plain_text" as const, text: "検出したらすぐ通知する", emoji: true },
  value: "1",
};

function header(text: string): AnyModalBlock {
  return { type: "header", text: { type: "plain_text", text, emoji: true } };
}

function note(text: string): AnyModalBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

/**
 * 接続設定。
 *
 * 入力欄はできるだけ減らしてある。
 *   - 取得方式は選ばせず、入力された値が URL かトークンかで判別する
 *   - Toggl の組織 ID は数字を探させず、ブラウザの URL をそのまま貼れるようにする
 *   - ワークスペース ID は API から取れるので画面に出さない
 */
export function connectionModal(s: Settings): ModalView {
  const set = (v: string | null) => (v ? "設定済み" : "未設定");

  const blocks: AnyModalBlock[] = [
    header("Moodle"),
    note("課題を自動で取り込みます。使わない場合は空のままで構いません。"),
    text("moodle_base_url", "Moodle の URL", {
      optional: true,
      initial: s.moodleBaseUrl,
      placeholder: "https://moodle.example.ac.jp",
    }),
    text("moodle_credential", "iCal の URL、またはトークン", {
      optional: true,
      placeholder: `${set(s.moodleIcalUrl ?? s.moodleToken)}（変更する場合のみ入力）`,
      hint: "https… なら iCal、それ以外はトークンとして扱います",
    }),

    { type: "divider" },
    header("Toggl"),
    note("時間計測に使います。未設定でも通知とタスク管理は動きます。"),
    text("toggl_api_token", "API トークン", {
      optional: true,
      placeholder: `${set(s.togglApiToken)}（変更する場合のみ入力）`,
      hint: "track.toggl.com のプロフィール設定の最下部",
    }),
    text("toggl_org", "Toggl の URL", {
      optional: true,
      initial: s.togglOrganizationId,
      placeholder: "focus.toggl.com/12345678/workspaces/…",
      hint: "toggl_sk_ で始まるトークンのときだけ必要。URL をそのまま貼れば大丈夫です",
    }),
  ];

  return {
    type: "modal",
    callback_id: CALLBACK.connection,
    title: { type: "plain_text", text: "接続設定", emoji: true },
    submit: { type: "plain_text", text: "保存", emoji: true },
    close: { type: "plain_text", text: "閉じる", emoji: true },
    blocks,
  };
}

/** 通知設定。項目を意味の塊に分けて、それぞれ何のための設定かを添える。 */
export function notificationModal(s: Settings): ModalView {
  const blocks: AnyModalBlock[] = [
    text("timezone_offset_min", "タイムゾーン（UTC からの分）", {
      initial: String(s.timezoneOffsetMin),
      hint: "540 = 日本。以下の時刻はすべてこれを基準にします",
    }),

    { type: "divider" },
    header("締切のリマインド"),
    {
      type: "input",
      block_id: "notify_new",
      optional: true,
      label: { type: "plain_text", text: "新しい課題", emoji: true },
      element: {
        type: "checkboxes",
        action_id: "value",
        options: [NOTIFY_NEW_OPTION],
        ...(s.notifyNew ? { initial_options: [NOTIFY_NEW_OPTION] } : {}),
      },
    },
    select("due_tomorrow_hour", "前日に知らせる時刻", HOURS, String(s.dueTomorrowHour)),
    text("due_soon_hours", "締切の何時間前に最終通知するか", {
      initial: String(s.dueSoonHours),
      hint: "1〜48。これだけはスヌーズ中でも届きます",
    }),

    { type: "divider" },
    header("まとめて届くもの"),
    select("digest_hour", "朝のダイジェスト", HOURS, String(s.digestHour), "3日以内の締切を 1 通にまとめます"),
    select("weekly_summary_weekday", "週次サマリの曜日", WEEKDAYS, String(s.weeklySummaryWeekday)),
    select("weekly_summary_hour", "週次サマリの時刻", HOURS, String(s.weeklySummaryHour), "分類別の学習時間・完了したタスク・来週の締切"),

    { type: "divider" },
    header("静かにする時間"),
    select("quiet_start_hour", "開始", HOURS, String(s.quietStartHour)),
    select("quiet_end_hour", "終了", HOURS, String(s.quietEndHour), "この間の通知は朝のダイジェストに合流します"),
  ];

  return {
    type: "modal",
    callback_id: CALLBACK.notification,
    title: { type: "plain_text", text: "通知設定", emoji: true },
    submit: { type: "plain_text", text: "保存", emoji: true },
    close: { type: "plain_text", text: "閉じる", emoji: true },
    blocks,
  };
}

export function addTaskModal(): ModalView {
  return {
    type: "modal",
    callback_id: CALLBACK.addTask,
    title: { type: "plain_text", text: "タスクを追加", emoji: true },
    submit: { type: "plain_text", text: "追加", emoji: true },
    close: { type: "plain_text", text: "閉じる", emoji: true },
    blocks: [
      text("title", "やること", { placeholder: "レポートの下書き" }),
      text("course", "分類", {
        optional: true,
        placeholder: "バイト / 研究 / 自習 など",
        hint: "Toggl のプロジェクト名になる",
      }),
      {
        type: "input",
        block_id: "due_date",
        optional: true,
        label: { type: "plain_text", text: "締切の日付", emoji: true },
        element: { type: "datepicker", action_id: "value" },
      },
      {
        type: "input",
        block_id: "due_time",
        optional: true,
        label: { type: "plain_text", text: "締切の時刻", emoji: true },
        hint: { type: "plain_text", text: "日付だけ指定した場合は 23:59 として扱う", emoji: true },
        element: { type: "timepicker", action_id: "value" },
      },
    ],
  };
}

/** view_submission の値を取り出す。未入力は null。 */
export function readValue(
  state: { values: Record<string, Record<string, unknown>> },
  blockId: string,
): string | null {
  const el = state.values[blockId]?.["value"] as
    | {
        value?: string | null;
        selected_option?: { value?: string } | null;
        selected_options?: { value?: string }[];
        selected_date?: string | null;
        selected_time?: string | null;
      }
    | undefined;
  if (!el) return null;
  if (typeof el.value === "string" && el.value.length > 0) return el.value.trim();
  if (el.selected_option?.value) return el.selected_option.value;
  if (el.selected_options) return el.selected_options.length > 0 ? "1" : "0";
  if (el.selected_date) return el.selected_date;
  if (el.selected_time) return el.selected_time;
  return null;
}
