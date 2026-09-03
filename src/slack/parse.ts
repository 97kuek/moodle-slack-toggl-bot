import * as repo from "../db/repo";
import type { TaskRow } from "../db/types";
import type { SettingKey } from "../settings";
import { startOfLocalDay, timezoneOffsetMin } from "../time";

/**
 * Slack の入力を、保存できる形に変換する処理をまとめたもの。
 * すべて純粋関数なので、ハンドラ本体から切り離してある。
 */

/**
 * Moodle の認証情報を、入力された文字列の形で振り分ける。
 * 利用者に「Web Services か iCal か」を選ばせないための処理。
 */
export function splitMoodleCredential(
  raw: string | null,
): Partial<Record<SettingKey, string | null>> {
  if (!raw) return {};
  return /^https?:\/\//i.test(raw)
    ? { moodle_ical_url: raw, moodle_mode: "ical" }
    : { moodle_token: raw, moodle_mode: "ws" };
}

/**
 * Toggl の組織 ID。ブラウザの URL をそのまま貼れるようにしてある。
 *   focus.toggl.com/21637182/workspaces/21636419/... → 21637182
 * 数字だけを入力された場合はそのまま使う。
 */
export function parseOrganizationId(raw: string | null): string | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return raw;
  const m = /toggl\.com\/(\d+)/.exec(raw) ?? /\/(\d+)(?:\/|$)/.exec(raw);
  return m?.[1] ?? null;
}

/** 「明日まで通知しない」= 翌日 9:00 まで黙る。 */
export function snoozeUntilTomorrowMorning(now: number): number {
  return startOfLocalDay(now) + 24 * 60 * 60 + 9 * 60 * 60;
}

/**
 * datepicker と timepicker の組みを unix 秒にする。
 * 日付だけ指定された場合は 23:59 として扱う（締切は日の終わりであることが多い）。
 */
export function parseDue(date: string | null, time: string | null): number | null {
  if (!date) return null;
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return null;
  const [hh, mm] = (time ?? "23:59").split(":").map(Number);
  const utcMs = Date.UTC(y, m - 1, d, hh ?? 23, mm ?? 59, 0);
  // ピッカーが返すのはローカル時刻なので、オフセットを引いて UTC に直す
  return Math.floor(utcMs / 1000) - timezoneOffsetMin() * 60;
}

/** Slack から手で足したタスク。Moodle 同期の対象外になるよう source を分ける。 */
export function manualTask(
  title: string,
  category: string | null,
  dueAt: number | null,
  now: number,
): TaskRow {
  return {
    id: repo.newId(),
    source: "manual",
    source_id: repo.newId(),
    course_id: null,
    course_name: null,
    category,
    title,
    kind: "event",
    url: null,
    instance_id: null,
    due_at: dueAt,
    submitted_at: null,
    status: "open",
    snooze_until: null,
    tracked_sec: 0,
    completed_at: null,
    submission_checked_at: null,
    first_seen_at: now,
    last_seen_at: now,
  };
}
