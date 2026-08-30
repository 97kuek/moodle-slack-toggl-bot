import type { SlackAPIClient } from "slack-cloudflare-workers";
import type { Env } from "../config";
import * as repo from "../db/repo";
import type { SettingKey } from "../settings";
import { nowSec } from "../time";

/** 設定名の日本語ラベル。保存結果の確認メッセージに使う。 */
const SETTING_LABEL: Record<string, string> = {
  moodle_base_url: "Moodle の URL",
  moodle_mode: "取得方式",
  moodle_token: "Moodle のトークン",
  moodle_ical_url: "Moodle の iCal URL",
  toggl_api_token: "Toggl のトークン",
  toggl_workspace_id: "Toggl のワークスペース ID",
  toggl_organization_id: "Toggl の組織 ID",
  timezone_offset_min: "タイムゾーン",
  digest_hour: "朝のダイジェストの時刻",
  due_tomorrow_hour: "「明日締切」の時刻",
  due_soon_hours: "締切前の最終通知",
  quiet_start_hour: "静音時間の開始",
  quiet_end_hour: "静音時間の終了",
  weekly_summary_weekday: "週次サマリの曜日",
  weekly_summary_hour: "週次サマリの時刻",
  notify_new: "新着通知",
};

/**
 * 保存した内容を DM で返す。
 * 保存しても画面に何も出ないと、成功したのか届いていないのかが分からない。
 * 値そのものは出さず、項目名と長さだけを返す。
 */
export async function reportSaved(
  env: Env,
  client: SlackAPIClient,
  values: Partial<Record<SettingKey, string | null>>,
): Promise<void> {
  const saved = Object.entries(values).filter(([, v]) => typeof v === "string" && v.length > 0);
  const lines = saved.map(([k, v]) => {
    const label = SETTING_LABEL[k] ?? k;
    const secret = k.includes("token") || k.includes("url");
    return `• ${label}${secret ? `（${(v as string).length} 文字）` : `: ${v}`}`;
  });
  await repo.setState(env.DB, "last_settings_saved_at", String(nowSec()));
  await client.chat.postMessage({
    channel: env.SLACK_TARGET_CHANNEL || env.SLACK_USER_ID,
    text: lines.length > 0 ? `設定を更新しました（${saved.length} 件）` : "変更はありませんでした",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            lines.length > 0
              ? `*設定を更新しました*\n${lines.join("\n")}`
              : "*変更はありませんでした*\n入力欄が空だったため、既存の設定はそのままです。",
        },
      },
    ],
  });
}
