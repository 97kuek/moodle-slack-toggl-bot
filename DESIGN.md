# 設計と構成

セットアップ手順は [README.md](./README.md) を参照。ここには「なぜそう作ったか」と内部構成をまとめる。

---

## 全体構成

Moodle には Webhook が無く、イベントを push してもらえない。したがって**定期ポーリングして差分を検出する同期エンジン**が中核になる。ここを誤ると「毎回同じ課題が通知される」「締切変更に気づかない」という致命的な体験になる。

```
                Cloudflare Workers（無料枠）
  ┌────────────────────────────────────────────┐
  │ scheduled()  ← Cron Triggers ×3            │
  │   */15  同期 + リマインド + 週次サマリ        │
  │   */5   Toggl の計測状態を App Home に反映    │
  │   0 22  朝のダイジェスト（= JST 07:00）       │
  │                                            │
  │ fetch()      ← Slack Interactivity / Events│
  │   ボタン操作・App Home・署名検証              │
  └────────────────────────────────────────────┘
     │           │                    │
   Moodle       D1              Slack / Toggl
  （取得のみ）  （状態）           （出力・操作）
```

---

## 技術選定

| 領域 | 採用 | 理由 |
|---|---|---|
| 実行基盤 | Cloudflare Workers | 無料で常時稼働・HTTPS ドメイン付き・`wrangler deploy` 一発 |
| DB | Cloudflare D1（SQLite 互換） | 無料枠 5GB / 書込 10 万行日。本用途では桁違いに余裕 |
| スケジューラ | Cron Triggers | 無料枠 3 本。外部スケジューラ不要 |
| 言語 | TypeScript | Workers 前提。Block Kit の型が効く |
| Slack SDK | `slack-cloudflare-workers` | Bolt は Node API 依存で Workers に載らない。Edge 前提・追加依存ゼロ・lazy listener 内蔵 |
| DB アクセス | 生の SQL + `wrangler d1 migrations` | クエリが 20 本程度で ORM を挟む利点が薄い。D1 本来の運用に乗る |

**却下した選択肢**

- **Fly.io** — 2026 年時点で無料枠廃止（トライアルのみ）
- **Render 無料 / Cloud Run** — アイドルでスリープ。コールドスタートが Slack の 3 秒応答に間に合わない
- **Oracle Cloud Always Free** — 真に無料だが登録が弾かれることがあり、OS 運用も自分持ち。配布のハードルが高い
- **Slack Socket Mode** — 常駐プロセスが必要で Workers と両立しない

**Workers 固有の制約と対処**

- **CPU 10ms / 呼び出し** — fetch の待ち時間は CPU 時間に含まれない。科目ごとにループして重い処理を積み上げず、カレンダー API 1 回で全件取得する
- **Slack は 3 秒以内に 200** — lazy listener で「即 ack → 後追いで処理」
- **Socket Mode 不可** — HTTP モード。Request URL は `/slack/events` に固定
- **Cron は UTC 固定** — ローカル時刻の変換は `src/time.ts` にだけ閉じ込める
- **Cron 3 本まで** — 週次サマリは新設せず、15 分同期に相乗りさせる

---

## Moodle からの取得

| 方式 | 取得できるもの | 提出済み判定 | 壊れやすさ |
|---|---|---|---|
| Web Services REST | 課題・小テスト・イベント | 可 | 低（大学が WS 無効なら不可） |
| iCal エクスポート | 締切とイベントのみ | 不可 | 低 |
| スクレイピング | 何でも | 可 | 高 — **不採用** |

- 第一候補は Web Services。「提出済みかどうか」が取れるかで TODO の質が別物になる
- iCal だけだと提出済みの課題も締切まで催促し続け、手動チェックが必須になり形骸化する

**使う Web Service 関数**

- `core_calendar_get_action_events_by_timesort` — 要対応イベント一覧。これ 1 回で大半が済む
- `core_enrol_get_users_courses` — 科目名の解決（Toggl プロジェクト名になる）
- `mod_assign_get_submission_status` — 提出済み判定。1 件 1 リクエストなので回数を絞る

**抽象化がこの設計の要**

- 大学ごとに事情（WS が有効か、SSO か）がバラバラなので、差異を `MoodleClient` 1 箇所に閉じ込める
- `WebServiceMoodleClient` / `ICalMoodleClient` の 2 実装を `MOODLE_MODE` で切り替える
- 同期・通知・Slack UI・Toggl の各レイヤは実装差を一切知らない
- ここを抽象化しないと、他人が使おうとした瞬間にコード全体を書き換える羽目になる

**iCal パーサが実データに合わせている点**

