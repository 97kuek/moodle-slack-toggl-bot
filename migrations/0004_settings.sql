-- 設定を Slack から変更できるようにするための保管場所。
-- 解決順は  D1 → 環境変数（wrangler secret / vars）→ コードの既定値。
-- 既存のデプロイは環境変数のまま動き続ける。
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
