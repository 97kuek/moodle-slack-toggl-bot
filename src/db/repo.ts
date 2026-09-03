import type {
  CategoryProjectRow,
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

const TASK_COLUMNS = `id, source, source_id, course_id, course_name, category, title, kind, url,
  instance_id, due_at, submitted_at, status, snooze_until, tracked_sec, completed_at,
  submission_checked_at, first_seen_at, last_seen_at`;

const TASK_COLUMN_NAMES = TASK_COLUMNS.split(",").map((c) => c.trim());

// ---------------------------------------------------------------- tasks

export async function listTasksBySource(db: D1Database, source: string): Promise<TaskRow[]> {
  const res = await db
    .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE source = ?1`)
    .bind(source)
    .all<TaskRow>();
  return res.results ?? [];
}

/**
 * App Home と通知の対象になる、生きているタスク。
 * category を渡すとその分類だけに絞る（App Home の絞り込み用。通知では絞らない）。
 */
export async function listActiveTasks(
  db: D1Database,
  limit: number,
  category?: string | null,
): Promise<TaskRow[]> {
  const where = category ? `AND category = ?2` : ``;
  const stmt = db.prepare(
    `SELECT ${TASK_COLUMNS} FROM tasks
     WHERE status IN ('open', 'in_progress') ${where}
     ORDER BY due_at IS NULL, due_at ASC
     LIMIT ?1`,
  );
  const res = await (category ? stmt.bind(limit, category) : stmt.bind(limit)).all<TaskRow>();
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
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)`,
    )
    .bind(
      task.id,
      task.source,
      task.source_id,
      task.course_id,
      task.course_name,
      task.category,
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

/**
 * Moodle 側の内容で上書きする更新。
 * ローカルの状態（status / snooze / 実績）は触らない。
 * 分類も触らない。手で変えた分類が次の同期で戻ってしまうため。
 */
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
export function markDoneStmt(db: D1Database, id: string, at: number): D1PreparedStatement {
  return db
    .prepare(`UPDATE tasks SET status = 'done', completed_at = COALESCE(completed_at, ?2) WHERE id = ?1`)
    .bind(id, at);
}

export async function markDone(db: D1Database, id: string, at: number): Promise<void> {
  await markDoneStmt(db, id, at).run();
}

/** 分類を変える。Moodle 由来のタスクでも、ここで変えたものは同期で戻らない。 */
export async function setCategory(
  db: D1Database,
  id: string,
  category: string | null,
): Promise<void> {
  await db.prepare(`UPDATE tasks SET category = ?2 WHERE id = ?1`).bind(id, category).run();
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
  const row = await db
    .prepare(
      `SELECT id, task_id, toggl_entry_id, started_at, stopped_at, duration_sec
       FROM time_sessions WHERE stopped_at IS NULL ORDER BY started_at DESC LIMIT 1`,
    )
    .first<TimeSessionRow & { toggl_entry_id: string | number | null }>();
  if (!row) return null;
  // 列が INTEGER affinity なので、書き込んだ文字列が数値として読み戻る。
  // 比較のたびに型が食い違わないよう、ここで文字列に揃える。
  return {
    ...row,
    toggl_entry_id: row.toggl_entry_id === null ? null : String(row.toggl_entry_id),
  };
}

/**
 * 走っているセッションと、その対象タスクを 1 回のクエリで引く。
 * App Home を描くたびに 2 往復させると、その分ボタンの反応が遅れる。
 */
export async function getRunningWithTask(
  db: D1Database,
): Promise<{ session: TimeSessionRow; task: TaskRow | null } | null> {
  const row = await db
    .prepare(
      `SELECT s.id AS session_id, s.task_id, s.toggl_entry_id, s.started_at, s.duration_sec,
              ${TASK_COLUMN_NAMES.map((c) => `t.${c}`).join(", ")}
       FROM time_sessions s LEFT JOIN tasks t ON t.id = s.task_id
       WHERE s.stopped_at IS NULL ORDER BY s.started_at DESC LIMIT 1`,
    )
    .first<Record<string, unknown>>();
  if (!row) return null;
  return {
    session: {
      id: String(row["session_id"]),
      task_id: String(row["task_id"]),
      toggl_entry_id: row["toggl_entry_id"] === null ? null : String(row["toggl_entry_id"]),
      started_at: Number(row["started_at"]),
      stopped_at: null,
      duration_sec: row["duration_sec"] === null ? null : Number(row["duration_sec"]),
    },
    // join した行にはセッション側の列も混ざっているので、tasks の列だけを取り出す。
    task: row["id"]
      ? (Object.fromEntries(TASK_COLUMN_NAMES.map((c) => [c, row[c]])) as unknown as TaskRow)
      : null,
  };
}

export function startSessionStmt(
  db: D1Database,
  id: string,
  taskId: string,
  togglEntryId: string | null,
  startedAt: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO time_sessions (id, task_id, toggl_entry_id, started_at) VALUES (?1, ?2, ?3, ?4)`,
    )
    .bind(id, taskId, togglEntryId, startedAt);
}

export async function startSession(
  db: D1Database,
  taskId: string,
  togglEntryId: string | null,
  startedAt: number,
): Promise<string> {
  const id = newId();
  await startSessionStmt(db, id, taskId, togglEntryId, startedAt).run();
  return id;
}

export function stopSessionStmt(
  db: D1Database,
  sessionId: string,
  stoppedAt: number,
  durationSec: number,
): D1PreparedStatement {
  return db
    .prepare(`UPDATE time_sessions SET stopped_at = ?2, duration_sec = ?3 WHERE id = ?1`)
    .bind(sessionId, stoppedAt, Math.max(0, Math.round(durationSec)));
}

export async function stopSession(
  db: D1Database,
  sessionId: string,
  stoppedAt: number,
  durationSec: number,
): Promise<void> {
  await stopSessionStmt(db, sessionId, stoppedAt, durationSec).run();
}

export function addTrackedSecStmt(db: D1Database, id: string, sec: number): D1PreparedStatement {
  return db
    .prepare(`UPDATE tasks SET tracked_sec = tracked_sec + ?2 WHERE id = ?1`)
    .bind(id, Math.max(0, Math.round(sec)));
}

/**
 * 計測を始めた事実だけ先に書いておき、Toggl の entry id は後から入れる。
 * ボタンの反応を Toggl の往復より先に返すための後追い更新。
 */
export async function setSessionEntryId(
  db: D1Database,
  sessionId: string,
  entryId: string,
): Promise<void> {
  await db
    .prepare(`UPDATE time_sessions SET toggl_entry_id = ?2 WHERE id = ?1`)
    .bind(sessionId, entryId)
    .run();
}

/** Toggl 側で開始できなかったときに、先に書いたセッションを無かったことにする。 */
export async function discardSession(
  db: D1Database,
  sessionId: string,
  taskId: string,
): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM time_sessions WHERE id = ?1`).bind(sessionId),
    db.prepare(`UPDATE tasks SET status = 'open' WHERE id = ?1 AND status = 'in_progress'`).bind(taskId),
  ]);
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

