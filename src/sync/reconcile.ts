import { CONFIG } from "../config";
import * as repo from "../db/repo";
import type { TaskRow } from "../db/types";
import type { MoodleClient, RawMoodleTask } from "../moodle";

export interface SyncOutcome {
  /** 新しく現れたタスク（'new' 通知の対象） */
  inserted: TaskRow[];
  /** 締切が変わったタスクの id（締切系の通知履歴をリセット済み） */
  dueChangedIds: string[];
  /** 講義側で削除されたタスクの件数 */
  removed: number;
  /** 締切 +24h で自動アーカイブした件数 */
  archived: number;
  /** Moodle から返ってきた総件数 */
  fetched: number;
}

/**
 * Moodle と D1 を突き合わせる。
 *
 * 1 回だけ SELECT してメモリ上で差分を取り、書き込みは batch() にまとめる。
 * すべての操作は冪等で、途中で失敗しても次の cron が同じ結果に収束させる。
 */
export async function syncMoodle(
  db: D1Database,
  client: MoodleClient,
  now: number,
  /** 取り込んだタスクをまとめる分類。科目ごとに分けず、大学の課題を 1 つにまとめる */
  category: string,
): Promise<SyncOutcome> {
  const fetched = await client.fetchUpcoming();
  const raw = fetched.slice(0, CONFIG.maxTasksPerSync);

  const existing = await repo.listTasksBySource(db, client.source);
  const bySourceId = new Map(existing.map((t) => [t.source_id, t]));
  const seen = new Set<string>();

  const statements: D1PreparedStatement[] = [];
  const inserted: TaskRow[] = [];
  const dueChangedIds: string[] = [];

  for (const item of raw) {
    seen.add(item.sourceId);
    const prev = bySourceId.get(item.sourceId);

    if (!prev) {
      const row = toTaskRow(item, client.source, category, now);
      statements.push(repo.insertTaskStmt(db, row));
      inserted.push(row);
      continue;
    }

    const dueChanged = prev.due_at !== item.dueAt;
    const contentChanged =
      dueChanged ||
      prev.title !== item.title ||
      prev.url !== item.url ||
      prev.course_name !== item.courseName ||
      prev.kind !== item.kind ||
      prev.instance_id !== item.instanceId;

    if (contentChanged) {
      statements.push(
        repo.updateTaskFromMoodleStmt(db, prev.id, {
          course_id: item.courseId,
          course_name: item.courseName,
          title: item.title,
          kind: item.kind,
          url: item.url,
          instance_id: item.instanceId,
          due_at: item.dueAt,
          last_seen_at: now,
        }),
      );
    }

    // 締切が動いたら、送信済みの締切通知を消して再通知の対象に戻す。
    if (dueChanged) {
      statements.push(repo.clearDueNotificationsStmt(db, prev.id));
      dueChangedIds.push(prev.id);
      // アーカイブ済みでも締切が先送りされたなら復活させる
      if (prev.status === "archived" && item.dueAt !== null && item.dueAt > now) {
        statements.push(repo.setStatusStmt(db, prev.id, "open"));
      }
    }
  }

  // 変化が無かったものも含めて「今回見えた」印を 1 文で更新する。
  if (seen.size > 0) {
    statements.push(touchSeenStmt(db, client.source, [...seen], now));
  }

  // 消滅検出（＝講義側で課題が削除された）。
  // 誤判定を避けるため、対象は次の 2 つを満たすものだけに絞る。
  //   - 締切がまだ未来: 締切を過ぎた課題は Moodle の一覧から自然に消えるため、
  //     これを「削除された」と扱うと §9 の「締切 +24h で自動アーカイブ」が効かなくなる。
  //   - 締切が取得窓の内側: fetchUpcoming は lookahead 日先までしか返さないため、
  //     それより先の課題は「今回見えなかった」だけで消えたわけではない。
  const windowTo = now + CONFIG.lookaheadDays * 86400;
  let removed = 0;
  for (const prev of existing) {
    if (seen.has(prev.source_id)) continue;
    if (prev.status !== "open" && prev.status !== "in_progress") continue;
    if (prev.due_at === null) continue;
    if (prev.due_at <= now || prev.due_at > windowTo) continue;
    statements.push(repo.setStatusStmt(db, prev.id, "removed"));
    removed++;
  }

  if (statements.length > 0) await db.batch(statements);

  const archived = await repo.archiveOverdue(db, now - CONFIG.archiveAfterDueSec);
  await repo.setState(db, "last_sync_at", String(now));

  return { inserted, dueChangedIds, removed, archived, fetched: fetched.length };
}

/**
 * 提出済みの課題を自動で done にする（Web Services モードのみ）。
 * サブリクエスト上限を守るため 1 回あたりの問い合わせ件数を絞る。
 */
export async function syncSubmissions(
  db: D1Database,
  client: MoodleClient,
  now: number,
): Promise<number> {
  if (!client.fetchSubmissionStatus) return 0;

  const lastCheck = await repo.getStateNumber(db, "last_submission_check_at");
  if (lastCheck !== null && now - lastCheck < CONFIG.submissionCheckIntervalSec) return 0;

  const candidates = await repo.listSubmissionCheckTargets(
    db,
    client.source,
    CONFIG.maxSubmissionChecksPerSync,
  );
  const targets = candidates
    .filter((t): t is TaskRow & { instance_id: number } => t.instance_id !== null)
    .map((t) => ({ sourceId: t.source_id, instanceId: t.instance_id }));

  if (targets.length === 0) {
    await repo.setState(db, "last_submission_check_at", String(now));
    return 0;
  }

  const results = await client.fetchSubmissionStatus(targets);
  const bySourceId = new Map(candidates.map((t) => [t.source_id, t]));

  const statements: D1PreparedStatement[] = [];
  let submitted = 0;
  for (const r of results) {
    if (!r.submitted) continue;
    const task = bySourceId.get(r.sourceId);
    if (!task) continue;
    statements.push(repo.markSubmittedStmt(db, task.id, r.submittedAt ?? now));
    submitted++;
  }
  // 提出済みでなくても「見た」印は付ける。付けないと同じ課題ばかり検査してしまう。
  statements.push(repo.touchSubmissionCheckedStmt(db, candidates.map((t) => t.id), now));
  statements.push(repo.setStateStmt(db, "last_submission_check_at", String(now)));
  await db.batch(statements);

  return submitted;
}

function toTaskRow(
  item: RawMoodleTask,
  source: string,
  category: string,
  now: number,
): TaskRow {
  return {
    id: repo.newId(),
    source,
    source_id: item.sourceId,
    course_id: item.courseId,
    course_name: item.courseName,
    // 分類は取り込み時に一度だけ決める。以後は同期で上書きしないので、
    // 手で別の分類に移したタスクはそのまま残る。
    category,
    title: item.title,
    kind: item.kind,
    url: item.url,
    instance_id: item.instanceId,
    due_at: item.dueAt,
    submitted_at: null,
    status: "open",
    snooze_until: null,
    tracked_sec: 0,
    completed_at: null,
    submission_checked_at: null,
    first_seen_at: now,
    last_seen_at: now,
  };
}

function touchSeenStmt(
  db: D1Database,
  source: string,
  sourceIds: string[],
  now: number,
): D1PreparedStatement {
  const placeholders = sourceIds.map((_, i) => `?${i + 3}`).join(", ");
  return db
    .prepare(
      `UPDATE tasks SET last_seen_at = ?1 WHERE source = ?2 AND source_id IN (${placeholders})`,
    )
    .bind(now, source, ...sourceIds);
}
