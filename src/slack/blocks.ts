import type { AnyHomeTabBlock, AnyMessageBlock } from "slack-cloudflare-workers";
import { CONFIG } from "../config";
import type { TaskRow } from "../db/types";
import {
  formatClock,
  GROUP_ORDER,
  dueGroupLabel,
  formatDue,
  formatDuration,
  formatRemaining,
} from "../time";

export const ACTION = {
  start: "task_start",
  stop: "task_stop",
  done: "task_done",
  snooze: "task_snooze",
  undone: "task_undone",
  remove: "task_remove",
  sync: "sync_now",
  settingsConnection: "open_settings_connection",
  settingsNotification: "open_settings_notification",
  addTask: "open_add_task",
} as const;

const KIND_ICON: Record<string, string> = {
  assign: "📝",
  quiz: "🧪",
  event: "📅",
};

/** 1 件のタスクを、見出し + 操作ボタンの 2 ブロックにする。 */
export function taskBlocks(task: TaskRow, now: number, isRunning: boolean): AnyMessageBlock[] {
  const icon = KIND_ICON[task.kind ?? "event"] ?? "📅";
  const course = task.course_name ? `*${escapeMrkdwn(task.course_name)}* / ` : "";
  const due =
    task.due_at === null
      ? "期限なし"
      : `${formatDue(task.due_at, now)} — ${formatRemaining(task.due_at, now)}`;

  const marks: string[] = [];
  if (isRunning) marks.push("🔴 計測中");
  else if (task.tracked_sec >= CONFIG.startedThresholdSec) {
    marks.push(`着手済み ${formatDuration(task.tracked_sec)}`);
  }
  if (task.snooze_until !== null && task.snooze_until > now) marks.push("😴 スヌーズ中");

  const meta = [due, ...marks].join(" · ");

  const buttons: AnyMessageBlock = {
    type: "actions",
    block_id: `task_actions_${task.id}`,
    elements: [
      isRunning
        ? {
            type: "button",
            action_id: ACTION.stop,
            text: { type: "plain_text", text: "⏹ 停止", emoji: true },
            value: task.id,
            style: "danger",
          }
        : {
            type: "button",
            action_id: ACTION.start,
            text: { type: "plain_text", text: "▶︎ 開始", emoji: true },
            value: task.id,
            style: "primary",
          },
      {
        type: "button",
        action_id: ACTION.done,
        text: { type: "plain_text", text: "✓ 完了", emoji: true },
        value: task.id,
      },
      {
        type: "button",
        action_id: ACTION.snooze,
        text: { type: "plain_text", text: "😴 明日", emoji: true },
        value: task.id,
      },
      ...(task.source === "manual"
        ? [
            {
              type: "button" as const,
              action_id: ACTION.remove,
              text: { type: "plain_text" as const, text: "🗑", emoji: true },
              value: task.id,
            },
          ]
        : []),
      ...(task.url
        ? [
            {
              type: "button" as const,
              action_id: `open_moodle_${task.id}`,
              text: { type: "plain_text" as const, text: "🔗 Moodle", emoji: true },
              url: task.url,
            },
          ]
        : []),
    ],
  };

  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `${icon} ${course}${escapeMrkdwn(task.title)}\n\`${meta}\`` },
    },
    buttons,
  ];
}

