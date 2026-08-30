/**
 * 時刻ユーティリティ。
 * 保存はすべて unix 秒 / UTC。表示と「何時か」の判定だけ JST に変換する。
 * Cloudflare の Cron Trigger も UTC なので、JST が出てくるのはここだけに閉じ込める。
 */

export const JST_OFFSET_SEC = 9 * 60 * 60;
const DAY = 24 * 60 * 60;

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export interface JstParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** JST におけるその日の 00:00 の unix 秒 */
  startOfDay: number;
}

export function jst(epochSec: number): JstParts {
  const shifted = new Date((epochSec + JST_OFFSET_SEC) * 1000);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  const hour = shifted.getUTCHours();
  const minute = shifted.getUTCMinutes();
  const startOfDay =
    Math.floor((epochSec + JST_OFFSET_SEC) / DAY) * DAY - JST_OFFSET_SEC;
  return { year, month, day, hour, minute, startOfDay };
}

/** JST の「今日」の 00:00（unix 秒）。 */
export function startOfJstDay(epochSec: number): number {
  return jst(epochSec).startOfDay;
}

/** epoch が JST でいう今日から何日後か（今日=0, 明日=1）。 */
export function jstDayOffset(epochSec: number, now: number): number {
  return Math.round((startOfJstDay(epochSec) - startOfJstDay(now)) / DAY);
}

/** 静音時間（JST 0:00–7:00）かどうか。 */
export function isQuietHour(epochSec: number, startHour: number, endHour: number): boolean {
  const h = jst(epochSec).hour;
  return h >= startHour && h < endHour;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "9/2 17:00"。今日なら "17:00" だけにする。 */
export function formatDue(epochSec: number, now: number): string {
  const d = jst(epochSec);
  const offset = jstDayOffset(epochSec, now);
  const time = `${pad(d.hour)}:${pad(d.minute)}`;
  if (offset === 0) return time;
  return `${d.month}/${d.day} ${time}`;
}

/** "4h 12m" / "38m" / "2日" 。 */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s >= 2 * DAY) return `${Math.floor(s / DAY)}日`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${pad(m)}m`;
}

/** "あと 4h 12m" / "3h 超過"。 */
export function formatRemaining(dueAt: number, now: number): string {
  const diff = dueAt - now;
  if (diff < 0) return `${formatDuration(-diff)} 超過`;
  return `あと ${formatDuration(diff)}`;
}

/** 見出し用のグループ名。 */
export function dueGroupLabel(dueAt: number | null, now: number): string {
  if (dueAt === null) return "期限なし";
  const offset = jstDayOffset(dueAt, now);
  if (offset < 0) return "期限超過";
  if (offset === 0) return "今日締切";
  if (offset === 1) return "明日";
  if (offset <= 7) return "今週";
  return "それ以降";
}

export const GROUP_ORDER = ["期限超過", "今日締切", "明日", "今週", "それ以降", "期限なし"] as const;

export function toIso(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}
