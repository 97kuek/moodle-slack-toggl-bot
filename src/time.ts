/**
 * 時刻ユーティリティ。
 *
 * 保存はすべて unix 秒 / UTC。表示と「何時か」の判定だけ表示タイムゾーンに変換する。
 * Cloudflare の Cron Trigger も UTC なので、ローカル時刻が出てくるのはこのファイルだけ。
 *
 * オフセットはモジュールに 1 度だけ設定する。1 人 1 デプロイの構成で
 * タイムゾーンはデプロイ単位の定数なので、呼び出し全体に引数を通すより
 * ここで持つほうが素直。エントリポイントの先頭で setTimezoneOffsetMin() を呼ぶ。
 */

/** 日本標準時。設定が無ければこれを使う。 */
export const DEFAULT_TZ_OFFSET_MIN = 540;

const DAY = 24 * 60 * 60;

let tzOffsetSec = DEFAULT_TZ_OFFSET_MIN * 60;

export function setTimezoneOffsetMin(minutes: number): void {
  tzOffsetSec = Math.round(minutes) * 60;
}

export function timezoneOffsetMin(): number {
  return tzOffsetSec / 60;
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 表示タイムゾーンにおけるその日の 00:00 の unix 秒 */
  startOfDay: number;
}

export function local(epochSec: number): LocalParts {
  const shifted = new Date((epochSec + tzOffsetSec) * 1000);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  const hour = shifted.getUTCHours();
  const minute = shifted.getUTCMinutes();
  const startOfDay =
    Math.floor((epochSec + tzOffsetSec) / DAY) * DAY - tzOffsetSec;
  return { year, month, day, hour, minute, startOfDay };
}

/**
 * JST の「今週」の始まり（月曜 00:00）の unix 秒。
 * 週次サマリの集計範囲を出すのに使う。
 */
export function startOfLocalWeek(epochSec: number): number {
  const shifted = new Date((epochSec + tzOffsetSec) * 1000);
  // getUTCDay(): 0=日曜 … 6=土曜。月曜始まりにするため 1 を基準にずらす。
  const daysSinceMonday = (shifted.getUTCDay() + 6) % 7;
  return startOfLocalDay(epochSec) - daysSinceMonday * DAY;
}

/** 表示タイムゾーンでの曜日（0=日曜 … 6=土曜）。 */
export function localWeekday(epochSec: number): number {
  return new Date((epochSec + tzOffsetSec) * 1000).getUTCDay();
}

/** 表示タイムゾーンでの「今日」の 00:00（unix 秒）。 */
export function startOfLocalDay(epochSec: number): number {
  return local(epochSec).startOfDay;
}

/** epoch が表示タイムゾーンでの今日から何日後か（今日=0, 明日=1）。 */
export function localDayOffset(epochSec: number, now: number): number {
  return Math.round((startOfLocalDay(epochSec) - startOfLocalDay(now)) / DAY);
}

/** 静音時間かどうか。 */
export function isQuietHour(epochSec: number, startHour: number, endHour: number): boolean {
  const h = local(epochSec).hour;
  return h >= startHour && h < endHour;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "20:40"。時刻だけを返す。 */
export function formatClock(epochSec: number): string {
  const d = local(epochSec);
  return `${pad(d.hour)}:${pad(d.minute)}`;
}

/** "9/2 17:00"。今日なら "17:00" だけにする。 */
export function formatDue(epochSec: number, now: number): string {
  const d = local(epochSec);
  const offset = localDayOffset(epochSec, now);
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
  const offset = localDayOffset(dueAt, now);
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
