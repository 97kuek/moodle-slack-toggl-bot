# Moodle → Slack TODO Bot

Moodle の課題・締切を定期取得して Slack を常設の TODO にし、そのまま Toggl Track で作業時間を計測する個人用ボット。

- Cloudflare Workers + D1 の**無料枠内で常時稼働**（月額 0 円、PC のスリープに影響されない）
- **1 人 1 デプロイ**。他人の認証情報を預からない
- Moodle の URL・取得方式・タイムゾーンはすべて設定値。**どの大学でも使える**

設計と構成の詳細は [DESIGN.md](./DESIGN.md) を参照。

---

## できること

- 新しい課題を検出したら Slack に通知（同時に複数出ても 1 通にまとめる）
- 締切の前日 21:00 と 3 時間前にリマインド
- 毎朝 7:00 に 3 日以内のダイジェスト
- 毎週日曜 21:00 に週次サマリ（科目別の学習時間・完了した課題・来週の締切）
- App Home に締切順の TODO リスト（`▶︎ 開始` / `✓ 完了` / `😴 明日` / `🔗 Moodle`）
- `▶︎ 開始` で Toggl の計測を開始（科目 = プロジェクト、tag = `moodle`）
- Moodle 側で提出を検知したら自動で完了（Web Services モードのみ）
- 締切を 24 時間過ぎたタスクは自動でアーカイブ

## 必要なもの

- Node.js 20 以降
- Cloudflare アカウント（無料。カード不要）
- Slack ワークスペース（アプリを追加できる権限）
- Toggl Track アカウント（任意。無くても通知と TODO は動く）

---

## セットアップ

### 0. Moodle に繋がるか確かめる

**ここで取得方式が決まる。コードを書く前に必ず確認する。**

```bash
read -s PW
curl -s "https://<moodle>/login/token.php" \
  --data-urlencode "username=<ユーザ名>" --data-urlencode "password=$PW" \
  -d "service=moodle_mobile_app"
```

| 結果 | モード | 備考 |
|---|---|---|
| `{"token":"..."}` | `ws` | 推奨。提出済みの自動判定まで動く |
| `{"error":"invalidlogin"}` | `ical` | SSO 環境。下記フォールバックへ |

**SSO（学認 / Shibboleth / Entra ID）の場合**

SSO 専用アカウントは Moodle 側にローカルパスワードを持たないため、`token.php` は必ず `invalidlogin` を返す。次のいずれかで対応する。

- ブラウザでログイン → `https://<moodle>/user/managetoken.php` → **Moodle mobile web service** のトークンをコピー（`ws` モード）
- 上記が空なら、ログイン状態のまま Moodle のカレンダー → **カレンダーをエクスポートする** → 「すべてのイベント」「最近と直近60日」→ URL を取得（`ical` モード）

`ical` モードでは提出済み判定ができないが、締切 +24h の自動アーカイブが効くのでタスクは溜まり続けない。

### 1. 取得とインストール

```bash
git clone https://github.com/97kuek/moodle-slack-toggl-bot.git
cd moodle-slack-toggl-bot
npm install
```

### 2. Slack アプリを作る

https://api.slack.com/apps → **Create New App** → **From a manifest** で以下を貼る。

> Request URL はここでは設定しない。Worker が未デプロイの段階で URL を書くと、Slack の疎通確認が失敗してアプリ作成が通らない。手順 6 で設定する。

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

**Install to Workspace** してから次の 3 つを控える。

- **Bot User OAuth Token**（`xoxb-...`）— OAuth & Permissions
- **Signing Secret** — Basic Information → App Credentials
- **自分のメンバー ID**（`U...`）— Slack のプロフィール → その他 → メンバー ID

### 3. Toggl のトークン（任意）

https://track.toggl.com/profile の最下部 **API Token** をコピーする。未設定でも通知と TODO は動く。

### 4. デプロイ

```bash
./scripts/bootstrap.sh
```

対話で次を実行する。

- Cloudflare のログイン確認
- Worker 名・Moodle URL・取得方式・タイムゾーンの設定
- D1 データベースの作成と `wrangler.toml` の生成
- スキーマの適用
- デプロイ（Worker の URL が表示される）

### 5. シークレットの登録

```bash
./scripts/setup-secrets.sh
```

入力は画面にもシェル履歴にも残らない。空 Enter でスキップできる。

### 6. Slack に Request URL を設定

デプロイで表示された URL の末尾に `/slack/events` を付けたものを、2 か所に登録する。

| 画面 | 操作 |
|---|---|
| **Event Subscriptions** | Enable Events を On → URL を貼る → Verified を確認 → **Subscribe to bot events** に `app_home_opened` を追加 → Save |
| **Interactivity & Shortcuts** | Interactivity を On → 同じ URL → Save |

Signing Secret を先に登録していないと Verified にならない。

### 7. 確認

```bash
curl https://<your-worker>.workers.dev/health
```

- `"missing": []` になっていれば必須設定は揃っている
- 足りないものがあれば名前が出る

Slack でアプリのホームタブを開き `🔄 今すぐ同期` を押すと課題が並ぶ。

---

## 開発

```bash
cp .dev.vars.example .dev.vars     # 値を埋める
cp wrangler.toml.example wrangler.toml
npx wrangler d1 migrations apply moodle_bot --local

npm run dev          # ローカル起動（http://localhost:8787）
npm run typecheck    # 型チェック
npm run tail         # 本番のログを追う
```

- Cron はローカルでは自動発火しない。手動で叩く:
  `curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*/15+*+*+*+*"`
- 手元の `.ics` をパーサに通して確認する（ネットワークにも認証情報にも触れない）:
  `npm run parse:ics -- /path/to/moodle.ics`

---

## 困ったとき

| 症状 | 対処 |
|---|---|
| Request URL が Verified にならない | URL の末尾が `/slack/events` か、`SLACK_SIGNING_SECRET` が登録済みかを確認 |
| 「Moodle への接続に失敗しました」の DM | トークンが失効している。再発行して `wrangler secret put MOODLE_TOKEN` |
| 課題が 1 件も出てこない | `MOODLE_MODE` と `MOODLE_BASE_URL` を確認し、手順 0 の curl を再実行 |
| 計測が始まらない | `TOGGL_API_TOKEN` を確認。`npm run tail` でログを見る |
| 通知が多い / 少ない | [`src/config.ts`](./src/config.ts) の `CONFIG` を調整 |

---

## ライセンス

MIT
