# Moodle → Slack TODO + Toggl 時間管理ボット 設計書

Moodle の課題・イベントを定期取得し、Slack を TODO の常設UIとして使い、
そのまま Toggl Track で作業時間を計測するための個人用ボット。

- 想定利用者: **1人1デプロイ**（シングルテナント）。OSS として公開し、他の人は自分の Cloudflare アカウントにデプロイして使う。
- コスト: **完全無料**（Cloudflare Workers / D1 の無料枠内）。
- 常時稼働。ローカルマシンの起動状態に依存しない。

---

## 1. 全体構成

Moodle には Webhook が無く、こちらからイベントを push してもらえない。
したがって **定期ポーリングして差分を検出する同期エンジン** が本システムの中核になる。
ここの設計を誤ると「毎回同じ課題が通知される」「締切変更に気づかない」という致命的な体験になる。

```
                     Cloudflare Workers (無料枠)
  ┌──────────────────────────────────────────────────────┐
  │  scheduled()  ← Cron Triggers x3                     │
  │     ├─ 同期 + リマインド判定   (*/15)                 │
  │     ├─ Toggl 計測中 entry 同期 (*/5)                  │
  │     └─ 朝ダイジェスト          (0 22 * * * = JST 7:00) │
  │                                                      │
  │  fetch()      ← Slack Interactivity / Events         │
  │     └─ ボタン操作・App Home 表示                       │
  └──────────────────────────────────────────────────────┘
        │              │                    │
        ▼              ▼                    ▼
   Moodle API      Cloudflare D1        Slack / Toggl API
   (取得のみ)      (SQLite互換・状態)     (出力・操作)
```

---

## 2. 技術選定

| 領域 | 採用 | 理由 |
|---|---|---|
| 実行基盤 | **Cloudflare Workers** | 無料で常時稼働・HTTPS ドメイン付き・`wrangler deploy` 一発。他人が自分のアカウントに配置するのが容易 |
| DB | **Cloudflare D1** (SQLite互換) | 無料枠 5GB / 書込10万行日。本用途では桁違いに余裕 |
| スケジューラ | **Cron Triggers** | 無料枠3本。外部スケジューラ不要 |
| 言語 | **TypeScript** | Workers 前提。Block Kit の型が効く |
| Slack SDK | **`slack-cloudflare-workers`** | Bolt は Node API 依存で Workers に載らない。こちらは Edge 前提・追加依存ゼロ・**lazy listener 内蔵** |
| DB アクセス | **生の SQL + `wrangler d1 migrations`** | クエリが 20 本程度なので ORM を挟む利点が薄い。D1 本来のマイグレーション運用に乗る（当初 Drizzle を想定したが、実装時に依存を減らす方向へ変更） |
| Moodle | Web Services REST を第一候補、iCal をフォールバック | 後述 |
| Toggl | Toggl Track API v9 | API トークンの Basic 認証 |

### 却下した選択肢

- **Fly.io** — 2026年時点で無料枠廃止（トライアルのみ）
- **Render 無料 / Cloud Run** — アイドルでスリープ。コールドスタートが Slack の3秒応答に間に合わない
- **Oracle Cloud Always Free** — 真に無料で自由度も高いが、登録が弾かれることがあり OS 運用も自分持ち。OSS として他人に配るハードルが高い
- **自宅 Mac + launchd** — スリープで停止するため要件外
- **Slack Socket Mode** — 常駐プロセスが必要で Workers と両立しない。HTTP モードを採用する

### Workers 固有の制約と対処

| 制約 | 対処 |
|---|---|
| CPU 10ms / 呼び出し（無料枠） | fetch の待ち時間は CPU 時間に含まれない。**科目ごとにループして重い処理を積み上げない**設計にする（カレンダーAPI 1回で全件取得）|
| Slack は3秒以内に 200 を返す必要 | `slack-cloudflare-workers` の **lazy listener** で「即 ack → 後追いで処理」 |
| Socket Mode 不可 | Slack アプリの Request URL に `https://<name>.<account>.workers.dev/slack/events` を登録 |
| Cron は **UTC 固定** | JST 変換を config に集約。`0 22 * * *` = JST 7:00 |
| Cron 3本まで | 用途をちょうど3本に収める（上図の通り）|

---

## 3. Moodle からの取得

### 3.1 方式の比較

