import type {
  CourseProjectRow,
  NotificationKind,
  TaskRow,
  TaskStatus,
  TimeSessionRow,
} from "./types";

/**
 * D1 への薄いリポジトリ層。
 *
 * 同期処理は「まとめて 1 回 SELECT → メモリ上で差分を取る → batch() で書く」形にしてある。
 * タスクごとにクエリを往復させると Workers の CPU 時間とサブリクエスト数を無駄に食うため。
 */

export function newId(): string {
  return crypto.randomUUID();
}

const TASK_COLUMNS = `id, source, source_id, course_id, course_name, title, kind, url,
  instance_id, due_at, submitted_at, status, snooze_until, tracked_sec, completed_at,
  submission_checked_at, first_seen_at, last_seen_at`;

// ---------------------------------------------------------------- tasks

export async function listTasksBySource(db: D1Database, source: string): Promise<TaskRow[]> {
  const res = await db
    .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE source = ?1`)
    .bind(source)
    .all<TaskRow>();
  return res.results ?? [];
}

/** App Home と通知の対象になる、生きているタスク。 */
export async function listActiveTasks(db: D1Database, limit: number): Promise<TaskRow[]> {
  const res = await db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM tasks
       WHERE status IN ('open', 'in_progress')
       ORDER BY due_at IS NULL, due_at ASC
       LIMIT ?1`,
    )
    .bind(limit)
    .all<TaskRow>();
  return res.results ?? [];
}

export async function getTask(db: D1Database, id: string): Promise<TaskRow | null> {
  return await db
    .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?1`)
    .bind(id)
    .first<TaskRow>();
}

export function insertTaskStmt(db: D1Database, task: TaskRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO tasks (${TASK_COLUMNS})
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)`,
    )
    .bind(
      task.id,
      task.source,
      task.source_id,
      task.course_id,
      task.course_name,
      task.title,
      task.kind,
      task.url,
      task.instance_id,
      task.due_at,
      task.submitted_at,
      task.status,
      task.snooze_until,
      task.tracked_sec,
      task.completed_at,
      task.submission_checked_at,
      task.first_seen_at,
      task.last_seen_at,
    );
}

/** Moodle 側の内容で上書きする更新。ローカルの状態（status / snooze / 実績）は触らない。 */
export function updateTaskFromMoodleStmt(
  db: D1Database,
  id: string,
  fields: Pick<TaskRow, "course_id" | "course_name" | "title" | "kind" | "url" | "instance_id" | "due_at" | "last_seen_at">,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE tasks SET course_id = ?2, course_name = ?3, title = ?4, kind = ?5,
       url = ?6, instance_id = ?7, due_at = ?8, last_seen_at = ?9 WHERE id = ?1`,
    )
    .bind(
      id,
      fields.course_id,
      fields.course_name,
      fields.title,
      fields.kind,
      fields.url,
      fields.instance_id,
      fields.due_at,
      fields.last_seen_at,
    );
}

export function setStatusStmt(db: D1Database, id: string, status: TaskStatus): D1PreparedStatement {
  return db.prepare(`UPDATE tasks SET status = ?2 WHERE id = ?1`).bind(id, status);
}

export async function setStatus(db: D1Database, id: string, status: TaskStatus): Promise<void> {
  await setStatusStmt(db, id, status).run();
}

export function markSubmittedStmt(db: D1Database, id: string, submittedAt: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE tasks SET status = 'done', submitted_at = ?2, completed_at = COALESCE(completed_at, ?2)
       WHERE id = ?1 AND status <> 'done'`,
    )
    .bind(id, submittedAt);
}

/** 手動の「完了」。いつ終わらせたかを残して週次サマリの集計に使う。 */
export async function markDone(db: D1Database, id: string, at: number): Promise<void> {
  await db
    .prepare(`UPDATE tasks SET status = 'done', completed_at = COALESCE(completed_at, ?2) WHERE id = ?1`)
    .bind(id, at)
    .run();
}

export async function snoozeTask(db: D1Database, id: string, until: number): Promise<void> {
  await db.prepare(`UPDATE tasks SET snooze_until = ?2 WHERE id = ?1`).bind(id, until).run();
}

