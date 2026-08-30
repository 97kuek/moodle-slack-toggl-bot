import type { Env } from "../config";
import type { MoodleClient } from "./client";
import { ICalMoodleClient } from "./ical";
import { WebServiceMoodleClient } from "./webservice";

/** MOODLE_MODE に応じた実装を返す。呼び出し側は MoodleClient しか知らない。 */
export function createMoodleClient(env: Env): MoodleClient {
  if (env.MOODLE_MODE === "ical") {
    if (!env.MOODLE_ICAL_URL) throw new Error("MOODLE_ICAL_URL が設定されていません");
    const offset = Number(env.MOODLE_ICAL_FALLBACK_TZ_OFFSET_MIN ?? "540");
    return new ICalMoodleClient(
      env.MOODLE_ICAL_URL,
      env.MOODLE_BASE_URL.replace(/\/$/, ""),
      Number.isFinite(offset) ? offset : 540,
    );
  }
  if (!env.MOODLE_TOKEN) throw new Error("MOODLE_TOKEN が設定されていません");
  return new WebServiceMoodleClient(env.MOODLE_BASE_URL.replace(/\/$/, ""), env.MOODLE_TOKEN);
}

export * from "./client";