| 方式 | 取得できるもの | 提出済み判定 | 壊れやすさ |
|---|---|---|---|
| **Web Services REST** | 課題・小テスト・イベント | **可** | 低（大学が WS 無効なら不可）|
| **iCal エクスポート** | 締切とイベントのみ | 不可 | 低 |
| スクレイピング | 何でも | 可 | 高（改修で即死）— **不採用** |

第一候補は Web Services。「提出済みかどうか」が取れるかで TODO の質が別物になる。
iCal だけだと *提出済みの課題も締切まで催促し続ける* ため、手動チェックが必須になり必ず形骸化する。

### 3.2 使用する Web Service 関数

| 関数 | 用途 |
|---|---|
| `core_calendar_get_action_events_by_timesort` | 直近の要対応イベント一覧。**これ1回で大半が済む**（CPU制約の観点でも重要）|
| `core_enrol_get_users_courses` | 科目名・shortname の解決（Toggl プロジェクトに対応させる）|
| `mod_assign_get_submission_status` | 提出済み判定 → 自動クローズ。取得済みタスク分のみ、低頻度で叩く |

### 3.3 抽象化（OSS 化で最重要）

大学ごとに Moodle の事情（Web Services が有効か、SSO か）がバラバラなので、
**その差異をこの1箇所に閉じ込める**。ここを抽象化しないと、他人が使おうとした瞬間に
コード全体を書き換える羽目になる。

```ts
interface MoodleClient {
  fetchUpcoming(): Promise<RawMoodleTask[]>
  fetchSubmissionStatus?(taskIds: string[]): Promise<SubmissionStatus[]>  // WS のみ
}

class WebServiceMoodleClient implements MoodleClient { ... }  // 本命
class ICalMoodleClient       implements MoodleClient { ... }  // SSO で詰んだ人向け
```

`MOODLE_MODE` 環境変数（`ws` | `ical`）で切り替える。
以降のレイヤ（同期・通知・Slack UI・Toggl）は `MoodleClient` の実装差を一切知らない。

### 3.4 実装前に必ず確認すること

大学の Moodle が SSO（学認 / Shibboleth）ログインだと `/login/token.php` が通らないことが多い。
**コードを書く前に以下を確認する。**

```bash
# ① トークンが取れるか（パスワードがシェル履歴に残らないよう read -s を使う）
read -s PW
curl -s "https://<moodle>/login/token.php" \
  -d "username=$USER_ID" --data-urlencode "password=$PW" -d "service=moodle_mobile_app"
```

- `{"token":"..."}` → **Web Services ルート確定**（提出済み自動クローズまで作れる）
- `{"error":"..."}` → SSO か WS 無効。③のフォールバックへ

```bash
# ② 使える関数の確認
curl -s "https://<moodle>/webservice/rest/server.php" \
  -d "wstoken=$T" -d "wsfunction=core_webservice_get_site_info" -d "moodlewsrestformat=json"
# → functions[] に core_calendar_get_action_events_by_timesort があるか

# ③ 本命の取得テスト
curl -s "https://<moodle>/webservice/rest/server.php" \
  -d "wstoken=$T" -d "wsfunction=core_calendar_get_action_events_by_timesort" \
  -d "moodlewsrestformat=json" -d "timesortfrom=$(date +%s)" -d "limitnum=20"
```

**フォールバック**: ブラウザで Moodle にログイン → カレンダー → 「カレンダーをエクスポートする」で
トークン付き iCal URL を発行。これが取れれば最低限は動く（完了は自動判定できない）。

※ SSO 環境でも Moodle モバイルアプリが使えているなら、`/admin/tool/mobile/launch.php` 経由で
トークンを発行できるケースがある。①がエラーでもアプリが動いているなら望みはある。

---

## 4. データモデル（D1）

すべての時刻は **unix 秒 / UTC** で保存。表示と判定のみ表示タイムゾーンに変換する。
オフセットは `TIMEZONE_OFFSET_MIN` で設定でき、`src/time.ts` の外にローカル時刻を漏らさない。