export async function addTrackedSec(db: D1Database, id: string, sec: number): Promise<void> {
  await db
    .prepare(`UPDATE tasks SET tracked_sec = tracked_sec + ?2 WHERE id = ?1`)
    .bind(id, Math.max(0, Math.round(sec)))
    .run();
}

/** 締切を 24 時間過ぎたものを自動アーカイブする。催促もこれで止まる。 */
export async function archiveOverdue(db: D1Database, before: number): Promise<number> {
  const res = await db
    .prepare(
      `UPDATE tasks SET status = 'archived'
       WHERE status IN ('open', 'in_progress') AND due_at IS NOT NULL AND due_at < ?1`,
    )
    .bind(before)
    .run();
  return res.meta.changes ?? 0;
}

/** 提出状況を問い合わせる候補。前回チェックから間隔が空いた課題だけを、締切が近い順に返す。 */
export async function listSubmissionCheckTargets(
  db: D1Database,
  source: string,
  limit: number,
): Promise<TaskRow[]> {
  const res = await db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM tasks
       WHERE source = ?1 AND status IN ('open', 'in_progress')
         AND kind = 'assign' AND instance_id IS NOT NULL
       -- 未検査を最優先し、次に最も長く見ていないものから回す。
       -- 締切順だけで選ぶと 9 件目以降が永久に検査されない。
       ORDER BY submission_checked_at IS NOT NULL, submission_checked_at ASC,
                due_at IS NULL, due_at ASC
       LIMIT ?2`,
    )
    .bind(source, limit)
    .all<TaskRow>();
  return res.results ?? [];
}

// ---------------------------------------------------------- notifications

/**
 * 通知の権利を取る。true が返ったときだけ送信してよい。
 * PRIMARY KEY (task_id, kind) により、同じ通知は決して二度送られない。
 */
export async function claimNotification(
  db: D1Database,
  taskId: string,
  kind: NotificationKind,
  now: number,
): Promise<boolean> {
  const res = await db
    .prepare(`INSERT OR IGNORE INTO notifications (task_id, kind, sent_at) VALUES (?1, ?2, ?3)`)
    .bind(taskId, kind, now)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** 送信に失敗したら権利を返す。次の cron で再試行される。 */
export async function releaseNotification(
  db: D1Database,
  taskId: string,
  kind: NotificationKind,
): Promise<void> {
  await db
    .prepare(`DELETE FROM notifications WHERE task_id = ?1 AND kind = ?2`)
    .bind(taskId, kind)
    .run();
}

export async function releaseNotifications(
  db: D1Database,
  entries: { taskId: string; kind: NotificationKind }[],
): Promise<void> {
  if (entries.length === 0) return;
  await db.batch(
    entries.map((e) =>
      db
        .prepare(`DELETE FROM notifications WHERE task_id = ?1 AND kind = ?2`)
        .bind(e.taskId, e.kind),
    ),
  );
}

/** 締切が変わったタスクは、締切系の通知履歴を消して再通知の対象に戻す。 */
export function clearDueNotificationsStmt(db: D1Database, taskId: string): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM notifications WHERE task_id = ?1 AND kind IN ('due_tomorrow', 'due_3h', 'overdue')`,
    )
    .bind(taskId);
}

// --------------------------------------------------------- time_sessions

export async function getRunningSession(db: D1Database): Promise<TimeSessionRow | null> {
  return await db
    .prepare(
      `SELECT id, task_id, toggl_entry_id, started_at, stopped_at, duration_sec
       FROM time_sessions WHERE stopped_at IS NULL ORDER BY started_at DESC LIMIT 1`,
    )
    .first<TimeSessionRow>();
}

export async function startSession(
  db: D1Database,
  taskId: string,
  togglEntryId: number | null,
  startedAt: number,
): Promise<string> {
  const id = newId();
  await db
    .prepare(
      `INSERT INTO time_sessions (id, task_id, toggl_entry_id, started_at) VALUES (?1, ?2, ?3, ?4)`,
    )
    .bind(id, taskId, togglEntryId, startedAt)
    .run();
  return id;
}

