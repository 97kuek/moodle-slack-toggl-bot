import type { Settings } from "../settings";
import { TogglClient } from "./client";
import { TogglFocusClient } from "./focus";
import {
  isFocusToken,
  type RunningEntry,
  type StartParams,
  type TimeTracker,
  type TrackedRange,
} from "./tracker";

/** Toggl Track（v9）を共通インターフェースに合わせる薄いアダプタ。 */
class TogglTrackAdapter implements TimeTracker {
  readonly kind = "track" as const;
  constructor(private readonly client: TogglClient) {}

  missing(): string[] {
    return [];
  }

  async getCurrent(): Promise<RunningEntry | null> {
    const e = await this.client.getCurrentEntry();
    if (!e) return null;
    return {
      id: String(e.id),
      description: e.description ?? null,
      startedAt: Math.floor(Date.parse(e.start) / 1000),
    };
  }

  async start(params: StartParams): Promise<RunningEntry> {
    const projectId = params.projectId === null ? null : Number(params.projectId);
    const e = await this.client.startEntry({
      description: params.description,
      projectId: Number.isFinite(projectId) ? projectId : null,
      tags: ["moodle"],
      startedAt: params.startedAt,
    });
    return {
      id: String(e.id),
      description: e.description ?? null,
      startedAt: Math.floor(Date.parse(e.start) / 1000),
    };
  }

  async stop(entryId: string): Promise<void> {
    await this.client.stopEntry(Number(entryId));
  }

  async findOrCreateProject(name: string): Promise<string | null> {
    return String(await this.client.findOrCreateProject(name));
  }

  async getStoppedAt(entryId: string): Promise<number | null> {
    const e = await this.client.getEntry(Number(entryId));
    return e?.stop ? Math.floor(Date.parse(e.stop) / 1000) : null;
  }

  async listTracked(from: number, to: number): Promise<TrackedRange> {
    const [entries, projects] = await Promise.all([
      this.client.listEntries(from, to),
      this.client.listProjects(),
    ]);
    return {
      // duration が負値のものは計測中。まだ確定していないので集計から外す。
      entries: entries
        .filter((e) => e.duration > 0)
        .map((e) => ({
          projectId: e.project_id === null ? null : String(e.project_id),
          startedAt: Math.floor(Date.parse(e.start) / 1000),
          sec: e.duration,
        })),
      projectNames: new Map(projects.map((p) => [String(p.id), p.name])),
    };
  }
}

/**
 * トークンの形から使うべき実装を選ぶ。
 * toggl_sk_ で始まれば Toggl 2.0、それ以外は Toggl Track。
 * 利用者にどちらの製品かを選ばせない。
 */
export function createTracker(settings: Settings): TimeTracker | null {
  const token = settings.togglApiToken;
  if (!token) return null;
  if (isFocusToken(token)) {
    return new TogglFocusClient(
      token,
      settings.togglOrganizationId,
      settings.togglWorkspaceId,
    );
  }
  return new TogglTrackAdapter(new TogglClient(token, settings.togglWorkspaceId ?? undefined));
}

export * from "./tracker";
