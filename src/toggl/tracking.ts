import type { Env } from "../config";
import * as repo from "../db/repo";
import type { TaskRow } from "../db/types";
import type { Settings } from "../settings";
import { nowSec } from "../time";
import { createTracker } from "./index";
import {
  TrackerAuthError,
  TrackerError,
  TrackerRateLimitError,
  type TimeTracker,
} from "./tracker";

/**
 * Slack のボタンと時間計測サービスの間の橋渡し。
 * 操作は必ず Slack 起点（片方向）で、計測側 → Slack は表示の同期だけ。
 */

export interface TrackingResult {
  ok: boolean;
  message: string;
}

const NOT_CONFIGURED =
  "Toggl のトークンが未設定です。ホームタブの「接続設定」から登録すると計測できるようになります。";

const AUTH_FAILED =
  "Toggl のトークンが無効か、有効期限が切れています。プロフィール設定で発行し直して、「接続設定」に貼り直してください。";

/** 未設定・設定不足を 1 か所で判定する。 */
function resolveTracker(settings: Settings): { tracker: TimeTracker | null; message: string } {
  const tracker = createTracker(settings);
  if (!tracker) return { tracker: null, message: NOT_CONFIGURED };
  const missing = tracker.missing();
  if (missing.length > 0) {
    return {
      tracker: null,
      message: `${missing.join("・")}が未設定です。ホームタブの「接続設定」から登録してください。`,
    };
  }
  return { tracker, message: "" };
}

/** 分類に対応するプロジェクトを引く。無ければ作って覚える。 */
async function resolveProjectId(
  env: Env,
  tracker: TimeTracker,
  task: TaskRow,
): Promise<string | null> {
  if (!task.course_id || !task.course_name) return null;
  const mapped = await repo.listCourseProjects(env.DB);
  const hit = mapped.find((m) => m.course_id === task.course_id);
  if (hit) return String(hit.toggl_project_id);

  const projectId = await tracker.findOrCreateProject(task.course_name);
  if (projectId !== null) {
    await repo.putCourseProject(env.DB, task.course_id, task.course_name, projectId);
  }
  return projectId;
}

export async function startTracking(
  env: Env,
  settings: Settings,
  taskId: string,
): Promise<TrackingResult> {
  const { tracker, message } = resolveTracker(settings);
  if (!tracker) return { ok: false, message };

  const now = nowSec();
  const task = await repo.getTask(env.DB, taskId);
  if (!task) return { ok: false, message: "タスクが見つかりませんでした" };

  // 走っているものがあれば先に閉じる（計測側も 1 本しか走らせない）
  await stopTracking(env, settings);

  try {
    const projectId = await resolveProjectId(env, tracker, task);
    const entry = await tracker.start({
      description: task.title,
      projectId,
      startedAt: now,
    });
    await repo.startSession(env.DB, task.id, entry.id, now);
    await repo.setStatus(env.DB, task.id, "in_progress");
    return { ok: true, message: `計測を開始しました: ${task.title}` };
  } catch (e) {
    return { ok: false, message: describe(e) };
  }
}

/** 走っている計測を止めて実績を積算する。走っていなければ何もしない。 */
export async function stopTracking(env: Env, settings: Settings): Promise<TrackingResult> {
  const now = nowSec();
  const running = await repo.getRunningSession(env.DB);
  if (!running) return { ok: true, message: "計測していません" };

  // トークンが失効していても、ローカルの記録は必ず閉じる。
  // ここで諦めると計測中のまま戻せなくなり、実績が際限なく増えてしまう。
  const { tracker } = resolveTracker(settings);
  if (tracker && running.toggl_entry_id !== null) {
    try {
      await tracker.stop(running.toggl_entry_id, now);
    } catch (e) {
      // 計測側で既に止められていることがある
      if (!isKnown(e)) throw e;
    }
  }

  const duration = Math.max(0, now - running.started_at);
  await repo.stopSession(env.DB, running.id, now, duration);
  await repo.addTrackedSec(env.DB, running.task_id, duration);

  const task = await repo.getTask(env.DB, running.task_id);
  if (task?.status === "in_progress") {
    await repo.setStatus(env.DB, running.task_id, "open");
  }
  return { ok: true, message: "計測を停止しました" };
}

/**
 * 計測側で手動停止された場合に、こちらの「計測中」表示を畳む。
 * 表示合わせだけの片方向同期で、こちらから書き戻すことはしない。
 * @returns 表示が変わったら true
 */
export async function reconcileRunningEntry(env: Env, settings: Settings): Promise<boolean> {
  const { tracker } = resolveTracker(settings);
  if (!tracker) return false;

  const running = await repo.getRunningSession(env.DB);
  if (!running) return false;

  const current = await tracker.getCurrent();
  if (current && current.id === running.toggl_entry_id) return false;

  // 5 分間隔のポーリングなので、検知した時刻で閉じると最大 5 分ぶん水増しになる。
  // 実際の停止時刻が取れたらそれを使い、取れなければ検知時刻で代用する
  //（計測が開いたまま残るほうが害が大きい）。
  const now = nowSec();
  const stoppedAt = await resolveStoppedAt(tracker, running.toggl_entry_id, running.started_at, now);
  const duration = Math.max(0, stoppedAt - running.started_at);
  await repo.stopSession(env.DB, running.id, stoppedAt, duration);
  await repo.addTrackedSec(env.DB, running.task_id, duration);
  const task = await repo.getTask(env.DB, running.task_id);
  if (task?.status === "in_progress") {
    await repo.setStatus(env.DB, running.task_id, "open");
  }
  return true;
}

async function resolveStoppedAt(
  tracker: TimeTracker,
  entryId: string | null,
  startedAt: number,
  now: number,
): Promise<number> {
  if (!entryId) return now;
  try {
    const at = await tracker.getStoppedAt(entryId);
    if (at !== null && at >= startedAt && at <= now) return at;
  } catch {
    // 取れなければ検知時刻で代用する
  }
  return now;
}

function isKnown(e: unknown): boolean {
  return (
    e instanceof TrackerError || e instanceof TrackerRateLimitError || e instanceof TrackerAuthError
  );
}

function describe(e: unknown): string {
  if (e instanceof TrackerAuthError) return AUTH_FAILED;
  if (e instanceof TrackerRateLimitError) {
    return "Toggl のレート制限のため計測を開始できませんでした";
  }
  if (e instanceof TrackerError) return `計測開始に失敗しました: ${e.message}`;
  throw e;
}
