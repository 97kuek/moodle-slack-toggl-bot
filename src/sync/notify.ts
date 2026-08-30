import type { SlackAPIClient } from "slack-cloudflare-workers";
import { CONFIG, type Env } from "../config";
import * as repo from "../db/repo";
import type { NotificationKind, TaskRow } from "../db/types";
import { notificationBlocks } from "../slack/blocks";
import {
  formatDue,
  formatDuration,
  isQuietHour,
  local,
  localDayOffset,
  startOfLocalDay,
  startOfLocalWeek,
} from "../time";

/**
 * 通知ポリシー（§6）。
 *
 * - 1 課題あたり DM は最大 3 通（new / due_tomorrow / due_3h）
 * - 同じタイミングで複数該当したら必ず 1 通にまとめる
 * - 静音時間（JST 0:00-7:00）は送らず、朝のダイジェストに合流させる
 * - 送信の権利は notifications テーブルの PRIMARY KEY で管理し、二重送信を防ぐ
 */

export function resolveChannel(env: Env): string {
  return env.SLACK_TARGET_CHANNEL && env.SLACK_TARGET_CHANNEL.length > 0
    ? env.SLACK_TARGET_CHANNEL
    : env.SLACK_USER_ID;
}

interface Batch {
  kind: NotificationKind;
  headline: string;
  tasks: TaskRow[];
}

export async function runNotifications(
  env: Env,
  client: SlackAPIClient,
  now: number,
  newlyInserted: TaskRow[],
): Promise<number> {
  if (isQuietHour(now, CONFIG.quietStartHour, CONFIG.quietEndHour)) return 0;

  const db = env.DB;
  const active = await repo.listActiveTasks(db, CONFIG.maxTasksOnHome * 2);
  const hourJst = local(now).hour;

  const isSnoozed = (t: TaskRow) => t.snooze_until !== null && t.snooze_until > now;

  const dueTomorrow = active.filter(
    (t) =>
      t.due_at !== null &&
      localDayOffset(t.due_at, now) === 1 &&
      hourJst >= CONFIG.dueTomorrowHour &&
      !isSnoozed(t),
  );

  // 最終警告だけはスヌーズを無視する
  const dueSoon = active.filter(
    (t) => t.due_at !== null && t.due_at > now && t.due_at - now <= CONFIG.dueSoonSec,
  );

  const candidates: Batch[] = [
    {
      kind: "new",
      headline: "*新しい課題が出ました*",
      tasks: newlyInserted.filter((t) => !isSnoozed(t)),
    },
    { kind: "due_tomorrow", headline: "*明日締切の課題があります*", tasks: dueTomorrow },
    { kind: "due_3h", headline: ":rotating_light: *まもなく締切です。提出しましたか？*", tasks: dueSoon },
  ];

  let sent = 0;
  const running = await repo.getRunningSession(db);

  for (const batch of candidates) {
    if (batch.tasks.length === 0) continue;

    // 送信の権利を取れたものだけを送る
    const claimed: TaskRow[] = [];
    for (const task of batch.tasks) {
      if (await repo.claimNotification(db, task.id, batch.kind, now)) claimed.push(task);
    }
    if (claimed.length === 0) continue;

    const headline =
      claimed.length > 1 ? `${batch.headline}（${claimed.length}件）` : batch.headline;

    try {
      await client.chat.postMessage({
        channel: resolveChannel(env),
        text: fallbackText(batch.kind, claimed, now),
        blocks: notificationBlocks(headline, claimed, now, running?.task_id ?? null),
      });
      sent++;
    } catch (e) {
      // 送信できなかったら権利を返す。次の cron で再試行される。
      await repo.releaseNotifications(
        db,
        claimed.map((t) => ({ taskId: t.id, kind: batch.kind })),
      );
      throw e;
    }
  }

  return sent;
}

/**
 * 朝のダイジェスト。今日から 3 日以内の課題を 1 通にまとめる。
 *
 * 発火時刻の判定を cron ではなくローカル時刻で行う。cron は UTC 固定なので、
 * そこに時刻を埋めると TIMEZONE_OFFSET_MIN を変えた人が cron も直す必要が出る。
 * 15 分ごとの同期に相乗りさせ、送信済みかどうかは kv_state で管理する。
 */
export async function maybeSendDigest(
  env: Env,
  client: SlackAPIClient,
  now: number,
): Promise<boolean> {
  const db = env.DB;

  const target = startOfLocalDay(now) + CONFIG.digestHour * 3600;
  if (now < target) return false;
  const last = await repo.getStateNumber(db, "last_digest_at");
  if (last !== null && last >= target) return false;

  const active = await repo.listActiveTasks(db, CONFIG.maxTasksOnHome);
  const soon = active.filter(
    (t) => t.due_at !== null && localDayOffset(t.due_at, now) <= 3,
  );
  await repo.setState(db, "last_digest_at", String(now));
  if (soon.length === 0) return false;

  const running = await repo.getRunningSession(db);
  await client.chat.postMessage({
    channel: resolveChannel(env),
    text: `おはようございます。3日以内の課題が ${soon.length} 件あります。`,
    blocks: notificationBlocks(
      `*おはようございます。3日以内の課題が ${soon.length} 件あります*`,
      soon,
      now,
      running?.task_id ?? null,
    ),
  });
  return true;
}

