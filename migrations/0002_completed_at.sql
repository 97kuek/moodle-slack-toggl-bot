-- 週次サマリで「今週これだけ終わらせた」を出すために、完了した時刻を持たせる。
-- status だけでは、いつ done になったのかが分からない。
ALTER TABLE tasks ADD COLUMN completed_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks (completed_at);
