/**
 * 時間計測サービスの共通インターフェース。
 *
 * Toggl には別系統の製品が 2 つあり、API が互換ではない。
 *   - Toggl Track  … api.track.toggl.com/api/v9、Basic 認証、32 桁のトークン
 *   - Toggl 2.0    … focus.toggl.com/api、Bearer 認証、toggl_sk_ で始まるトークン
 *
 * どちらを使うかはトークンの形で判別できるので、利用者に選ばせない。
 * Moodle と同じく、差異はこのインターフェースの裏に閉じ込める。
 */

export interface RunningEntry {
  id: string;
  description: string | null;
  startedAt: number;
}

export interface StartParams {
  description: string;
  projectId: string | null;
  startedAt: number;
}

export interface TimeTracker {
  readonly kind: "track" | "focus";
  /** 設定が足りていない場合に、何が要るかを返す。空なら使える。 */
  missing(): string[];
  getCurrent(): Promise<RunningEntry | null>;
  start(params: StartParams): Promise<RunningEntry>;
  stop(entryId: string, at: number): Promise<void>;
  /** 科目・分類名からプロジェクトを引く。無ければ作る。対応しない場合は null。 */
  findOrCreateProject(name: string): Promise<string | null>;
  /**
   * 計測が実際に止められた時刻。
   * 計測側で手動停止された場合、検知した時刻で閉じると最大 5 分ぶん水増しになる。
   * 取得できない実装・状況では null を返し、呼び出し側が検知時刻で代用する。
   */
  getStoppedAt(entryId: string): Promise<number | null>;
}

export class TrackerAuthError extends Error {
  constructor() {
    super("Toggl のトークンが無効か、有効期限が切れています");
    this.name = "TrackerAuthError";
  }
}

export class TrackerRateLimitError extends Error {
  constructor() {
    super("Toggl のレート制限に達しました");
    this.name = "TrackerRateLimitError";
  }
}

export class TrackerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrackerError";
  }
}

/** toggl_sk_ で始まるものは Toggl 2.0（Focus）のシークレットキー。 */
export function isFocusToken(token: string): boolean {
  return token.startsWith("toggl_sk_");
}