export async function stopSession(
  db: D1Database,
  sessionId: string,
  stoppedAt: number,
  durationSec: number,
): Promise<void> {
  await db
    .prepare(`UPDATE time_sessions SET stopped_at = ?2, duration_sec = ?3 WHERE id = ?1`)
    .bind(sessionId, stoppedAt, Math.max(0, Math.round(durationSec)))
    .run();
}

/** JST の今日ぶんの実績（計測中のぶんは含まない）。 */
export async function trackedSecSince(db: D1Database, since: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(duration_sec), 0) AS total FROM time_sessions
       WHERE stopped_at IS NOT NULL AND started_at >= ?1`,
    )
    .bind(since)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/** 問い合わせた事実を残す。提出済みでなくても更新して次に回す。 */
export function touchSubmissionCheckedStmt(
  db: D1Database,
  ids: string[],
  now: number,
): D1PreparedStatement {
  const placeholders = ids.map((_, i) => `?${i + 2}`).join(", ");
  return db
    .prepare(`UPDATE tasks SET submission_checked_at = ?1 WHERE id IN (${placeholders})`)
    .bind(now, ...ids);
}

/** 直近に完了したタスク。押し間違いを戻せるように App Home に出す。 */
export async function listRecentlyCompleted(
  db: D1Database,
  since: number,
  limit: number,
): Promise<TaskRow[]> {
  const res = await db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM tasks
       WHERE status = 'done' AND completed_at IS NOT NULL AND completed_at >= ?1
       ORDER BY completed_at DESC LIMIT ?2`,
    )
    .bind(since, limit)
    .all<TaskRow>();
  return res.results ?? [];
}

/** 完了を取り消す。Moodle からは再取得されないので、これが唯一の復旧手段。 */
export async function markUndone(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(`UPDATE tasks SET status = 'open', completed_at = NULL WHERE id = ?1`)
    .bind(id)
    .run();
}

export interface CourseTotal {
  course: string | null;
  sec: number;
  sessions: number;
}

/** 期間内の学習時間を科目別に集計する（週次サマリ用）。 */
export async function trackedByCourse(
  db: D1Database,
  from: number,
  to: number,
): Promise<CourseTotal[]> {
  const res = await db
    .prepare(
      `SELECT t.course_name AS course, SUM(s.duration_sec) AS sec, COUNT(*) AS sessions
       FROM time_sessions s JOIN tasks t ON t.id = s.task_id
       WHERE s.stopped_at IS NOT NULL AND s.started_at >= ?1 AND s.started_at < ?2
       GROUP BY t.course_name ORDER BY sec DESC`,
    )
    .bind(from, to)
    .all<CourseTotal>();
  return res.results ?? [];
}

/** 期間内に完了したタスク。 */
export async function completedBetween(
  db: D1Database,
  from: number,
  to: number,
): Promise<TaskRow[]> {
  const res = await db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM tasks
       WHERE completed_at IS NOT NULL AND completed_at >= ?1 AND completed_at < ?2
       ORDER BY completed_at ASC`,
    )
    .bind(from, to)
    .all<TaskRow>();
  return res.results ?? [];
}

// ---------------------------------------------------- course_project_map

export async function listCourseProjects(db: D1Database): Promise<CourseProjectRow[]> {
  const res = await db
    .prepare(`SELECT course_id, course_name, toggl_project_id FROM course_project_map`)
    .all<CourseProjectRow>();
  return res.results ?? [];
}

export async function putCourseProject(
  db: D1Database,
  courseId: string,
  courseName: string | null,
  projectId: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO course_project_map (course_id, course_name, toggl_project_id)
       VALUES (?1, ?2, ?3)
       ON CONFLICT (course_id) DO UPDATE SET course_name = ?2, toggl_project_id = ?3`,
    )
    .bind(courseId, courseName, projectId)
    .run();
}

// ------------------------------------------------------------- kv_state

export async function getState(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT value FROM kv_state WHERE key = ?1`)
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function getStateNumber(db: D1Database, key: string): Promise<number | null> {
  const raw = await getState(db, key);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function setStateStmt(db: D1Database, key: string, value: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO kv_state (key, value) VALUES (?1, ?2)
       ON CONFLICT (key) DO UPDATE SET value = ?2`,
    )
    .bind(key, value);
}

export async function setState(db: D1Database, key: string, value: string): Promise<void> {
  await setStateStmt(db, key, value).run();
}
