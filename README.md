# Moodle → Slack TODO + Toggl 時間管理ボット

Moodle の課題・締切を定期取得して **Slack を常設の TODO** にし、そのままボタンひとつで
**Toggl Track の時間計測**を開始できる個人用ボット。

- Cloudflare Workers + D1 の**無料枠内で常時稼働**（月額 0 円、PC のスリープに影響されない）
- **1 人 1 デプロイ**のシングルテナント。他人の認証情報を預からない
- 大学ごとに違う Moodle の事情は `MoodleClient` 1 箇所に閉じ込めてあるので、
  Web Services が使えない環境でも iCal で動く

設計の背景と判断理由は [DESIGN.md](./DESIGN.md) に書いてあります。

---

## できること

- 新しい課題を検出したら Slack に通知（同時に複数出ても **1 通にまとめる**）
- 締切の前日 21:00 と 3 時間前にリマインド、毎朝 7:00 に 3 日以内のダイジェスト
- App Home に締切順の TODO リスト。`▶︎ 開始` / `✓ 完了` / `😴 明日` / `🔗 Moodle`
- `▶︎ 開始` で Toggl の計測を開始（科目 = プロジェクト、tag = `moodle`）。
  走っている計測があれば自動で止めてから始める
- Moodle 側で提出を検知したら**自動で完了**（Web Services モードのみ）
- 締切を 24 時間過ぎたタスクは**自動でアーカイブ**。催促も止まる

---

## セットアップ

### 0. まず Moodle に繋がるか確かめる（いちばん重要）

大学の Moodle が SSO（学認 / Shibboleth）ログインだと、トークン取得が通らないことがあります。
**先にここを確認してください。** 結果でモードが決まります。

```bash
read -s PW   # 入力したパスワードはシェル履歴に残りません
curl -s "https://<あなたの大学のmoodle>/login/token.php" \
  -d "username=<学籍番号など>" --data-urlencode "password=$PW" -d "service=moodle_mobile_app"
```

| 結果 | 使うモード |
|---|---|
| `{"token":"..."}` が返る | **`ws`**（推奨。提出済みの自動判定まで動く） |
| `{"error":"..."}` が返る | **`ical`**（下記のフォールバック） |

`ws` で行ける場合、使いたい関数が有効か確認しておきます。

```bash
T=<上で得たトークン>
curl -s "https://<moodle>/webservice/rest/server.php" \
  -d "wstoken=$T" -d "wsfunction=core_webservice_get_site_info" -d "moodlewsrestformat=json" \
  | grep -o 'core_calendar_get_action_events_by_timesort'
```

**`ical` フォールバック**: Moodle にブラウザでログイン → カレンダー →
「カレンダーをエクスポートする」→ 発行された URL を `MOODLE_ICAL_URL` に使います。
このモードでは提出済み判定ができないので完了は手動ですが、
締切 +24h の自動アーカイブが効くのでタスクが溜まり続けることはありません。

#### SSO（学認 / Shibboleth / Entra ID）で `invalidlogin` になる場合

Web Services が有効でも、SSO 専用アカウントは Moodle 側にローカルパスワードを持たないため
`token.php` は必ず `invalidlogin` を返します。この場合は**ブラウザで一度ログインしてから**
トークンを発行します（多要素認証が要るのはこの 1 回だけ）。

1. ブラウザで Moodle にログインする
2. `https://<moodle>/user/managetoken.php` を開く（設定 → ユーザアカウント → セキュリティキー）
3. **Moodle mobile web service** の行に出ているトークンをコピーする

このページが無効化されている場合は、ログイン状態のまま次の URL を開きます。

```
https://<moodle>/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=1&urlscheme=moodlemobile
```

`moodlemobile://token=xxxxx` へリダイレクトされるので、`token=` 以降をコピーしてデコードします
（`passport:::トークン:::privatetoken` の真ん中がトークン）。

```bash
echo '<コピーした文字列>' | base64 -d; echo
```

この経路で取ったトークンは失効することがあります。失効すると本ボットが Slack に
「Moodle への接続に失敗しました」と 1 日 1 回だけ通知するので、同じ手順で取り直してください。

### 1. 取得と依存関係

```bash
git clone <this repo> && cd slackbot
npm install
```

### 2. Slack アプリを作る

https://api.slack.com/apps → **Create New App** → **From a manifest** で以下を貼ります。

> **Request URL はここでは設定しません。** Worker をまだデプロイしていない段階で URL を書くと、
> Slack が疎通確認に失敗してアプリ作成そのものが通りません。URL は手順 5 の後に設定します。