```sql
CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,           -- ULID
  source        TEXT NOT NULL,              -- 'moodle_ws' | 'moodle_ical'
  source_id     TEXT NOT NULL,              -- Moodle event id / iCal UID
  course_id     TEXT,
  course_name   TEXT,                       -- shortname 優先
  title         TEXT NOT NULL,
  kind          TEXT,                       -- 'assign' | 'quiz' | 'event'
  url           TEXT,
  due_at        INTEGER,
  submitted_at  INTEGER,
  status        TEXT NOT NULL DEFAULT 'open',
  snooze_until  INTEGER,
  tracked_sec   INTEGER NOT NULL DEFAULT 0, -- Toggl 実績の積算
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  UNIQUE (source, source_id)
);

CREATE TABLE notifications (
  task_id  TEXT NOT NULL,
  kind     TEXT NOT NULL,                   -- 'new' | 'due_tomorrow' | 'due_3h'
  sent_at  INTEGER NOT NULL,
  slack_ts TEXT,
  PRIMARY KEY (task_id, kind)               -- ← 冪等性の要
);

CREATE TABLE time_sessions (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL,
  toggl_entry_id INTEGER,
  started_at     INTEGER NOT NULL,
  stopped_at     INTEGER,
  duration_sec   INTEGER
);

CREATE TABLE course_project_map (
  course_id        TEXT PRIMARY KEY,
  course_name      TEXT,
  toggl_project_id INTEGER NOT NULL
);

CREATE TABLE kv_state (key TEXT PRIMARY KEY, value TEXT);  -- last_sync_at 等
```

**シングルテナント前提なので `user_id` 列を持たない。** これだけで実装量が半分以下になり、
他人の認証情報を預かる責任も発生しない。将来必要になったら列を足せばよい。

### タスクの状態遷移

```
                  ┌── snooze ──┐
                  ▼            │
  (新規) ──▶ open ──▶ in_progress ──▶ done
                │         │              ▲
                │         └─ 提出検知 ────┘
                │
                ├─ 締切 + 24h ──▶ archived   (自動・催促停止)
                └─ Moodle から消滅 ──▶ removed (講義側で削除)
```

---

## 5. 同期エンジン

15分ごとに実行。

1. `MoodleClient.fetchUpcoming()` で現在の要対応イベントを取得
2. `(source, source_id)` をキーに **upsert**
   - 未知の `source_id` → 新規タスク（`new` 通知の対象）
   - 既知 → `title` / `due_at` を更新。**`due_at` が変わったら送信済みの締切通知を削除**して再通知対象に戻す
   - `last_seen_at` を更新
3. **消滅検出**: 前回見えていて今回見えないタスク → `removed`（講義側で削除された）
   - ただし誤判定を避けるため、対象は **締切がまだ未来** かつ **取得窓の内側** のものだけに絞る。
     締切を過ぎた課題は Moodle の一覧から自然に消えるので、これを削除扱いにすると
     下の「締切 +24h で自動アーカイブ」が効かなくなる
4. 提出済み判定（WS モードのみ、1時間に1回程度）: `mod_assign_get_submission_status` で
   `submitted` なら `done` に自動遷移
5. 締切を24時間過ぎた `open` / `in_progress` → `archived`

すべての操作は冪等。途中で失敗しても次回の cron で自然に回復する。

---

## 6. 通知ポリシー

**ここを雑に作ると3日でミュートされる。** 設計上、Moodle 取得と同じくらい重要。

### 6.1 送るもの

| 種別 | タイミング | 内容 |
|---|---|---|
| `new` | 検出直後 | 新しい課題が出た |
| `due_tomorrow` | 前日 21:00 JST | 明日締切 |
| `due_3h` | 締切3時間前 | 最終警告。これだけ強めの表現 |
| ダイジェスト | 毎朝 7:00 | 今日〜3日以内の一覧 + App Home へのリンク |
| 週次サマリ | 毎週日曜 21:00 | 科目別の学習時間、今週完了した課題、来週の締切 |

1課題あたり DM は **最大3通**。当初案の「3日前」通知は朝ダイジェストと役割が重複するため削除した。

### 6.2 必須の仕掛け

- **バッチング**: 同一タイミングで複数課題が該当する場合、**必ず1通にまとめる**。
  課題5件が別々に届いた時点でミュートされる。
- **静音時間**: JST 0:00–7:00 は送信せず、朝のダイジェストに合流させる。
- **スヌーズ中**は `due_3h` を除きスキップ。
- **冪等性**: `notifications(task_id, kind)` の PRIMARY KEY で二重送信を防ぐ。
  手順は「`INSERT OR IGNORE` → 挿入できた場合のみ送信 → 送信失敗なら行を削除」。
  これで重複送信を確実に防ぎ、失敗時は次回 cron で再試行される。