/** App Home。締切順に、JST の日付でグルーピングする。 */
export function homeView(params: {
  tasks: TaskRow[];
  recentlyCompleted: TaskRow[];
  missing: string[];
  togglReady: boolean;
  now: number;
  runningTaskId: string | null;
  runningTitle: string | null;
  runningSince: number | null;
  todayTrackedSec: number;
  lastSyncAt: number | null;
  warning: string | null;
}): { type: "home"; blocks: AnyHomeTabBlock[] } {
  const { tasks, now, runningTaskId } = params;
  const blocks: AnyHomeTabBlock[] = [];

  // --- 上部: 今日の実績と計測中
  // Slack のブロックは静的なので、経過時間は描画時点のスナップショットになる。
  // 開始時刻を併記して、数字が止まって見えても意味が取れるようにする。
  const runningLine =
    params.runningTaskId && params.runningTitle && params.runningSince !== null
      ? `🔴 *計測中* — ${escapeMrkdwn(params.runningTitle)}\n` +
        `　　${formatClock(params.runningSince)} 開始 · ${formatDuration(now - params.runningSince)} 経過`
      : "⏸ 計測していません";

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*📚 今日の学習*　\`${formatDuration(params.todayTrackedSec)}\`\n${runningLine}`,
    },
  });

  if (params.warning) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `:warning: ${params.warning}` },
    });
  }

  // 未設定のうちは、何をすればよいかをここに出す
  if (params.missing.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:gear: *設定が足りていません*\n${params.missing.map((m) => `• ${m}`).join("\n")}`,
      },
    });
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        action_id: ACTION.addTask,
        text: { type: "plain_text", text: "＋ タスクを追加", emoji: true },
        value: "add",
      },
      {
        type: "button",
        action_id: ACTION.settingsConnection,
        text: { type: "plain_text", text: "⚙️ 接続設定", emoji: true },
        value: "connection",
        ...(params.missing.length > 0 ? { style: "primary" as const } : {}),
      },
      {
        type: "button",
        action_id: ACTION.settingsNotification,
        text: { type: "plain_text", text: "🔔 通知設定", emoji: true },
        value: "notification",
      },
    ],
  });

  blocks.push({ type: "divider" });

  if (tasks.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "やることはありません。" },
    });
  } else {
    const groups = new Map<string, TaskRow[]>();
    for (const t of tasks) {
      const label = dueGroupLabel(t.due_at, now);
      const list = groups.get(label);
      if (list) list.push(t);
      else groups.set(label, [t]);
    }

    for (const label of GROUP_ORDER) {
      const list = groups.get(label);
      if (!list || list.length === 0) continue;
      blocks.push({
        type: "header",
        text: { type: "plain_text", text: `${label}（${list.length}）`, emoji: true },
      });
      for (const t of list) {
        blocks.push(...(taskBlocks(t, now, t.id === runningTaskId) as AnyHomeTabBlock[]));
      }
    }
  }

  // 完了は Moodle から再取得されないため、押し間違いを戻せる導線をここに置く。
  if (params.recentlyCompleted.length > 0) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: "*最近完了したもの*（24時間以内）" }],
    });
    for (const t of params.recentlyCompleted) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `~${escapeMrkdwn(t.title)}~` },
        accessory: {
          type: "button",
          action_id: ACTION.undone,
          text: { type: "plain_text", text: "↩︎ 戻す", emoji: true },
          value: t.id,
        },
      });
    }
  }

  blocks.push({ type: "divider" });
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        action_id: ACTION.sync,
        text: { type: "plain_text", text: "🔄 今すぐ同期", emoji: true },
        value: "sync",
      },
    ],
  });
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: [
          params.lastSyncAt === null
            ? "まだ同期していません"
            : `最終同期: ${formatDuration(now - params.lastSyncAt)}前`,
          params.togglReady ? "Toggl 連携: 有効" : "Toggl 未設定（計測ボタンは無効）",
        ].join("　·　"),
      },
    ],
  });

  return { type: "home", blocks };
}

/**
 * 通知 DM。複数件でも必ず 1 通にまとめる（バッチング）。
 *
 * chat.postMessage は 50 ブロックまで。1 タスクが 2 ブロックを使うので、
 * 件数をそのまま並べると学期中に上限を超えて送信自体が失敗する。
 * 上限を超える分は件数だけ添えて App Home に誘導する。
 */
export function notificationBlocks(
  headline: string,
  tasks: TaskRow[],
  now: number,
  runningTaskId: string | null,
): AnyMessageBlock[] {
  const shown = tasks.slice(0, CONFIG.maxTasksPerMessage);
  const rest = tasks.length - shown.length;

  const blocks: AnyMessageBlock[] = [
    { type: "section", text: { type: "mrkdwn", text: headline } },
  ];
  for (const t of shown) {
    blocks.push(...taskBlocks(t, now, t.id === runningTaskId));
  }
  if (rest > 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `ほか ${rest} 件。全体はアプリのホームタブで確認できます。` }],
    });
  }
  return blocks;
}

/** Slack の mrkdwn で意味を持つ文字を無効化する。 */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