```yaml
display_information:
  name: Moodle TODO
  description: Moodleの課題をSlackのTODOにして、そのままTogglで時間計測する
  background_color: "#0d6e77"
features:
  bot_user:
    display_name: Moodle TODO
    always_online: true
  app_home:
    home_tab_enabled: true
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
oauth_config:
  scopes:
    bot:
      - chat:write
      - im:write
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

作成したら **Install to Workspace** し、次の 3 つを控えます。

- **Bot User OAuth Token**（`xoxb-...`）— OAuth & Permissions
- **Signing Secret** — Basic Information
- **自分のメンバー ID**（`U...`）— Slack のプロフィール → その他 → メンバー ID をコピー

### 3. Toggl のトークン

https://track.toggl.com/profile の最下部 **API Token** をコピーします。

### 4. D1 を作る

```bash
cp wrangler.toml.example wrangler.toml
npx wrangler d1 create moodle_bot     # 出力された database_id を wrangler.toml に貼る
npx wrangler d1 migrations apply moodle_bot --remote
```

`wrangler.toml` の `[vars]` も自分の環境に合わせます。

```toml
MOODLE_BASE_URL = "https://moodle.example.ac.jp"
MOODLE_MODE = "ws"     # または "ical"
```

### 5. シークレットを登録してデプロイ

対話式のスクリプトを用意してあります。入力は画面にもシェル履歴にも残りません。

```bash
./scripts/setup-secrets.sh
npx wrangler deploy
```

個別に入れる場合は次のとおりです。

```bash
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put SLACK_USER_ID
npx wrangler secret put MOODLE_ICAL_URL     # MOODLE_MODE=ws なら MOODLE_TOKEN
npx wrangler secret put TOGGL_API_TOKEN
```

### 6. Slack に Request URL を設定する

デプロイで表示された URL の末尾に `/slack/events` を付けたものを、Slack アプリ設定の 2 か所に登録します。

| 画面 | 設定 |
|---|---|
| **Event Subscriptions** | Enable Events を On → Request URL に貼る → **Subscribe to bot events** に `app_home_opened` を追加 → Save |
| **Interactivity & Shortcuts** | Interactivity を On → Request URL に貼る → Save |

どちらも **Verified** と出れば完了です。Event Subscriptions でスコープが増えた場合は
**Reinstall to Workspace** を求められるので従ってください。

### 7. 動作確認

```bash
curl https://<your-worker-url>/health
```

`missing` が空になっていれば必須設定は揃っています。足りないものがあれば名前が出ます。

```json
{"ok":true,"moodle_mode":"ical","missing":[],"toggl":"有効","last_sync_at":1788070460}
```

Slack でアプリのホームタブを開き、`🔄 今すぐ同期` を押すと課題が並びます。

---

## ローカル開発

```bash
cp .dev.vars.example .dev.vars     # 値を埋める
cp wrangler.toml.example wrangler.toml
npx wrangler d1 migrations apply moodle_bot --local
npm run dev
curl http://localhost:8787/health
npm run typecheck
```

Cron はローカルでは自動発火しません。手で叩けます。

```bash
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*/15+*+*+*+*"
```

---

## 設定値

| 名前 | 場所 | 説明 |
|---|---|---|
| `MOODLE_BASE_URL` | wrangler.toml | Moodle のベース URL（末尾スラッシュなし） |
| `MOODLE_MODE` | wrangler.toml | `ws` または `ical` |
| `SLACK_TARGET_CHANNEL` | wrangler.toml | 通知先チャンネル。空なら自分への DM |
| `MOODLE_TOKEN` | secret | Web Services のトークン |
| `MOODLE_ICAL_URL` | secret | カレンダーエクスポートの URL |
| `SLACK_SIGNING_SECRET` | secret | リクエスト署名の検証用 |
| `SLACK_BOT_TOKEN` | secret | `xoxb-...` |
| `SLACK_USER_ID` | secret | DM の宛先（自分の `U...`） |
| `TOGGL_API_TOKEN` | secret（任意） | Toggl Track の API トークン。**未設定でも同期・通知・TODO は動く**（計測ボタンだけ無効） |
| `TOGGL_WORKSPACE_ID` | secret（任意） | 省略時は `/me` の既定ワークスペース |

通知の頻度や取得の範囲は [`src/config.ts`](./src/config.ts) の `CONFIG` にまとまっています。

---

## 困ったとき

| 症状 | 原因と対処 |
|---|---|
| Slack が Request URL を Verified にしてくれない | URL の末尾が `/slack/events` か、`SLACK_SIGNING_SECRET` が正しいかを確認 |
| 「Moodle への接続に失敗しました」の DM が届く | トークンが失効している。再発行して `wrangler secret put MOODLE_TOKEN` |
| 課題が 1 件も出てこない | `MOODLE_MODE` と `MOODLE_BASE_URL` を確認し、手順 0 の curl をもう一度叩く |
| 計測が始まらない | Toggl のトークンとワークスペースを確認。`npx wrangler tail` でログを見る |
| 通知が多すぎる / 少なすぎる | `src/config.ts` の `dueSoonSec` `dueTomorrowHourJst` `quiet*` を調整 |

ログは `npx wrangler tail` で追えます。

---

## 構成

```
src/
  index.ts          Worker の入口（fetch = Slack / scheduled = cron 3 本）
  config.ts         環境変数と、挙動を決める定数
  time.ts           JST 変換と表示フォーマット
  db/               D1 の型とリポジトリ層
  moodle/           MoodleClient と 2 実装（webservice / ical）
  toggl/            Toggl API クライアントと計測の開始・停止
  sync/             同期エンジン（reconcile）と通知ポリシー（notify）
  slack/            Block Kit・App Home・ボタンのハンドラ
migrations/         D1 のスキーマ
```
