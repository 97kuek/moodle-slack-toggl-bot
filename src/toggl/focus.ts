import { formatDateOnly, toIso } from "../time";
import {
  TrackerAuthError,
  TrackerError,
  TrackerRateLimitError,
  type RunningEntry,
  type StartParams,
  type TimeTracker,
  type TrackedRange,
} from "./tracker";

/**
 * Toggl 2.0（Toggl Focus）用のクライアント。
 *
 *   ベース   https://focus.toggl.com/api
 *   認証     Authorization: Bearer toggl_sk_...
 *   計測     /organizations/{org}/workspaces/{ws}/tracking/{current,start,stop}
 *
 * workspace_id は /users/me/settings から自動で取れるが、organization_id を返す
 * エンドポイントが存在しないため、これだけは設定してもらう必要がある。
 */

const BASE = "https://focus.toggl.com/api";

/** 実績の取得は 1 週間ぶん。200 × 5 ページあれば足りる。 */
const PAGE_SIZE = 200;
const MAX_PAGES = 5;

interface FocusTimeEntry {
  id: string | number;
  description?: string | null;
  start: string;
  end?: string | null;
  project_id?: string | number | null;
  /** ミリ秒。Track（秒）と単位が違う */
  duration?: number | null;
  /** "activity" が実作業。"break" は休憩なので集計から外す */
  type?: string | null;
  deleted_at?: string | null;
}

interface FocusProject {
  id: string | number;
  name: string;
}

function projectIdField(projectId: string | null): { project_id?: number } {
  if (!projectId) return {};
  const n = Number(projectId);
  return Number.isFinite(n) ? { project_id: n } : {};
}

export class TogglFocusClient implements TimeTracker {
  readonly kind = "focus" as const;
  private workspaceId: string | null;

  constructor(
    private readonly token: string,
    private readonly organizationId: string | null,
    workspaceId: string | null,
  ) {
    this.workspaceId = workspaceId;
  }

  missing(): string[] {
    return this.organizationId ? [] : ["Toggl の組織 ID"];
  }

  private async call<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T | null> {
    const res = await fetch(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

    if (res.status === 401 || res.status === 403) throw new TrackerAuthError();
    if (res.status === 429) throw new TrackerRateLimitError();
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new TrackerError(`Toggl が HTTP ${res.status} を返しました (${path}) ${detail.slice(0, 200)}`);
    }
    const text = await res.text();
    if (!text || text === "null") return null;
    return JSON.parse(text) as T;
  }

  /** ワークスペースは利用者の設定から自動で解決する。 */
  private async getWorkspaceId(): Promise<string> {
    if (this.workspaceId) return this.workspaceId;
    const s = await this.call<{ current_workspace_id?: number | string }>("/users/me/settings");
    const id = s?.current_workspace_id;
    if (!id) throw new TrackerError("Toggl のワークスペースを特定できませんでした");
    this.workspaceId = String(id);
    return this.workspaceId;
  }

  private async scope(): Promise<string> {
    if (!this.organizationId) {
      throw new TrackerError(
        "Toggl の組織 ID が未設定です。「接続設定」から登録してください。",
      );
    }
    return `/organizations/${this.organizationId}/workspaces/${await this.getWorkspaceId()}`;
  }

  private toEntry(e: FocusTimeEntry): RunningEntry {
    return {
      id: String(e.id),
      description: e.description ?? null,
      startedAt: Math.floor(Date.parse(e.start) / 1000),
    };
  }

  async getCurrent(): Promise<RunningEntry | null> {
    const e = await this.call<FocusTimeEntry>(`${await this.scope()}/tracking/current`);
    return e && e.id !== undefined ? this.toEntry(e) : null;
  }

  async start(params: StartParams): Promise<RunningEntry> {
    const scope = await this.scope();
    const current = await this.getCurrent();
    if (current) await this.stop(current.id, params.startedAt);

    const e = await this.call<FocusTimeEntry>(`${scope}/tracking/start`, {
      method: "POST",
      body: {
        start: toIso(params.startedAt),
        type: "activity",
        description: params.description.slice(0, 200),
        // API は project_id を int64 で受ける。id は実装間で文字列に揃えているので、
        // ここで数値に戻す（数値にできないものは送らない）。
        ...projectIdField(params.projectId),
      },
    });
    if (!e) throw new TrackerError("Toggl が計測開始に応答しませんでした");
    return this.toEntry(e);
  }

  async stop(_entryId: string, at: number): Promise<void> {
    // Focus の stop は「いま走っているもの」を止める。entry id は取らない。
    await this.call(`${await this.scope()}/tracking/stop`, {
      method: "POST",
      body: { end: toIso(at) },
    });
  }

  async getStoppedAt(entryId: string): Promise<number | null> {
    const e = await this.call<FocusTimeEntry>(`${await this.scope()}/time-entries/${entryId}`);
    return e?.end ? Math.floor(Date.parse(e.end) / 1000) : null;
  }

  /**
   * 期間内の計測を取る。
   *
   *   GET {scope}/time-entries?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
   *
   * duration は**ミリ秒**で返る（Track の v9 は秒）。ここで秒に直して、
   * 呼び出し側が製品の違いを意識せずに済むようにする。
   */
  async listTracked(from: number, to: number): Promise<TrackedRange> {
    const scope = await this.scope();
    const query = `date_from=${formatDateOnly(from)}&date_to=${formatDateOnly(to)}&per_page=${PAGE_SIZE}`;

    const raw: FocusTimeEntry[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await this.call<{ data?: FocusTimeEntry[] } | FocusTimeEntry[]>(
        `${scope}/time-entries?${query}&page=${page}`,
      );
      const items = Array.isArray(res) ? res : (res?.data ?? []);
      raw.push(...items);
      if (items.length < PAGE_SIZE) break;
    }

    const list = await this.call<{ data?: FocusProject[] } | FocusProject[]>(`${scope}/projects`);
    const projects = Array.isArray(list) ? list : (list?.data ?? []);

    return {
      entries: raw
        .filter((e) => e.type !== "break" && !e.deleted_at && (e.duration ?? 0) > 0)
        .map((e) => ({
          projectId: e.project_id === null || e.project_id === undefined ? null : String(e.project_id),
          startedAt: Math.floor(Date.parse(e.start) / 1000),
          sec: Math.round((e.duration ?? 0) / 1000),
        })),
      projectNames: new Map(projects.map((p) => [String(p.id), p.name])),
    };
  }

  async findOrCreateProject(name: string): Promise<string | null> {
    const scope = await this.scope();
    const list = await this.call<{ data?: FocusProject[] } | FocusProject[]>(`${scope}/projects`);
    const items = Array.isArray(list) ? list : (list?.data ?? []);
    const hit = items.find((p) => p.name === name);
    if (hit) return String(hit.id);

    // name だけで作ると active: false になり、アプリ側で扱いにくくなる
    const created = await this.call<FocusProject>(`${scope}/projects`, {
      method: "POST",
      body: { name, active: true },
    });
    return created ? String(created.id) : null;
  }
}
