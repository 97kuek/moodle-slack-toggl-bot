#!/usr/bin/env bash
# シークレットをまとめて Cloudflare に登録する。
#   ./scripts/setup-secrets.sh
# 入力は画面に表示されず、シェル履歴にも残らない。空 Enter でスキップできる。
set -uo pipefail
cd "$(dirname "$0")/.."

if [ ! -f wrangler.toml ]; then
  echo "wrangler.toml がありません。cp wrangler.toml.example wrangler.toml から始めてください。" >&2
  exit 1
fi

MODE=$(grep -E '^MOODLE_MODE' wrangler.toml | head -1 | sed -E 's/.*"(.*)".*/\1/')
echo "MOODLE_MODE = ${MODE:-ws}"

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

put SLACK_BOT_TOKEN      "Slack アプリの Bot User OAuth Token（xoxb- で始まる）"
put SLACK_SIGNING_SECRET "Slack アプリの Basic Information にある Signing Secret"
put SLACK_USER_ID        "自分の Slack メンバー ID（U で始まる。プロフィール → その他 → メンバー ID）"

if [ "$MODE" = "ical" ]; then
  put MOODLE_ICAL_URL "Moodle のカレンダーエクスポート URL（export_execute.php?... の全体）"
else
  put MOODLE_TOKEN "Moodle Web Services のトークン（32 桁）"
fi

put TOGGL_API_TOKEN "Toggl Track の API Token（https://track.toggl.com/profile の最下部）"

echo
echo "登録済みのシークレット:"
npx wrangler secret list 2>/dev/null | grep -oE '"name": "[^"]+"' | sed 's/"name": /  /;s/"//g'
echo
echo "確認: デプロイ時に表示された URL の /health を開いて \"missing\": [] を確認してください"
