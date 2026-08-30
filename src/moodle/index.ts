import type { Settings } from "../settings";
import type { MoodleClient } from "./client";
import { ICalMoodleClient } from "./ical";
import { WebServiceMoodleClient } from "./webservice";

/** 設定に応じた実装を返す。呼び出し側は MoodleClient しか知らない。 */
export function createMoodleClient(settings: Settings): MoodleClient {
  if (settings.moodleMode === "ical") {
    if (!settings.moodleIcalUrl) throw new Error("Moodle の iCal URL が未設定です");
    return new ICalMoodleClient(
      settings.moodleIcalUrl,
      settings.moodleBaseUrl,
      settings.timezoneOffsetMin,
    );
  }
  if (!settings.moodleToken) throw new Error("Moodle のトークンが未設定です");
  return new WebServiceMoodleClient(settings.moodleBaseUrl, settings.moodleToken);
}

export * from "./client";