### 6.4 週次サマリを Slack に出す理由

時間計測の集計は Toggl のダッシュボードでも見られるが、**外部の画面は「見に行く」必要があるため続かない**。
同じ内容を週に 1 度だけ Slack に届けるほうが実際に目に入る。

cron は無料枠 3 本を使い切っているため、15 分ごとの同期に相乗りさせ、
送信済みかどうかは `kv_state` で管理する。発火を取りこぼしても次の tick で送られ、
二重送信もしない。学習時間も完了も締切も無い週は送らない。

### 6.3 送らないもの

- 同期の成功ログ、変化のない状態、「タスクはありません」の類。すべてノイズ。

---

## 7. Slack UI

### 7.1 App Home が主役

**チャンネルや DM に通知を流すだけにしない。** 流れて消えるので TODO にならない。
App Home タブを常設の TODO リストとして使う。

```
┌─────────────────────────────────────────┐
│  📚 今日の学習   1h 24m                  │
│  🔴 計測中: レポート課題3 (32m)   [⏹ 停止] │
├─────────────────────────────────────────┤
│  ⚠️ 今日締切                             │
│  ・線形代数 / 小テスト2      23:59        │
│      [▶️ 開始] [✅ 完了] [😴 明日] [🔗]    │
│                                          │
│  📅 明日以降                              │
│  ・ソフトウェア工学 / レポート3  9/2 17:00 │
│      [▶️ 開始] [✅ 完了] [😴 明日] [🔗]    │
│  ...                                     │
├─────────────────────────────────────────┤
│  最終同期: 3分前            [🔄 今すぐ同期] │
└─────────────────────────────────────────┘
```

- 締切順、日付でグルーピング（今日 / 明日 / 今週 / それ以降）
- 上部に「今日の学習時間」と「計測中タスク」を常時表示
- `app_home_opened` イベントで `views.publish` を呼んで再描画

### 7.2 DM は通知のみ

イベント発火時だけ。各メッセージにも同じボタンを付け、Home を開かずに操作できるようにする。

### 7.3 Slack アプリ設定

- **Bot Token Scopes**: `chat:write`, `im:write`
- **Event Subscriptions**: `app_home_opened`
- **App Home**: Home Tab を有効化
- **Interactivity**: Request URL に Worker のエンドポイントを登録

- **Request URL**: `https://<name>.<account>.workers.dev/slack/events`（Events / Interactivity 共通）

スラッシュコマンドは実装していないので `commands` スコープは不要。

---

## 8. Toggl 連携

Toggl Track API v9。認証は API トークンの Basic 認証（`<token>:api_token`）。

**Toggl は任意。** 時間データの正は常にローカルの `time_sessions` で、Toggl はその鏡。
トークン未設定でも Moodle の同期・通知・TODO はそのまま動き、計測ボタンだけが
「未設定です」と返す。この構造にしてあるので、Toggl を使うか自前で完結させるかは
後からいつでも変えられる。

### 8.1 操作の流れ

- **`▶️ 開始`** → 走っている entry があれば自動 stop → 新規 entry を開始
  - description = 課題名、project = 科目、tag = `moodle`
  - `time_sessions` に記録し、タスクを `in_progress` へ
- **`⏹ 停止`** / **`✅ 完了`** → entry を stop、`duration_sec` を `tasks.tracked_sec` に積算

### 8.2 科目 ⇄ プロジェクトの対応

**自動生成する。** 初回同期時に Moodle の科目 `shortname` で Toggl プロジェクトを検索し、
無ければ作成して `course_project_map` に保存。ユーザーに手動設定を求めない。

これにより **Toggl 側のレポートがそのまま「科目別の勉強時間」になる**。本システムで最も価値の高い部分。

### 8.3 同期は片方向

- **操作は Slack 起点のみ**（Slack → Toggl）
- Toggl → Slack は**表示の同期だけ**。5分ごとに `/me/time_entries/current` を見て
  App Home の「計測中」表示を更新する
- 双方向に書き込むと競合解決が泥沼になるため、意図的に制限する

---

## 9. 完了判定の UX