/**
 * Moodle のトークン失効を知らせる。連投しないよう 1 日 1 回までに絞る（§10）。
 */
export async function notifyTokenExpired(
  env: Env,
  client: SlackAPIClient,
  now: number,
  detail: string,
): Promise<void> {
  const last = await repo.getStateNumber(env.DB, "last_token_alert_at");
  if (last !== null && now - last < 24 * 60 * 60) return;
  await repo.setState(env.DB, "last_token_alert_at", String(now));
  await client.chat.postMessage({
    channel: resolveChannel(env),
    text: `:warning: Moodle への接続に失敗しました（${detail}）。トークンを再発行して \`wrangler secret put MOODLE_TOKEN\` で更新してください。`,
  });
}

function fallbackText(kind: NotificationKind, tasks: TaskRow[], now: number): string {
  const first = tasks[0];
  const head =
    kind === "new" ? "新しい課題" : kind === "due_tomorrow" ? "明日締切" : "まもなく締切";
  if (!first) return head;
  const due = first.due_at !== null ? ` (${formatDue(first.due_at, now)})` : "";
  return tasks.length > 1
    ? `${head}: ${first.title}${due} ほか ${tasks.length - 1} 件`
    : `${head}: ${first.title}${due}`;
}


/**
 * 週次サマリ（日曜 21:00）。
 *
 * 外部のダッシュボードは「見に行く」必要があるため続かない。
 * 同じ内容を週に 1 度だけ Slack に届けるほうが実際に目に入る、という判断で
 * 時間管理の出力先をここに置いている。
 *
 * cron は無料枠 3 本を使い切っているので、15 分ごとの同期に相乗りさせ、
 * 送信済みかどうかは kv_state で管理する（発火を取りこぼしても次の tick で送る）。
 */
export async function maybeSendWeeklySummary(
  env: Env,
  client: SlackAPIClient,
  now: number,
): Promise<boolean> {
  const db = env.DB;
  const weekStart = startOfLocalWeek(now);
  // 週の始まりは月曜。そこから目的の曜日・時刻を出す（日曜 = 月曜 +6 日）。
  const weekdayOffset = (CONFIG.weeklySummaryWeekday + 6) % 7;
  const target = weekStart + weekdayOffset * 86400 + CONFIG.weeklySummaryHour * 3600;

  if (now < target) return false;
  const last = await repo.getStateNumber(db, "last_weekly_summary_at");
  if (last !== null && last >= target) return false;

  const [byCourse, completed, active] = await Promise.all([
    repo.trackedByCourse(db, weekStart, now),
    repo.completedBetween(db, weekStart, now),
    repo.listActiveTasks(db, CONFIG.maxTasksOnHome),
  ]);

  const totalSec = byCourse.reduce((a, c) => a + (c.sec ?? 0), 0);
  const nextWeek = active.filter(
    (t) => t.due_at !== null && t.due_at > now && localDayOffset(t.due_at, now) <= 7,
  );

  // 何も無い週に空の報告を送らない（§6 送らないもの）
  if (totalSec === 0 && completed.length === 0 && nextWeek.length === 0) {
    await repo.setState(db, "last_weekly_summary_at", String(now));
    return false;
  }

  const lines: string[] = [`*今週のふりかえり*　学習 \`${formatDuration(totalSec)}\``];

  if (byCourse.length > 0) {
    lines.push("");
    const max = Math.max(...byCourse.map((c) => c.sec ?? 0));
    for (const c of byCourse) {
      const sec = c.sec ?? 0;
      // 文字だけで割合が分かるように簡易バーを引く
      const bar = "▇".repeat(Math.max(1, Math.round((sec / max) * 12)));
      lines.push(`${bar} \`${formatDuration(sec)}\`　${c.course ?? "科目なし"}`);
    }
  }

  if (completed.length > 0) {
    lines.push("", `*完了 ${completed.length} 件*`);
    for (const t of completed.slice(0, 8)) {
      lines.push(`• ~${t.title}~`);
    }
  }

  if (nextWeek.length > 0) {
    lines.push("", `*来週の締切 ${nextWeek.length} 件*`);
    for (const t of nextWeek.slice(0, 8)) {
      lines.push(`• ${formatDue(t.due_at!, now)}　${t.course_name ? `${t.course_name} / ` : ""}${t.title}`);
    }
  }

  await client.chat.postMessage({
    channel: resolveChannel(env),
    text: `今週の学習 ${formatDuration(totalSec)} / 完了 ${completed.length} 件`,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } }],
  });

  await repo.setState(db, "last_weekly_summary_at", String(now));
  return true;
}
