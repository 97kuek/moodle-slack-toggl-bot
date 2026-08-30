# Toggl Slack Tasks

Slack をタスクの置き場所にして、そのまま Toggl Track で作業時間を計測するボット。Moodle の課題は自動で取り込む。

- Cloudflare Workers + D1 の**無料枠内で常時稼働**（月額 0 円、PC のスリープに影響されない）
- **1 人 1 デプロイ**。他人の認証情報を預からない
- Moodle・Toggl・通知の設定は**すべて Slack から**変更できる
- Moodle の URL・取得方式・タイムゾーンは設定値。**どの大学でも使える**

設計と構成の詳細は [DESIGN.md](./DESIGN.md)。

---

## できること

**タスクの入口は 2 つ**

- Moodle の課題・締切を 15 分ごとに自動取り込み
- Slack から手動で追加（バイト・研究・自習など、Moodle にないもの）

**Slack がタスクの置き場所**

- App Home に締切順のリスト。`▶︎ 開始` / `✓ 完了` / `😴 明日` / `🗑 削除`
- 完了は 24 時間以内なら `↩︎ 戻す` で取り消せる
- 締切の前日と 3 時間前にリマインド、毎朝ダイジェスト、毎週サマリ
- 同じタイミングの通知は必ず 1 通にまとめる

**Toggl で時間を測る**

- `▶︎ 開始` で計測開始。分類がそのまま Toggl のプロジェクトになる
- 走っている計測があれば自動で止めてから始める
- 週次サマリに分類別の学習時間・完了したタスク・来週の締切が出る

**放っておいても壊れない**

- Moodle 側で提出を検知したら自動で完了（Web Services モードのみ）
- 締切を 24 時間過ぎたタスクは自動でアーカイブ。催促も止まる

## 必要なもの

- Node.js 20 以降
- Cloudflare アカウント（無料。カード不要）
- Slack ワークスペース（アプリを追加できる権限）
- Toggl Track アカウント（任意。無くても通知とタスク管理は動く）
- Moodle アカウント（任意。手動タスクだけでも使える）

---

## セットアップ

### 1. Slack アプリを作る

https://api.slack.com/apps → **Create New App** → **From a manifest** で以下を貼る。

> Request URL はここでは設定しない。Worker が未デプロイの段階で URL を書くと、Slack の疎通確認が失敗してアプリ作成が通らない。手順 4 で設定する。

```yaml
display_information:
  name: Toggl Tasks
  description: SlackのタスクをそのままTogglで計測する
  background_color: "#0d6e77"
features:
  bot_user:
    display_name: Toggl Tasks
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

### 2. デプロイ

```bash
git clone https://github.com/97kuek/toggl-slack-tasks.git
cd toggl-slack-tasks
npm install
./scripts/bootstrap.sh
```

対話で Cloudflare のログイン確認 → D1 作成 → `wrangler.toml` 生成 → スキーマ適用 → デプロイまで行う。最後に Worker の URL が表示される。

### 3. Slack の認証情報を登録

```bash
./scripts/setup-secrets.sh
```

Cloudflare 側に必要なのは **Slack の 3 つだけ**。Moodle と Toggl は手順 5 で Slack から入れる。

### 4. Slack に Request URL を設定

デプロイで表示された URL の末尾に `/slack/events` を付けたものを、2 か所に登録する。

| 画面 | 操作 |
|---|---|
| **Event Subscriptions** | Enable Events を On → URL を貼る → Verified を確認 → **Subscribe to bot events** に `app_home_opened` を追加 → Save |
| **Interactivity & Shortcuts** | Interactivity を On → 同じ URL → Save |

Signing Secret を先に登録していないと Verified にならない。

### 5. Slack から残りを設定

アプリのホームタブを開き、**⚙️ 接続設定** から入力する。

- **Moodle の URL** と **取得方式**（`ical` か `ws`）
- **iCal URL** または **Web Services トークン**（取り方は下記）
- **Toggl の API トークン**（https://track.toggl.com/profile の最下部）

  Toggl には API 互換のない 2 系統があり、トークンの形で自動判別する。
  `toggl_sk_` で始まる場合は **Toggl 2.0** なので、**組織 ID** も必要になる。
  ブラウザの URL `focus.toggl.com/{組織ID}/workspaces/{ワークスペースID}/...` の
  最初の数字がそれ。ワークスペース ID は自動で取れるので設定不要。

  トークンは 1 ユーザー 1 本で、**再発行すると古いものは即座に失効する**。
  生成時に一度しか表示されないので、その場でコピーすること。

**🔔 通知設定** からは、タイムゾーン・各通知の時刻・静音時間・週次サマリの曜日を変更できる。

Moodle を使わず、手動タスクと Toggl だけで使うこともできる。その場合は接続設定を空のままにする。

---

## Moodle の取得方式を決める

`ws`（Web Services）が使えるなら提出済みの自動判定まで動く。使えなければ `ical` で締切だけ取る。

```bash
read -s PW
curl -s "https://<moodle>/login/token.php" \
  --data-urlencode "username=<ユーザ名>" --data-urlencode "password=$PW" \
  -d "service=moodle_mobile_app"
```

| 結果 | モード |
|---|---|
| `{"token":"..."}` | **`ws`** — このトークンを接続設定に入れる |
| `{"error":"invalidlogin"}` | **`ical`** — SSO 環境。下記へ |

**SSO（学認 / Shibboleth / Entra ID）の場合**

SSO 専用アカウントは Moodle 側にローカルパスワードを持たないため、`token.php` は必ず `invalidlogin` を返す。ブラウザでログインしてから次のいずれか。

- `https://<moodle>/user/managetoken.php` → **Moodle mobile web service** のトークンをコピー（`ws` モード）
- 上記が空なら、Moodle のカレンダー → **カレンダーをエクスポートする** →「すべてのイベント」「最近と直近60日」→ URL をコピー（`ical` モード）

`ical` では提出済み判定ができないが、締切 +24h の自動アーカイブが効くのでタスクは溜まり続けない。

---

## 開発

```bash
cp .dev.vars.example .dev.vars
cp wrangler.toml.example wrangler.toml
npx wrangler d1 migrations apply moodle_bot --local

npm run dev          # ローカル起動（http://localhost:8787）
npm run typecheck
npm run tail         # 本番のログ
```

- Cron はローカルでは自動発火しない:
  `curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*/15+*+*+*+*"`
- 手元の `.ics` をパーサに通す（ネットワークにも認証情報にも触れない）:
  `npm run parse:ics -- /path/to/moodle.ics`

---

## 困ったとき

| 症状 | 対処 |
|---|---|
| Request URL が Verified にならない | URL の末尾が `/slack/events` か、`SLACK_SIGNING_SECRET` が登録済みかを確認 |
| ホームタブが空 | `/health` を開いて `missing` を見る。Request URL が未設定なら手順 4 |
| 「Moodle への接続に失敗しました」 | トークンが失効。ホームタブの ⚙️ 接続設定から入れ直す |
| タスクが 1 件も出ない | 接続設定の URL と取得方式を確認。学期外なら課題が無いだけのこともある |
| 計測が始まらない | 接続設定に Toggl のトークンが入っているか確認。`npm run tail` でログを見る |
| 通知が多い / 少ない | ホームタブの 🔔 通知設定から調整 |

`curl https://<your-worker>.workers.dev/health` で `missing` が空なら必須設定は揃っている。

---

## ライセンス

MIT
