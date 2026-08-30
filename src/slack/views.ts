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

export function connectionModal(s: Settings): ModalView {
  const blocks: AnyModalBlock[] = [
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "トークンなどの欄は*空のままにすると変更されません*。変えたいときだけ入力してください。",
        },
      ],
    },
    text("moodle_base_url", "Moodle の URL", {
      initial: s.moodleBaseUrl,
      placeholder: "https://moodle.example.ac.jp",
      hint: "末尾のスラッシュは不要",
    }),
    select(
      "moodle_mode",
      "取得方式",
      [
        { text: "iCal（カレンダーエクスポート）", value: "ical" },
        { text: "Web Services（提出済みの自動判定つき）", value: "ws" },
      ],
      s.moodleMode,
      "SSO でトークンが取れない場合は iCal を選ぶ",
    ),
    text("moodle_ical_url", "Moodle の iCal URL", {
      optional: true,
      placeholder: s.moodleIcalUrl ? "設定済み（変更する場合のみ入力）" : "未設定",
      hint: "Moodle のカレンダー →「カレンダーをエクスポートする」で発行",
    }),
    text("moodle_token", "Moodle の Web Services トークン", {
      optional: true,
      placeholder: s.moodleToken ? "設定済み（変更する場合のみ入力）" : "未設定",
      hint: "ブラウザでログイン → /user/managetoken.php",
    }),
    { type: "divider" },
    text("toggl_api_token", "Toggl の API トークン", {
      optional: true,
      placeholder: s.togglApiToken ? "設定済み（変更する場合のみ入力）" : "未設定",
      hint: "https://track.toggl.com/profile の最下部。未設定でも通知と TODO は動く",
    }),
    text("toggl_organization_id", "Toggl の組織 ID", {
      optional: true,
      initial: s.togglOrganizationId,
      hint: "Toggl 2.0（toggl_sk_ で始まるトークン）の場合のみ必要。ブラウザの URL に含まれる数字",
    }),
    text("toggl_workspace_id", "Toggl のワークスペース ID", {
      optional: true,
      initial: s.togglWorkspaceId,
      hint: "空なら既定のワークスペースを自動で使う",
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

export function notificationModal(s: Settings): ModalView {
  const blocks: AnyModalBlock[] = [
    text("timezone_offset_min", "タイムゾーン（UTC からの分）", {
      initial: String(s.timezoneOffsetMin),
      hint: "540 = 日本。表示と通知時刻の判定に使う",
    }),
    { type: "divider" },
    {
      type: "input",
      block_id: "notify_new",
      optional: true,
      label: { type: "plain_text", text: "新しい課題", emoji: true },
      element: {
        type: "checkboxes",
        action_id: "value",
        options: [
          {
            text: { type: "plain_text", text: "検出したらすぐ通知する", emoji: true },
            value: "1",
          },
        ],
        ...(s.notifyNew
          ? {
              initial_options: [
                {
                  text: { type: "plain_text" as const, text: "検出したらすぐ通知する", emoji: true },
                  value: "1",
                },
              ],
            }
          : {}),
      },
    },
    select("due_tomorrow_hour", "「明日締切」を送る時刻", HOURS, String(s.dueTomorrowHour)),
    text("due_soon_hours", "締切の何時間前に最終通知するか", {
      initial: String(s.dueSoonHours),
      hint: "1〜48 の数字",
    }),
    { type: "divider" },
    select("digest_hour", "朝のダイジェストの時刻", HOURS, String(s.digestHour)),
    select("weekly_summary_weekday", "週次サマリの曜日", WEEKDAYS, String(s.weeklySummaryWeekday)),
    select("weekly_summary_hour", "週次サマリの時刻", HOURS, String(s.weeklySummaryHour)),
    { type: "divider" },
    select("quiet_start_hour", "静音時間の開始", HOURS, String(s.quietStartHour)),
    select("quiet_end_hour", "静音時間の終了", HOURS, String(s.quietEndHour), "この間の通知は朝のダイジェストに合流する"),
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
