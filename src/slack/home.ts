import type { SlackAPIClient } from "slack-cloudflare-workers";
import { CONFIG, type Env } from "../config";
import * as repo from "../db/repo";
import { isTogglReady, missingSettings, type Settings } from "../settings";
import { startOfLocalDay } from "../time";
import { homeView } from "./blocks";

/** App Home を描き直す。TODO の主役はここ。 */
export async function publishHome(
  env: Env,
  settings: Settings,
  client: SlackAPIClient,
  now: number,
  warning: string | null = null,
): Promise<void> {
  const db = env.DB;
  const [tasks, recentlyCompleted, running, todayTrackedSec, lastSyncAt] = await Promise.all([
    repo.listActiveTasks(db, CONFIG.maxTasksOnHome),
    repo.listRecentlyCompleted(db, now - 24 * 60 * 60, CONFIG.maxRecentlyCompletedOnHome),
    repo.getRunningSession(db),
    repo.trackedSecSince(db, startOfLocalDay(now)),
    repo.getStateNumber(db, "last_sync_at"),
  ]);

  const runningTask = running ? await repo.getTask(db, running.task_id) : null;

  const view = homeView({
    tasks,
    recentlyCompleted,
    missing: missingSettings(settings),
    togglReady: isTogglReady(settings),
    now,
    runningTaskId: running?.task_id ?? null,
    runningTitle: runningTask?.title ?? null,
    runningSince: running?.started_at ?? null,
    todayTrackedSec: todayTrackedSec + (running ? now - running.started_at : 0),
    lastSyncAt,
    warning,
  });

  await client.views.publish({ user_id: env.SLACK_USER_ID, view });

  await repo.setState(db, "last_home_published_at", String(now));
}
