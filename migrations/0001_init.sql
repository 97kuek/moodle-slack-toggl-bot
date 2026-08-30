-- Moodle → Slack TODO + Toggl 時間管理ボット 初期スキーマ
-- 時刻はすべて unix 秒 / UTC。表示と判定のみ JST に変換する。

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL,              -- 'moodle_ws' | 'moodle_ical'
  source_id     TEXT NOT NULL,              -- Moodle event id / iCal UID
  course_id     TEXT,
  course_name   TEXT,                       -- shortname 優先
  title         TEXT NOT NULL,
  kind          TEXT,                       -- 'assign' | 'quiz' | 'event'
  url           TEXT,
  instance_id   INTEGER,                    -- assign id（提出済み判定に使う）
  due_at        INTEGER,
  submitted_at  INTEGER,
  status        TEXT NOT NULL DEFAULT 'open',
  snooze_until  INTEGER,
  tracked_sec   INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  UNIQUE (source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks (status, due_at);

CREATE TABLE IF NOT EXISTS notifications (
  task_id  TEXT NOT NULL,
  kind     TEXT NOT NULL,                   -- 'new' | 'due_tomorrow' | 'due_3h' | 'overdue'
  sent_at  INTEGER NOT NULL,
  slack_ts TEXT,
  PRIMARY KEY (task_id, kind)               -- 冪等性の要
);

CREATE TABLE IF NOT EXISTS time_sessions (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL,
  toggl_entry_id INTEGER,
  started_at     INTEGER NOT NULL,
  stopped_at     INTEGER,
  duration_sec   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_open ON time_sessions (stopped_at);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON time_sessions (started_at);

CREATE TABLE IF NOT EXISTS course_project_map (
  course_id        TEXT PRIMARY KEY,
  course_name      TEXT,
  toggl_project_id INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
