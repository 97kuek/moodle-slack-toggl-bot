-- 提出状況の問い合わせは 1 件 1 リクエストなので 1 回あたり 8 件に絞っているが、
-- 締切順で選ぶと 9 件目以降が永久に検査されない。最後に見た時刻を持たせて
-- 「未検査 → 最も長く見ていないもの」の順で回す。
ALTER TABLE tasks ADD COLUMN submission_checked_at INTEGER;