/** 手動で足したタスクだけ削除できる。Moodle 由来は消してもすぐ再取得される。 */
export async function deleteManualTask(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM tasks WHERE id = ?1 AND source = 'manual'`).bind(id),
    db.prepare(`DELETE FROM notifications WHERE task_id = ?1`).bind(id),
  ]);
}

/** 完了を取り消す。Moodle からは再取得されないので、これが唯一の復旧手段。 */
export async function markUndone(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(`UPDATE tasks SET status = 'open', completed_at = NULL WHERE id = ?1`)
    .bind(id)
    .run();
}

export interface CategoryTotal {
  category: string | null;
  sec: number;
  sessions: number;
}

/** 期間内の学習時間を分類別に集計する（週次サマリ用）。 */
export async function trackedByCategory(
  db: D1Database,
  from: number,
  to: number,
): Promise<CategoryTotal[]> {
  const res = await db
    .prepare(
      `SELECT t.category AS category, SUM(s.duration_sec) AS sec, COUNT(*) AS sessions
       FROM time_sessions s JOIN tasks t ON t.id = s.task_id
       WHERE s.stopped_at IS NOT NULL AND s.started_at >= ?1 AND s.started_at < ?2
       GROUP BY t.category ORDER BY sec DESC`,
    )
    .bind(from, to)
    .all<CategoryTotal>();
  return res.results ?? [];
}

export interface CompletionDay {
  /** ローカル日付を表す通し番号（unix 秒 + オフセットを 86400 で割ったもの） */
  day: number;
  n: number;
}

/**
 * 完了した日ごとの件数を新しい順に返す。「今日 n 件」と「連続日数」の材料。
 *
 * 日付の切り出しは SQLite 側でやる。件数ぶんの行を JS に持ってきて数えると、
 * 学期が進むほど App Home の描画が重くなる。
 */
export async function completionsByDay(
  db: D1Database,
  tzOffsetSec: number,
  since: number,
  limitDays: number,
): Promise<CompletionDay[]> {
  const res = await db
    .prepare(
      `SELECT (completed_at + ?1) / 86400 AS day, COUNT(*) AS n FROM tasks
       WHERE completed_at IS NOT NULL AND completed_at >= ?2
       GROUP BY day ORDER BY day DESC LIMIT ?3`,
    )
    .bind(tzOffsetSec, since, limitDays)
    .all<CompletionDay>();
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

// -------------------------------------------------- category_project_map

export async function listCategoryProjects(db: D1Database): Promise<CategoryProjectRow[]> {
  const res = await db
    .prepare(`SELECT category, toggl_project_id FROM category_project_map`)
    .all<CategoryProjectRow>();
  return res.results ?? [];
}

export async function putCategoryProject(
  db: D1Database,
  category: string,
  projectId: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO category_project_map (category, toggl_project_id) VALUES (?1, ?2)
       ON CONFLICT (category) DO UPDATE SET toggl_project_id = ?2`,
    )
    .bind(category, projectId)
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

/** 記録用の値をまとめて書く。往復を 1 回に抑えるためのもの。 */
export async function setStates(db: D1Database, entries: Record<string, string>): Promise<void> {
  const statements = Object.entries(entries).map(([k, v]) => setStateStmt(db, k, v));
  if (statements.length === 0) return;
  await db.batch(statements);
}
