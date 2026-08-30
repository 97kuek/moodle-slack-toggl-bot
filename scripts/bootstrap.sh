#!/usr/bin/env bash
# 初回セットアップをまとめて行う。
#   ./scripts/bootstrap.sh
# D1 の作成 → wrangler.toml の生成 → マイグレーション → デプロイ まで。
# シークレットの登録は ./scripts/setup-secrets.sh で行う。
set -uo pipefail
cd "$(dirname "$0")/.."

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ask() { # ask <変数名> <説明> <既定値>
  local __var="$1" __desc="$2" __def="$3" __in
  printf '\n%s\n' "$__desc"
  printf '  [%s]: ' "$__def"
  read -r __in
  printf -v "$__var" '%s' "${__in:-$__def}"
}

bold "1. Cloudflare の認証確認"
if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "  ログインしていません。ブラウザを開きます。"
  npx wrangler login || { echo "ログインに失敗しました" >&2; exit 1; }
fi
npx wrangler whoami 2>/dev/null | grep -E 'associated with|Account Name' | head -2 | sed 's/^/  /'

if [ -f wrangler.toml ]; then
  bold "wrangler.toml が既にあります"
  printf '  上書きして作り直しますか? [y/N]: '
  read -r ans
  [ "${ans:-N}" = "y" ] || { echo "  中止しました。"; exit 0; }
fi

bold "2. 設定"
ask WORKER_NAME  "Worker 名（URL の一部になります）" "moodle-slack-toggl-bot"
ask MOODLE_URL   "Moodle のベース URL（末尾スラッシュなし）" "https://moodle.example.ac.jp"
ask MOODLE_MODE  "取得方式  ws = Web Services / ical = カレンダーエクスポート" "ical"
ask TZ_MIN       "タイムゾーンの UTC オフセット（分）  540 = 日本" "540"
ask DIGEST_CRON  "朝ダイジェストの cron（UTC）  0 22 = JST 07:00" "0 22 * * *"

bold "3. D1 データベースの作成"
DB_NAME="moodle_bot"
OUT=$(npx wrangler d1 create "$DB_NAME" 2>&1)
DB_ID=$(printf '%s' "$OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
if [ -z "$DB_ID" ]; then
  echo "$OUT" | tail -4 | sed 's/^/  /'
  printf '\n  作成できませんでした。既存の D1 を使う場合は database_id を貼ってください（空で中止）: '
  read -r DB_ID
  [ -n "$DB_ID" ] || exit 1
else
  echo "  作成しました: $DB_ID"
fi

bold "4. wrangler.toml の生成"
sed -e "s|^name = .*|name = \"$WORKER_NAME\"|" \
    -e "s|^database_id = .*|database_id = \"$DB_ID\"|" \
    -e "s|^MOODLE_BASE_URL = .*|MOODLE_BASE_URL = \"$MOODLE_URL\"|" \
    -e "s|^MOODLE_MODE = .*|MOODLE_MODE = \"$MOODLE_MODE\"|" \
    -e "s|^TIMEZONE_OFFSET_MIN = .*|TIMEZONE_OFFSET_MIN = \"$TZ_MIN\"|" \
    -e "s|^  \"0 22 \* \* \*\".*|  \"$DIGEST_CRON\"|" \
    wrangler.toml.example > wrangler.toml
grep -E '^name|^database_id|^MOODLE_|^TIMEZONE' wrangler.toml | sed 's/^/  /'

bold "5. スキーマの適用"
npx wrangler d1 migrations apply "$DB_NAME" --remote 2>&1 | tail -4 | sed 's/^/  /'

bold "6. デプロイ"
DEPLOY=$(npx wrangler deploy 2>&1)
echo "$DEPLOY" | tail -6 | sed 's/^/  /'
URL=$(printf '%s' "$DEPLOY" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)

bold "完了。次にやること"
cat <<EOS

  1. シークレットを登録する
       ./scripts/setup-secrets.sh

  2. 設定が揃ったか確認する
       curl ${URL:-https://<your-worker>.workers.dev}/health
       -> "missing": [] になれば OK

  3. Slack アプリの Request URL を 2 か所に設定する
       ${URL:-https://<your-worker>.workers.dev}/slack/events
       - Event Subscriptions（bot events に app_home_opened を追加）
       - Interactivity & Shortcuts

EOS