**「完了ボタンを押さないと残り続ける」設計にしない。**
TODO アプリが形骸化する最大の原因は未完了タスクの堆積であり、時間経過で勝手に消えるほうが正しい。

| 状況 | 挙動 |
|---|---|
| WS モードで提出を検知 | **自動で `done`**。ユーザー操作不要 |
| 締切を24時間経過 | **自動で `archived`**。催促も自動停止 |
| `due_3h` 通知 | 「提出した？」を**1回だけ**聞く。押さなければ黙る |
| Toggl 実績が20分超のタスク | 「着手済み」バッジを表示。**完了は推定しない** |

iCal モードでも「手動チェックしないと溜まり続ける」状態にはならない。

---

## 10. 失敗時の挙動

| 失敗 | 対処 |
|---|---|
| Moodle トークン失効（401） | DM で再設定を促す。**1日1回まで**（連投しない） |
| Moodle 一時的なエラー | 何もせず次回 cron へ。通知はしない |
| Toggl レート制限（429） | リトライせず次回へ。Slack には「計測開始に失敗」とだけ返す |
| Slack API 失敗 | `notifications` の行を削除して次回再試行 |
| D1 書き込み失敗 | 全操作が冪等なので次回 cron で自然回復 |
| CPU 10ms 超過 | 1回の同期で処理する件数に上限を設け、続きは次の cron で処理 |

---

## 11. リポジトリ構成

```
src/
  index.ts              # Worker entry: fetch() + scheduled()
  config.ts             # 環境変数・JST 変換・通知時刻の定数
  slack/
    app.ts              # slack-cloudflare-workers のハンドラ登録
    views/home.ts       # App Home の Block Kit
    views/blocks.ts     # タスクカードなど共通パーツ
  time.ts               # JST 変換と表示フォーマット
  moodle/
    client.ts           # interface MoodleClient
    webservice.ts       # WebServiceMoodleClient
    ical.ts             # ICalMoodleClient
    normalize.ts        # Moodle 生データ → Task への正規化
  toggl/client.ts
  sync/
    reconcile.ts        # upsert + 消滅検出
    notify.ts           # 通知ポリシー・バッチング
  db/
    types.ts            # 行の型
    repo.ts             # D1 への薄いリポジトリ層
migrations/             # D1 のスキーマ（wrangler d1 migrations apply）
wrangler.toml.example   # MOODLE_BASE_URL, MOODLE_MODE, cron 定義
.dev.vars.example
DESIGN.md
README.md               # セットアップ手順（Moodle 疎通確認 → Slack アプリ作成 → deploy）
```

### シークレット

すべて `wrangler secret put` で管理し、リポジトリには `.example` のみを置く。

- `MOODLE_TOKEN`（または `MOODLE_ICAL_URL`）
- `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET`
- `TOGGL_API_TOKEN`
- `SLACK_USER_ID`（DM 送信先＝自分）

---

## 12. 実装の順序

各段階で「動くもの」が手に入るように区切る。

| # | 内容 | 完了条件 |
|---|---|---|
| **M0** | **Moodle 疎通確認**（3.4 の curl） | WS / iCal どちらで行くか確定。**ここが全ての前提** |
| M1 | `MoodleClient` + 正規化 + D1 保存 | `wrangler dev` でタスク一覧の JSON が返る |
| M2 | DM 通知（`new` + 締切） | **この時点で既に実用**。ボタンはまだ無くてよい |
| M3 | App Home + ボタン（完了 / スヌーズ） | Slack 上で TODO が完結する |
| M4 | Toggl 開始 / 停止 | 科目別の勉強時間が Toggl に溜まり始める |
| M5 | 提出済み自動クローズ・朝ダイジェスト・バッチング | 通知が実用的な量に収まる |

M2 まで到達すれば日常的に使える。M5 は使いながら調整する領域。

---

## 13. 意図的に作らないもの

- **マルチユーザー / OAuth インストールフロー** — 1人1デプロイで十分。他人の認証情報を預からない
- **Toggl → Slack の双方向書き込み** — 競合解決のコストに見合わない
- **スクレイピングによる Moodle 取得** — Moodle 改修のたびに壊れる
- **カレンダー表示・ガントチャート等の凝った UI** — Slack の Block Kit で無理をしない
- **同期成功のログ通知** — ノイズにしかならない
