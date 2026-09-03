-- 分類（category）を tasks に持たせる。
--
-- これまでは Moodle の科目名がそのまま Toggl のプロジェクトになっていたため、
-- 履修科目の数だけプロジェクトが増え、集計が細かくなりすぎていた。
-- Moodle 由来のタスクはまとめて 1 つの分類（既定 "Waseda"）に入れ、
-- 手で足したタスクは選択肢から選ぶ。科目名は表示用の情報として残す。

ALTER TABLE tasks ADD COLUMN category TEXT;

UPDATE tasks SET category = 'Waseda' WHERE source LIKE 'moodle%';
UPDATE tasks SET category = course_name WHERE source = 'manual';

-- Toggl プロジェクトの対応表は科目単位から分類単位に変わる。
-- 旧テーブルの内容はもう引けないので作り直す（プロジェクトは名前で引き直される）。
DROP TABLE IF EXISTS course_project_map;

CREATE TABLE IF NOT EXISTS category_project_map (
  category         TEXT PRIMARY KEY,
  toggl_project_id TEXT NOT NULL
);