- 行の折り返し（次行が空白始まり）を復元する。URL が途中で折れていても拾える
- `URL` プロパティを出さない Moodle があるため、`DESCRIPTION` からもリンクを抽出する
- それも無ければその日のカレンダーにフォールバックする
- SUMMARY 末尾の `(課題終了)` `(小テスト終了)` から種別を判定し、タイトルからは除去する
- `CATEGORIES` は分割せず全体を科目名に使う。`英語名/日本語名` と `科目名/対象学部` が混在していて、どちらが科目名か一般には判定できないため（誤って切ると Toggl のプロジェクト名が黙って別物になる）
- 末尾の科目コード `(2019ZZ2600000126)` だけは除去する（英大文字と数字のみ・8 文字以上に限定）

---

## データモデル

- すべての時刻は **unix 秒 / UTC** で保存。表示と判定のみ表示タイムゾーンに変換する
- **シングルテナント前提なので `user_id` 列を持たない。** 実装量が半分以下になり、他人の認証情報を預かる責任も発生しない

| テーブル | 役割 |
|---|---|
| `tasks` | Moodle 由来のタスク。`(source, source_id)` で一意 |
| `notifications` | 送信済みの記録。`(task_id, kind)` が PRIMARY KEY で冪等性の要 |
| `time_sessions` | 計測の開始・停止。**時間データの正はここ**で、Toggl はその鏡 |
| `course_project_map` | 科目 ⇄ Toggl プロジェクトの対応 |
| `kv_state` | `last_sync_at` などの雑多な状態 |

**タスクの状態遷移**

```
              ┌── snooze ──┐
              ▼            │
(新規) ──▶ open ──▶ in_progress ──▶ done
            │           │             ▲
            │           └─ 提出検知 ───┘
            │
            ├─ 締切 +24h ──────▶ archived   (自動・催促停止)
            └─ Moodle から消滅 ──▶ removed    (講義側で削除)
```

---

## 同期エンジン

15 分ごとに実行。すべての操作は冪等で、失敗しても次の cron が同じ結果に収束させる。

- 1 回だけ SELECT してメモリ上で差分を取り、書き込みは `batch()` にまとめる
- 未知の `source_id` → 新規タスク（`new` 通知の対象）
- 既知 → 内容を更新。**締切が変わったら送信済みの締切通知を削除**して再通知対象に戻す
- 変化が無かったものも含め、「今回見えた」印は 1 文で更新する
- 締切 +24h 経過 → `archived`
- 提出済み判定（WS のみ、1 時間に 1 回・8 件まで）→ `done`

**消滅検出の条件**

講義側で削除されたタスクを `removed` にするが、次の 2 つを満たすものだけに絞る。

- **締切がまだ未来** — 締切を過ぎた課題は Moodle の一覧から自然に消える。これを削除扱いにすると「締切 +24h で自動アーカイブ」が効かなくなる
- **締切が取得窓の内側** — `lookaheadDays` より先の課題は「今回見えなかった」だけで消えたわけではない

---

## 通知ポリシー

**ここを雑に作ると 3 日でミュートされる。** Moodle 取得と同じくらい重要。

| 種別 | タイミング | 内容 |
|---|---|---|
| `new` | 検出直後 | 新しい課題が出た |
| `due_tomorrow` | 前日 21:00 | 明日締切 |
| `due_3h` | 締切 3 時間前 | 最終警告。これだけスヌーズを無視する |
| ダイジェスト | 毎朝 7:00 | 今日〜3 日以内の一覧 |
| 週次サマリ | 毎週日曜 21:00 | 科目別の学習時間・完了した課題・来週の締切 |

**必須の仕掛け**

- **バッチング** — 同一タイミングで複数該当したら必ず 1 通にまとめる。5 件が別々に届いた時点でミュートされる
- **静音時間** — 0:00–7:00 は送らず、朝のダイジェストに合流させる
- **冪等性** — `INSERT OR IGNORE` で権利を取り、取れた場合のみ送信。送信失敗なら行を削除して次回再試行
- 1 課題あたり DM は最大 3 通

**送らないもの**

- 同期の成功ログ、変化のない状態、「タスクはありません」の類
- 学習時間も完了も締切も無い週の週次サマリ

**週次サマリを Slack に出す理由**

- 集計は Toggl のダッシュボードでも見られるが、**外部の画面は「見に行く」必要があるため続かない**
- 週に 1 度だけ届けるほうが実際に目に入る
- cron は 3 本を使い切っているので 15 分同期に相乗りさせ、送信済みかは `kv_state` で管理する。取りこぼしても次の tick で送られ、二重送信もしない

---

## Slack UI

- **App Home が主役。** チャンネルや DM に流すだけだと流れて消えて TODO にならない
- 締切順に、日付でグルーピング（今日 / 明日 / 今週 / それ以降）
- 上部に「今日の学習時間」と「計測中タスク」を常時表示
- DM はイベント発火時のみ。同じボタンを付けて Home を開かずに操作できる
- `app_home_opened` で `views.publish` を呼んで再描画

**Slack アプリ設定**

- Bot Token Scopes: `chat:write`, `im:write`（スラッシュコマンドは作らないので `commands` は不要）
- Event Subscriptions: `app_home_opened`
- Request URL: `/slack/events`（Events と Interactivity で共通）

