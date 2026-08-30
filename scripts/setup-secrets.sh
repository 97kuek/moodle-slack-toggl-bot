#!/usr/bin/env bash
# Slack の認証情報だけを Cloudflare に登録する。
#   ./scripts/setup-secrets.sh
# Moodle と Toggl の設定は Slack のホームタブ →「⚙️ 接続設定」から入れる。
set -uo pipefail
cd "$(dirname "$0")/.."

if [ ! -f wrangler.toml ]; then
  echo "wrangler.toml がありません。先に ./scripts/bootstrap.sh を実行してください。" >&2
  exit 1
fi

put() {
  local name="$1" desc="$2" value err
  printf '\n\033[1m%s\033[0m\n  %s\n' "$name" "$desc"
  printf '  値を貼り付けて Enter（空ならスキップ）: '
  read -r -s value
  echo
  if [ -z "$value" ]; then
    echo "  — スキップしました"
    return
  fi
  err=$(printf '%s' "$value" | npx wrangler secret put "$name" 2>&1)
  if [ $? -eq 0 ]; then
    echo "  ✅ 登録しました（${#value} 文字）"
  else
    echo "  ❌ 失敗しました:"
    echo "$err" | tail -3 | sed 's/^/     /'
  fi
}

echo "Slack の認証情報を登録します。この 3 つだけが Cloudflare 側に必要です。"

put SLACK_BOT_TOKEN      "Bot User OAuth Token（xoxb- で始まる）— OAuth & Permissions"
put SLACK_SIGNING_SECRET "Signing Secret — Basic Information → App Credentials"
put SLACK_USER_ID        "自分の Slack メンバー ID（U で始まる）— プロフィール → その他 → メンバー ID"

echo
echo "登録済み:"
npx wrangler secret list 2>/dev/null | grep -oE '"name": "[^"]+"' | sed 's/"name": /  /;s/"//g'
cat <<'EOS'

次にやること
  1. Slack アプリの Request URL を 2 か所に設定する（デプロイ時に表示された URL + /slack/events）
       - Event Subscriptions（bot events に app_home_opened を追加）
       - Interactivity & Shortcuts
  2. Slack でアプリのホームタブを開き、「⚙️ 接続設定」から
     Moodle の URL と iCal URL（または Web Services トークン）、Toggl のトークンを入れる

EOS
