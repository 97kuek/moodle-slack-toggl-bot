import { CONFIG } from "../config";
import { nowSec } from "../time";
import {
  MoodleAuthError,
  MoodleError,
  type MoodleClient,
  type RawMoodleTask,
  type SubmissionStatus,
} from "./client";
import type { TaskKind } from "../db/types";

interface MoodleErrorResponse {
  exception?: string;
  errorcode?: string;
  message?: string;
}

interface ActionEvent {
  id: number;
  name: string;
  timestart: number;
  timeduration?: number;
  modulename?: string | null;
  instance?: number | null;
  url?: string | null;
  viewurl?: string | null;
  action?: { url?: string | null } | null;
  course?: { id?: number; shortname?: string; fullname?: string } | null;
}

interface UserCourse {
  id: number;
  shortname?: string;
  fullname?: string;
}

interface SubmissionStatusResponse {
  lastattempt?: {
    submission?: { status?: string; timemodified?: number } | null;
    teamsubmission?: { status?: string; timemodified?: number } | null;
  } | null;
}

const AUTH_ERROR_CODES = new Set([
  "invalidtoken",
  "accessexception",
  "invalidparameter",
  "servicenotavailable",
  "enrolmentrequired",
]);

/**
 * Moodle Web Services (REST) 版。提出状況まで取得できる本命ルート。
 * 大学が Web Services を無効にしている / SSO でトークンが取れない場合は ICalMoodleClient を使う。
 */
export class WebServiceMoodleClient implements MoodleClient {
  readonly source = "moodle_ws";
  private courseNames: Map<string, string> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async call<T>(wsfunction: string, params: Record<string, string | number>): Promise<T> {
    const body = new URLSearchParams({
      wstoken: this.token,
      wsfunction,
      moodlewsrestformat: "json",
    });
    for (const [k, v] of Object.entries(params)) body.set(k, String(v));

    const res = await fetch(`${this.baseUrl}/webservice/rest/server.php`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      throw new MoodleError(`Moodle が HTTP ${res.status} を返しました (${wsfunction})`);
    }

    const json = (await res.json()) as T & MoodleErrorResponse;
    if (json && typeof json === "object" && "exception" in json && json.exception) {
      const code = json.errorcode ?? "";
      const message = json.message ?? json.exception ?? "unknown";
      if (AUTH_ERROR_CODES.has(code)) {
        throw new MoodleAuthError(`${message} (errorcode: ${code})`);
      }
      throw new MoodleError(`${message} (errorcode: ${code}, function: ${wsfunction})`);
    }
    return json;
  }

  /** 科目 id → 表示名。shortname を優先する（Toggl のプロジェクト名になるため）。 */
  private async loadCourseNames(): Promise<Map<string, string>> {
    if (this.courseNames) return this.courseNames;
    const map = new Map<string, string>();
    try {
      const siteInfo = await this.call<{ userid?: number }>("core_webservice_get_site_info", {});
      if (siteInfo.userid) {
        const courses = await this.call<UserCourse[]>("core_enrol_get_users_courses", {
          userid: siteInfo.userid,
        });
        for (const c of courses ?? []) {
          const name = c.shortname || c.fullname;
          if (name) map.set(String(c.id), name);
        }
      }
    } catch (e) {
      // 科目名はイベント側にも入っているので、ここで失敗しても同期は続行する。
      if (e instanceof MoodleAuthError) throw e;
    }
    this.courseNames = map;
    return map;
  }

  async fetchUpcoming(): Promise<RawMoodleTask[]> {
    const now = nowSec();
    const courseNames = await this.loadCourseNames();

    const res = await this.call<{ events?: ActionEvent[] }>(
      "core_calendar_get_action_events_by_timesort",
      {
        timesortfrom: now - CONFIG.lookbehindDays * 86400,
        timesortto: now + CONFIG.lookaheadDays * 86400,
        limitnum: CONFIG.maxTasksPerSync,
      },
    );

    return (res.events ?? []).map((ev) => {
      const courseId = ev.course?.id != null ? String(ev.course.id) : null;
      const courseName =
        (courseId ? courseNames.get(courseId) : null) ??
        ev.course?.shortname ??
        ev.course?.fullname ??
        null;
      return {
        sourceId: String(ev.id),
        courseId,
        courseName,
        title: ev.name,
        kind: toKind(ev.modulename),
        url: ev.action?.url ?? ev.viewurl ?? ev.url ?? null,
        instanceId: ev.modulename === "assign" && ev.instance != null ? ev.instance : null,
        dueAt: ev.timestart > 0 ? ev.timestart : null,
      } satisfies RawMoodleTask;
    });
  }

  /**
   * 提出済みかどうかを問い合わせる。1 件 1 リクエストなので、
   * 呼び出し側で件数を絞ること（Workers のサブリクエスト上限は 50）。
   */
  async fetchSubmissionStatus(
    tasks: { sourceId: string; instanceId: number }[],
  ): Promise<SubmissionStatus[]> {
    const out: SubmissionStatus[] = [];
    for (const t of tasks) {
      try {
        const res = await this.call<SubmissionStatusResponse>("mod_assign_get_submission_status", {
          assignid: t.instanceId,
        });
        const sub = res.lastattempt?.submission ?? res.lastattempt?.teamsubmission ?? null;
        const submitted = sub?.status === "submitted";
        out.push({
          sourceId: t.sourceId,
          submitted,
          submittedAt: submitted ? (sub?.timemodified ?? nowSec()) : null,
        });
      } catch (e) {
        if (e instanceof MoodleAuthError) throw e;
        // 個々の課題で失敗しても他の判定は続ける
      }
    }
    return out;
  }
}

function toKind(modulename: string | null | undefined): TaskKind {
  if (modulename === "assign") return "assign";
  if (modulename === "quiz") return "quiz";
  return "event";
}
