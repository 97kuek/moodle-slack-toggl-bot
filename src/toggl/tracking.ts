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
 *
 * 「押してから画面が変わるまで」を短くするため、処理を 2 段に分けてある。
 *
 *   1. begin*  … D1 だけを更新する。ここまで終われば App Home は描き直せる
 *   2. finish* … Toggl と往復する。ここは画面より後ろでよい
 *
 * Toggl の応答は 1 秒前後かかることがあり、開始のたびに「停止 → プロジェクト検索 →
 * 開始」で 2〜3 往復する。これを描画の前に置くと、ボタンが効いていないように見える。
 * 失敗したときだけ 1 に書いたものを取り消して、もう一度描き直す。
 */

export interface TrackingResult {
  ok: boolean;
  message: string;
}

/** 1 で書き終えた状態。2 に渡す。 */
export interface PendingStart {
  sessionId: string;
  task: TaskRow;
  startedAt: number;
  /** 直前まで走っていた計測。Toggl 側も閉じる必要がある */
  previousEntryId: string | null;
}

export interface PendingStop {
  entryId: string | null;
  stoppedAt: number;
}

const NOT_CONFIGURED =
  "Toggl のトークンが未設定です。ホームタブの「接続設定」から登録すると計測できるようになります。";

const AUTH_FAILED =
  "Toggl のトークンが無効か、有効期限が切れています。プロフィール設定で発行し直して、「接続設定」に貼り直してください。";

/**
 * 未設定・設定不足を 1 か所で判定する。
 * 通信はしないので、D1 に何か書く前にここで弾ける。
 */
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
  const category = task.category;
  if (!category) return null;

  const mapped = await repo.listCategoryProjects(env.DB);
  const hit = mapped.find((m) => m.category === category);
  if (hit) return String(hit.toggl_project_id);

  const projectId = await tracker.findOrCreateProject(category);
  if (projectId !== null) await repo.putCategoryProject(env.DB, category, projectId);
  return projectId;
}

/**
 * 計測開始のうち、D1 だけで完結する部分。
 * 走っている計測があればここで閉じ、新しいセッションを entry id 無しで開ける。
 */
export async function beginStart(
  env: Env,
  settings: Settings,
  taskId: string,
  now: number,
): Promise<{ pending: PendingStart } | { error: string }> {
  // Toggl が使えないなら何も書かない。書いてから取り消すより素直。
  const { tracker, message } = resolveTracker(settings);
  if (!tracker) return { error: message };

  const db = env.DB;
  const [task, running] = await Promise.all([repo.getTask(db, taskId), repo.getRunningWithTask(db)]);
  if (!task) return { error: "タスクが見つかりませんでした" };

  const sessionId = repo.newId();
  const statements: D1PreparedStatement[] = [];

  // 走っているものがあれば先に閉じる（計測側も 1 本しか走らせない）
  if (running) {
    const duration = Math.max(0, now - running.session.started_at);
    statements.push(
      repo.stopSessionStmt(db, running.session.id, now, duration),
      repo.addTrackedSecStmt(db, running.session.task_id, duration),
    );
    if (running.task?.status === "in_progress") {
      statements.push(repo.setStatusStmt(db, running.session.task_id, "open"));
    }
  }

  statements.push(
    repo.startSessionStmt(db, sessionId, task.id, null, now),
    repo.setStatusStmt(db, task.id, "in_progress"),
  );
  await db.batch(statements);

  return {
    pending: {
      sessionId,
      task,
      startedAt: now,
      previousEntryId: running?.session.toggl_entry_id ?? null,
    },
  };
}

/**
 * 計測開始のうち、Toggl と往復する部分。画面を描き直したあとに呼ぶ。
 * 失敗したら beginStart が書いたセッションを取り消す。放っておくと
 * Toggl では動いていない計測が「計測中」のまま残ってしまう。
 */
export async function finishStart(
  env: Env,
  settings: Settings,
  pending: PendingStart,
): Promise<TrackingResult> {
  const { tracker, message } = resolveTracker(settings);
  if (!tracker) {
    await repo.discardSession(env.DB, pending.sessionId, pending.task.id);
    return { ok: false, message };
  }

  try {
    if (pending.previousEntryId) {
      try {
        await tracker.stop(pending.previousEntryId, pending.startedAt);
      } catch (e) {
        // 計測側で既に止められていることがある
        if (!isKnown(e)) throw e;
      }
    }

    const projectId = await resolveProjectId(env, tracker, pending.task);
    const entry = await tracker.start({
      description: pending.task.title,
      projectId,
      startedAt: pending.startedAt,
    });
    await repo.setSessionEntryId(env.DB, pending.sessionId, entry.id);
    return { ok: true, message: `計測を開始しました: ${pending.task.title}` };
  } catch (e) {
    await repo.discardSession(env.DB, pending.sessionId, pending.task.id);
    return { ok: false, message: describe(e) };
  }
}

/**
 * 計測停止のうち、D1 だけで完結する部分。
 * トークンが失効していてもローカルの記録は必ず閉じる。ここで諦めると
 * 計測中のまま戻せなくなり、実績が際限なく増えてしまう。
 */
export async function beginStop(env: Env, now: number): Promise<PendingStop | null> {
  const db = env.DB;
  const running = await repo.getRunningWithTask(db);
  if (!running) return null;

  const duration = Math.max(0, now - running.session.started_at);
  const statements: D1PreparedStatement[] = [
    repo.stopSessionStmt(db, running.session.id, now, duration),
    repo.addTrackedSecStmt(db, running.session.task_id, duration),
  ];
  if (running.task?.status === "in_progress") {
    statements.push(repo.setStatusStmt(db, running.session.task_id, "open"));
  }
  await db.batch(statements);

  return { entryId: running.session.toggl_entry_id, stoppedAt: now };
}

/** 計測停止のうち、Toggl と往復する部分。画面を描き直したあとに呼ぶ。 */
export async function finishStop(settings: Settings, pending: PendingStop): Promise<TrackingResult> {
  if (!pending.entryId) return { ok: true, message: "計測を停止しました" };

  const { tracker } = resolveTracker(settings);
  if (!tracker) return { ok: true, message: "計測を停止しました" };

  try {
    await tracker.stop(pending.entryId, pending.stoppedAt);
  } catch (e) {
    // 計測側で既に止められていることがある
    if (!isKnown(e)) throw e;
  }
  return { ok: true, message: "計測を停止しました" };
}

/** 2 段に分ける必要がない場所（cron など）向けのまとめた停止。 */
export async function stopTracking(env: Env, settings: Settings): Promise<TrackingResult> {
  const pending = await beginStop(env, nowSec());
  if (!pending) return { ok: true, message: "計測していません" };
  return await finishStop(settings, pending);
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

  const now = nowSec();
  // entry id がまだ入っていないのは、開始直後で Toggl への登録が終わっていない状態。
  // ここで「Toggl に無い」と判断すると、始めたばかりの計測を畳んでしまう。
  if (running.toggl_entry_id === null && now - running.started_at < 120) return false;

  const current = await tracker.getCurrent();
  if (current && current.id === running.toggl_entry_id) return false;

  // 5 分間隔のポーリングなので、検知した時刻で閉じると最大 5 分ぶん水増しになる。
  // 実際の停止時刻が取れたらそれを使い、取れなければ検知時刻で代用する
  //（計測が開いたまま残るほうが害が大きい）。
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
