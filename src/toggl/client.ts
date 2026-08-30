import { toIso } from "../time";

/**
 * Toggl Track API v9 の薄いクライアント。
 * 認証は API トークンの Basic 認証（"<token>:api_token" を base64）。
 */

const BASE = "https://api.track.toggl.com/api/v9";
const CREATED_WITH = "moodle-slack-toggl-bot";

export interface TogglTimeEntry {
  id: number;
  workspace_id: number;
  project_id: number | null;
  description: string | null;
  start: string;
  stop: string | null;
  duration: number;
}

export interface TogglProject {
  id: number;
  name: string;
  active: boolean;
}

export class TogglRateLimitError extends Error {
  constructor() {
    super("Toggl のレート制限に達しました");
    this.name = "TogglRateLimitError";
  }
}

export class TogglError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TogglError";
  }
}

export class TogglClient {
  private readonly auth: string;
  private workspaceId: number | null;

  constructor(apiToken: string, workspaceId?: string) {
    this.auth = `Basic ${btoa(`${apiToken}:api_token`)}`;
    const wid = workspaceId ? Number(workspaceId) : NaN;
    this.workspaceId = Number.isFinite(wid) && wid > 0 ? wid : null;
  }

  private async call<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T | null> {
    const res = await fetch(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: this.auth,
        "content-type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

    if (res.status === 429) throw new TogglRateLimitError();
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new TogglError(`Toggl が HTTP ${res.status} を返しました (${path}) ${detail.slice(0, 200)}`);
    }
    // 計測中の entry が無いときは 200 + 本文 "null" が返る
    const text = await res.text();
    if (!text || text === "null") return null;
    return JSON.parse(text) as T;
  }

  async getWorkspaceId(): Promise<number> {
    if (this.workspaceId !== null) return this.workspaceId;
    const me = await this.call<{ default_workspace_id?: number }>("/me");
    const id = me?.default_workspace_id;
    if (!id) throw new TogglError("Toggl のワークスペースを特定できませんでした");
    this.workspaceId = id;
    return id;
  }

  async getCurrentEntry(): Promise<TogglTimeEntry | null> {
    return await this.call<TogglTimeEntry>("/me/time_entries/current");
  }

  /** 1 件の entry を取得する。Toggl 側で止められた実際の停止時刻を知るために使う。 */
  async getEntry(entryId: number, workspaceId?: number): Promise<TogglTimeEntry | null> {
    const wid = workspaceId ?? (await this.getWorkspaceId());
    return await this.call<TogglTimeEntry>(`/workspaces/${wid}/time_entries/${entryId}`);
  }

  /** 走っている entry があれば止めてから、新しい計測を開始する。 */
  async startEntry(params: {
    description: string;
    projectId: number | null;
    tags?: string[];
    startedAt: number;
  }): Promise<TogglTimeEntry> {
    const wid = await this.getWorkspaceId();
    const current = await this.getCurrentEntry();
    if (current) await this.stopEntry(current.id, current.workspace_id);

    const entry = await this.call<TogglTimeEntry>(`/workspaces/${wid}/time_entries`, {
      method: "POST",
      body: {
        created_with: CREATED_WITH,
        workspace_id: wid,
        description: params.description.slice(0, 200),
        project_id: params.projectId,
        tags: params.tags ?? [],
        start: toIso(params.startedAt),
        // v9 では duration に負値を入れると「計測中」を意味する
        duration: -1,
      },
    });
    if (!entry) throw new TogglError("Toggl が計測開始に応答しませんでした");
    return entry;
  }

  async stopEntry(entryId: number, workspaceId?: number): Promise<TogglTimeEntry | null> {
    const wid = workspaceId ?? (await this.getWorkspaceId());
    return await this.call<TogglTimeEntry>(`/workspaces/${wid}/time_entries/${entryId}/stop`, {
      method: "PATCH",
    });
  }

  /**
   * 科目名でプロジェクトを探し、無ければ作る。
   * ユーザーに手動マッピングを求めないための処理（§8）。
   */
  async findOrCreateProject(name: string): Promise<number> {
    const wid = await this.getWorkspaceId();
    const projects = await this.call<TogglProject[]>(`/workspaces/${wid}/projects?active=true`);
    const hit = (projects ?? []).find((p) => p.name === name);
    if (hit) return hit.id;

    const created = await this.call<TogglProject>(`/workspaces/${wid}/projects`, {
      method: "POST",
      body: { name, active: true, is_private: true, created_with: CREATED_WITH },
    });
    if (!created) throw new TogglError(`Toggl のプロジェクト作成に失敗しました: ${name}`);
    return created.id;
  }
}
