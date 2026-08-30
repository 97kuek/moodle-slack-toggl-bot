import { CONFIG, type Env } from "./config";
import { DEFAULT_TZ_OFFSET_MIN } from "./time";

/**
 * 実行時の設定。
 *
 * 解決順は **D1 → 環境変数 → コードの既定値**。
 * Slack から変更したものが D1 に入り、何も入っていなければ従来どおり
 * wrangler secret / vars が使われる。これで既存のデプロイを壊さずに移行できる。
 */
export interface Settings {
  // 接続
  moodleBaseUrl: string;
  moodleMode: "ws" | "ical";
  moodleToken: string | null;
  moodleIcalUrl: string | null;
  togglApiToken: string | null;
  togglWorkspaceId: string | null;
  togglOrganizationId: string | null;

  // 通知
  timezoneOffsetMin: number;
  digestHour: number;
  dueTomorrowHour: number;
  dueSoonHours: number;
  quietStartHour: number;
  quietEndHour: number;
  weeklySummaryWeekday: number;
  weeklySummaryHour: number;
  notifyNew: boolean;
}

/** Slack の設定画面から書き換えられるキー。 */
export const SETTING_KEYS = [
  "moodle_base_url",
  "moodle_mode",
  "moodle_token",
  "moodle_ical_url",
  "toggl_api_token",
  "toggl_workspace_id",
  "toggl_organization_id",
  "timezone_offset_min",
  "digest_hour",
  "due_tomorrow_hour",
  "due_soon_hours",
  "quiet_start_hour",
  "quiet_end_hour",
  "weekly_summary_weekday",
  "weekly_summary_hour",
  "notify_new",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

export async function loadStoredSettings(db: D1Database): Promise<Map<string, string>> {
  const res = await db.prepare(`SELECT key, value FROM settings`).all<{ key: string; value: string }>();
  return new Map((res.results ?? []).map((r) => [r.key, r.value]));
}

export async function saveSettings(
  db: D1Database,
  values: Partial<Record<SettingKey, string | null>>,
  now: number,
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined || value === "") {
      // 空欄は「変更しない」。消したいときは明示的に delete する。
      continue;
    }
    statements.push(
      db
        .prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
           ON CONFLICT (key) DO UPDATE SET value = ?2, updated_at = ?3`,
        )
        .bind(key, value, now),
    );
  }
  if (statements.length > 0) await db.batch(statements);
}

export async function deleteSetting(db: D1Database, key: SettingKey): Promise<void> {
  await db.prepare(`DELETE FROM settings WHERE key = ?1`).bind(key).run();
}

function str(
  stored: Map<string, string>,
  key: SettingKey,
  fromEnv: string | undefined,
): string | null {
  const v = stored.get(key) ?? fromEnv;
  return v && v.length > 0 ? v : null;
}

function num(
  stored: Map<string, string>,
  key: SettingKey,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = Number(stored.get(key));
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.round(raw)));
}

export function resolveSettings(env: Env, stored: Map<string, string>): Settings {
  const mode = stored.get("moodle_mode") ?? env.MOODLE_MODE;
  return {
    moodleBaseUrl: (str(stored, "moodle_base_url", env.MOODLE_BASE_URL) ?? "").replace(/\/$/, ""),
    moodleMode: mode === "ws" ? "ws" : "ical",
    moodleToken: str(stored, "moodle_token", env.MOODLE_TOKEN),
    moodleIcalUrl: str(stored, "moodle_ical_url", env.MOODLE_ICAL_URL),
    togglApiToken: str(stored, "toggl_api_token", env.TOGGL_API_TOKEN),
    togglWorkspaceId: str(stored, "toggl_workspace_id", env.TOGGL_WORKSPACE_ID),
    togglOrganizationId: str(stored, "toggl_organization_id", env.TOGGL_ORGANIZATION_ID),

    timezoneOffsetMin: num(
      stored,
      "timezone_offset_min",
      Number(env.TIMEZONE_OFFSET_MIN) || DEFAULT_TZ_OFFSET_MIN,
      -14 * 60,
      14 * 60,
    ),
    digestHour: num(stored, "digest_hour", CONFIG.digestHour, 0, 23),
    dueTomorrowHour: num(stored, "due_tomorrow_hour", CONFIG.dueTomorrowHour, 0, 23),
    dueSoonHours: num(stored, "due_soon_hours", CONFIG.dueSoonSec / 3600, 1, 48),
    quietStartHour: num(stored, "quiet_start_hour", CONFIG.quietStartHour, 0, 23),
    quietEndHour: num(stored, "quiet_end_hour", CONFIG.quietEndHour, 0, 23),
    weeklySummaryWeekday: num(stored, "weekly_summary_weekday", CONFIG.weeklySummaryWeekday, 0, 6),
    weeklySummaryHour: num(stored, "weekly_summary_hour", CONFIG.weeklySummaryHour, 0, 23),
    notifyNew: (stored.get("notify_new") ?? "1") !== "0",
  };
}

/**
 * 環境変数にしか無い設定を D1 に取り込む。
 *
 * 設定を Slack から変更できるようにする前のデプロイは、値を wrangler secret /
 * vars に持っている。それを一度だけ D1 に写しておくと、以降は Slack 側が
 * 唯一の設定場所になり、Worker を作り直しても設定が付いてくる。
 * 既に D1 にある値は上書きしない（Slack で変えたものが正）。
 */
export async function seedSettingsFromEnv(
  db: D1Database,
  env: Env,
  stored: Map<string, string>,
  now: number,
): Promise<Map<string, string>> {
  const fromEnv: [SettingKey, string | undefined][] = [
    ["moodle_base_url", env.MOODLE_BASE_URL],
    ["moodle_mode", env.MOODLE_MODE],
    ["moodle_token", env.MOODLE_TOKEN],
    ["moodle_ical_url", env.MOODLE_ICAL_URL],
    ["toggl_api_token", env.TOGGL_API_TOKEN],
    ["toggl_workspace_id", env.TOGGL_WORKSPACE_ID],
    ["toggl_organization_id", env.TOGGL_ORGANIZATION_ID],
    ["timezone_offset_min", env.TIMEZONE_OFFSET_MIN],
  ];

  const pending = fromEnv.filter(
    ([key, value]) => typeof value === "string" && value.length > 0 && !stored.has(key),
  ) as [SettingKey, string][];
  if (pending.length === 0) return stored;

  await db.batch(
    pending.map(([key, value]) =>
      db
        .prepare(`INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)`)
        .bind(key, value, now),
    ),
  );
  for (const [key, value] of pending) stored.set(key, value);
  return stored;
}

export async function loadSettings(env: Env): Promise<Settings> {
  const stored = await seedSettingsFromEnv(
    env.DB,
    env,
    await loadStoredSettings(env.DB),
    Math.floor(Date.now() / 1000),
  );
  return resolveSettings(env, stored);
}

/** 動かすのに足りていないもの。Slack の設定画面と /health の両方で使う。 */
export function missingSettings(s: Settings): string[] {
  const missing: string[] = [];
  if (!s.moodleBaseUrl) missing.push("Moodle の URL");
  if (s.moodleMode === "ws" && !s.moodleToken) missing.push("Moodle のトークン");
  if (s.moodleMode === "ical" && !s.moodleIcalUrl) missing.push("Moodle の iCal URL");
  return missing;
}

export function isTogglReady(s: Settings): boolean {
  if (!s.togglApiToken) return false;
  // Toggl 2.0 は organization_id を返す API が無いため、設定が要る。
  if (s.togglApiToken.startsWith("toggl_sk_") && !s.togglOrganizationId) return false;
  return true;
}