---

## Toggl 連携

- Toggl Track API v9。認証は API トークンの Basic 認証（`<token>:api_token`）
- `▶︎ 開始` → 走っている entry があれば自動 stop → 新規開始（description = 課題名、project = 科目、tag = `moodle`）
- 科目 ⇄ プロジェクトは**自動生成**。ユーザーに手動マッピングを求めない
- Toggl のレポートがそのまま「科目別の勉強時間」になる

**同期は片方向**

- 操作は Slack 起点のみ（Slack → Toggl）
- Toggl → Slack は表示の同期だけ。5 分ごとに `/me/time_entries/current` を見て「計測中」表示を更新する
- 双方向に書き込むと競合解決が泥沼になるため、意図的に制限する

**Toggl は任意**

- 時間データの正は常にローカルの `time_sessions`。Toggl はその鏡
- トークン未設定でも同期・通知・TODO は動き、計測ボタンだけが「未設定です」と返す
- Toggl を使うか自前で完結させるかは、後からいつでも変えられる

---

## 完了判定の UX

**「完了ボタンを押さないと残り続ける」設計にしない。** TODO が形骸化する最大の原因は未完了タスクの堆積で、時間経過で勝手に消えるほうが正しい。

| 状況 | 挙動 |
|---|---|
| WS モードで提出を検知 | 自動で `done`。操作不要 |
| 締切を 24 時間経過 | 自動で `archived`。催促も停止 |
| `due_3h` 通知 | 「提出した？」を 1 回だけ聞く。押さなければ黙る |
| 実績が 20 分を超えたタスク | 「着手済み」バッジを表示。**完了は推定しない** |

---

## 失敗時の挙動

| 失敗 | 対処 |
|---|---|
| Moodle トークン失効（401） | DM で再設定を促す。**1 日 1 回まで** |
| Moodle の一時的なエラー | 何もせず次回 cron へ。通知しない |
| Toggl レート制限（429） | リトライせず次回へ。Slack には「計測開始に失敗」とだけ返す |
| Slack API 失敗 | `notifications` の行を削除して次回再試行 |
| D1 書き込み失敗 | 全操作が冪等なので次回 cron で自然回復 |
| CPU 10ms 超過 | 1 回の同期で扱う件数に上限を設け、続きは次の cron で処理 |

---

## 設定値

| 名前 | 場所 | 説明 |
|---|---|---|
| `MOODLE_BASE_URL` | wrangler.toml | Moodle のベース URL（末尾スラッシュなし） |
| `MOODLE_MODE` | wrangler.toml | `ws` または `ical` |
| `TIMEZONE_OFFSET_MIN` | wrangler.toml | 表示・判定に使う UTC オフセット（分）。`540` = 日本 |
| `SLACK_TARGET_CHANNEL` | wrangler.toml | 通知先チャンネル。空なら自分への DM |
| `MOODLE_TOKEN` | secret | Web Services のトークン |
| `MOODLE_ICAL_URL` | secret | カレンダーエクスポートの URL |
| `SLACK_SIGNING_SECRET` | secret | リクエスト署名の検証用 |
| `SLACK_BOT_TOKEN` | secret | `xoxb-...` |
| `SLACK_USER_ID` | secret | DM の宛先（自分の `U...`） |
| `TOGGL_API_TOKEN` | secret（任意） | 未設定でも同期・通知・TODO は動く |

- 通知の頻度・取得範囲・週次サマリの曜日は [`src/config.ts`](./src/config.ts) の `CONFIG`
- 日本以外で使う場合は `TIMEZONE_OFFSET_MIN` に加え、`wrangler.toml` の `crons`（UTC 指定）も調整する

---

## ディレクトリ構成

```
src/
  index.ts          Worker の入口（fetch = Slack / scheduled = cron 3 本）
  config.ts         環境変数と、挙動を決める定数
  time.ts           タイムゾーン変換と表示フォーマット
  db/               D1 の型と薄いリポジトリ層
  moodle/           MoodleClient と 2 実装（webservice / ical）
  toggl/            API クライアントと計測の開始・停止
  sync/             同期エンジン（reconcile）と通知ポリシー（notify）
  slack/            Block Kit・App Home・ボタンのハンドラ
migrations/         D1 のスキーマ
scripts/
  bootstrap.sh      D1 作成 → wrangler.toml 生成 → デプロイ
  setup-secrets.sh  シークレットの一括登録
  parse-ics.ts      手元の .ics をパーサに通す（ネットワーク不使用）
```

---

## 意図的に作らないもの

- **マルチユーザー / OAuth インストールフロー** — 1 人 1 デプロイで十分。他人の認証情報を預からない
- **Toggl → Slack の双方向書き込み** — 競合解決のコストに見合わない
- **スクレイピングによる Moodle 取得** — Moodle 改修のたびに壊れる
- **カレンダー表示・ガントチャート** — Slack の Block Kit で無理をしない
- **同期成功のログ通知** — ノイズにしかならない
