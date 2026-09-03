import type { SlackAPIClient } from "slack-cloudflare-workers";
import { CONFIG, type Env } from "../config";
import * as repo from "../db/repo";
import { isTogglReady, missingSettings, type Settings } from "../settings";
import { countStreak, localDayIndex, startOfLocalDay, timezoneOffsetMin } from "../time";
import { homeView } from "./blocks";

export interface HomeOptions {
  /** うまくいかなかったことを上に出す */
  warning?: string | null;
  /** 時間のかかる処理を始めたことを先に伝える */
  notice?: string | null;
  /** Slack の操作きっかけかどうか（診断用の記録に使う） */
  fromSlack?: boolean;
}

/**
 * App Home を描き直す。TODO の主役はここ。
 *
 * 読み出しは 1 往復にまとめてある。ボタンを押してから画面が変わるまでの時間は
 * ほぼこの関数の長さなので、ここで往復を増やすとそのまま体感の遅さになる。
 */
export async function publishHome(
  env: Env,
  settings: Settings,
  client: SlackAPIClient,
  now: number,
  options: HomeOptions = {},
): Promise<void> {
  const db = env.DB;
  // 絞り込みは D1 に置いてある。cron からの描き直しでも選択が保たれるようにするため。
  const filter = await repo.getState(db, "home_filter");

  const [tasks, recentlyCompleted, running, todayTrackedSec, lastSyncAt, completionDays] =
    await Promise.all([
      repo.listActiveTasks(db, CONFIG.maxTasksOnHome, filter),
      repo.listRecentlyCompleted(db, now - 24 * 60 * 60, CONFIG.maxRecentlyCompletedOnHome),
      repo.getRunningWithTask(db),
      repo.trackedSecSince(db, startOfLocalDay(now)),
      repo.getStateNumber(db, "last_sync_at"),
      repo.completionsByDay(db, timezoneOffsetMin() * 60, now - CONFIG.streakWindowDays * 86400, CONFIG.streakWindowDays),
    ]);

  const today = localDayIndex(now);

  const view = homeView({
    tasks,
    recentlyCompleted,
    missing: missingSettings(settings),
    togglReady: isTogglReady(settings),
    now,
    runningTaskId: running?.session.task_id ?? null,
    runningTitle: running?.task?.title ?? null,
    runningSince: running?.session.started_at ?? null,
    todayTrackedSec: todayTrackedSec + (running ? now - running.session.started_at : 0),
    todayCompleted: completionDays.find((d) => d.day === today)?.n ?? 0,
    streakDays: countStreak(completionDays.map((d) => d.day), today),
    categories: settings.categories,
    filter,
    lastSyncAt,
    warning: options.warning ?? null,
    notice: options.notice ?? null,
  });

  await client.views.publish({ user_id: env.SLACK_USER_ID, view });

  // 記録は画面を出したあとにまとめて書く。ここを先にすると 1 往復ぶん遅くなる。
  await repo.setStates(db, {
    last_home_published_at: String(now),
    ...(options.fromSlack ? { last_slack_event_at: String(now) } : {}),
  });
}
