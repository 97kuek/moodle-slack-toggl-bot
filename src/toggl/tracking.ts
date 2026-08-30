import { isTogglConfigured, type Env } from "../config";
import * as repo from "../db/repo";
import type { TaskRow } from "../db/types";
import { nowSec } from "../time";
import { TogglClient, TogglError, TogglRateLimitError } from "./client";

/**
 * Slack のボタンと Toggl の間の橋渡し。
 * 操作は必ず Slack 起点（片方向）で、Toggl → Slack は表示の同期だけ（§8）。
 */

export interface TrackingResult {
  ok: boolean;
  message: string;
}

export function createTogglClient(env: Env): TogglClient {
  return new TogglClient(env.TOGGL_API_TOKEN, env.TOGGL_WORKSPACE_ID);
}

/** 科目に対応する Toggl プロジェクトを引く。無ければ作って覚える。 */
async function resolveProjectId(
  env: Env,
  toggl: TogglClient,
  task: TaskRow,
): Promise<number | null> {
  if (!task.course_id || !task.course_name) return null;
  const mapped = await repo.listCourseProjects(env.DB);
  const hit = mapped.find((m) => m.course_id === task.course_id);
  if (hit) return hit.toggl_project_id;

  const projectId = await toggl.findOrCreateProject(task.course_name);
  await repo.putCourseProject(env.DB, task.course_id, task.course_name, projectId);
  return projectId;
}

const NOT_CONFIGURED =
  "Toggl の API トークンが未設定です。`npx wrangler secret put TOGGL_API_TOKEN` で登録すると計測できるようになります。";

export async function startTracking(env: Env, taskId: string): Promise<TrackingResult> {
  if (!isTogglConfigured(env)) return { ok: false, message: NOT_CONFIGURED };
  const now = nowSec();
  const task = await repo.getTask(env.DB, taskId);
  if (!task) return { ok: false, message: "タスクが見つかりませんでした" };

  // 走っているものがあれば先に閉じる（Toggl 側も 1 本しか走らせない）
  await stopTracking(env);

  const toggl = createTogglClient(env);
  try {
    const projectId = await resolveProjectId(env, toggl, task);
    const entry = await toggl.startEntry({
      description: task.title,
      projectId,
      tags: ["moodle"],
      startedAt: now,
    });
    await repo.startSession(env.DB, task.id, entry.id, now);
    await repo.setStatus(env.DB, task.id, "in_progress");
    return { ok: true, message: `計測を開始しました: ${task.title}` };
  } catch (e) {
    if (e instanceof TogglRateLimitError) {
      return { ok: false, message: "Toggl のレート制限のため計測を開始できませんでした" };
    }
    if (e instanceof TogglError) {
      return { ok: false, message: `計測開始に失敗しました: ${e.message}` };
    }
    throw e;
  }
}

/** 走っている計測を止めて実績を積算する。走っていなければ何もしない。 */
export async function stopTracking(env: Env): Promise<TrackingResult> {
  if (!isTogglConfigured(env)) return { ok: false, message: NOT_CONFIGURED };
  const now = nowSec();
  const running = await repo.getRunningSession(env.DB);
  if (!running) return { ok: true, message: "計測していません" };

  if (running.toggl_entry_id !== null) {
    try {
      await createTogglClient(env).stopEntry(running.toggl_entry_id);
    } catch (e) {
      // Toggl 側で既に止められていることがある。ローカルの記録は必ず閉じる。
      if (!(e instanceof TogglError) && !(e instanceof TogglRateLimitError)) throw e;
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
 * Toggl 側で手動停止された場合に、こちらの「計測中」表示を畳む。
 * 表示合わせだけの片方向同期で、Toggl の内容をこちらから書き戻すことはしない。
 * @returns 表示が変わったら true
 */
export async function reconcileRunningEntry(env: Env): Promise<boolean> {
  if (!isTogglConfigured(env)) return false;
  const running = await repo.getRunningSession(env.DB);
  if (!running) return false;

  const toggl = createTogglClient(env);
  const current = await toggl.getCurrentEntry();
  if (current && current.id === running.toggl_entry_id) return false;

  // Toggl 側で止められていた場合、検知した時刻で閉じると最大 5 分ぶん水増しになる。
  // 実際の停止時刻を問い合わせて、取れたらそれを使う。
  const now = nowSec();
  let stoppedAt = now;
  if (running.toggl_entry_id !== null) {
    try {
      const entry = await toggl.getEntry(running.toggl_entry_id);
      const stop = entry?.stop ? Math.floor(Date.parse(entry.stop) / 1000) : NaN;
      if (Number.isFinite(stop) && stop >= running.started_at && stop <= now) stoppedAt = stop;
    } catch {
      // 取れなければ検知時刻で閉じる。計測が開いたままになるよりはよい。
    }
  }

  const duration = Math.max(0, stoppedAt - running.started_at);
  await repo.stopSession(env.DB, running.id, stoppedAt, duration);
  await repo.addTrackedSec(env.DB, running.task_id, duration);
  const task = await repo.getTask(env.DB, running.task_id);
  if (task?.status === "in_progress") {
    await repo.setStatus(env.DB, running.task_id, "open");
  }
  return true;
}
