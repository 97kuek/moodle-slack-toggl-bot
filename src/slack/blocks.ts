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
  more: "task_more",
  category: "task_category",
  filter: "home_filter",
  sync: "sync_now",
  settingsConnection: "open_settings_connection",
  settingsNotification: "open_settings_notification",
  addTask: "open_add_task",
} as const;

/** 絞り込みの「すべて」。分類名と衝突しない値にしてある。 */
export const FILTER_ALL = "__all__";

/**
 * タスク 1 件を「見出し + 操作」の 2 ブロックで描く。
 *
 * よく使う操作だけをボタンに出し、残りは「…」にまとめている。
 * ボタンが 4 つ並ぶと目が滑って、結局どれも押されなくなるため。
 */
export function taskBlocks(task: TaskRow, now: number, isRunning: boolean): AnyMessageBlock[] {
  const meta: string[] = [];
  // Moodle 由来は分類がすべて同じ（例: Waseda）なので、出しても情報にならない。
  // 科目名があるならそちらを見せ、無い（手で足した）タスクだけ分類を出す。
  const label = task.course_name ?? task.category;
  if (label) meta.push(escapeMrkdwn(label));
  if (task.due_at !== null) {
    meta.push(formatDue(task.due_at, now));
    meta.push(formatRemaining(task.due_at, now));
  } else {
    meta.push("期限なし");
  }
  if (isRunning) meta.push("計測中");
  else if (task.tracked_sec >= CONFIG.startedThresholdSec) {
    meta.push(`着手 ${formatDuration(task.tracked_sec)}`);
  }
  if (task.snooze_until !== null && task.snooze_until > now) meta.push("スヌーズ中");

  const more: {
    text: { type: "plain_text"; text: string; emoji: true };
    value: string;
    url?: string;
  }[] = [
    {
      text: { type: "plain_text", text: "明日まで通知しない", emoji: true },
      value: `snooze:${task.id}`,
    },
    {
      text: { type: "plain_text", text: "分類を変える", emoji: true },
      value: `category:${task.id}`,
    },
  ];
  if (task.url) {
    more.push({
      text: { type: "plain_text", text: "リンクを開く", emoji: true },
      value: `open:${task.id}`,
      url: task.url,
    });
  }
  if (task.source === "manual") {
    more.push({
      text: { type: "plain_text", text: "削除", emoji: true },
      value: `remove:${task.id}`,
    });
  }

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${escapeMrkdwn(task.title)}*\n${meta.join("　·　")}`,
      },
    },
    {
      type: "actions",
      block_id: `task_actions_${task.id}`,
      elements: [
        isRunning
          ? {
              type: "button",
              action_id: ACTION.stop,
              text: { type: "plain_text", text: "停止", emoji: true },
              value: task.id,
              style: "danger",
            }
          : {
              type: "button",
              action_id: ACTION.start,
              text: { type: "plain_text", text: "開始", emoji: true },
              value: task.id,
              style: "primary",
            },
        {
          type: "button",
          action_id: ACTION.done,
          text: { type: "plain_text", text: "完了", emoji: true },
          value: task.id,
        },
        { type: "overflow", action_id: ACTION.more, options: more },
      ],
    },
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
  todayCompleted: number;
  streakDays: number;
  categories: string[];
  filter: string | null;
  lastSyncAt: number | null;
  warning: string | null;
  notice: string | null;
}): { type: "home"; blocks: AnyHomeTabBlock[] } {
  const { tasks, now, runningTaskId } = params;
  const blocks: AnyHomeTabBlock[] = [];

  // --- 上部: 今日の実績と計測中
  // Slack のブロックは静的なので、経過時間は描画時点のスナップショットになる。
  // 開始時刻を併記して、数字が止まって見えても意味が取れるようにする。
  const isRunning =
    params.runningTaskId !== null && params.runningTitle !== null && params.runningSince !== null;
  const runningLine = isRunning
    ? `*計測中* — ${escapeMrkdwn(params.runningTitle!)}\n` +
      `　${formatClock(params.runningSince!)} 開始 · ${formatDuration(now - params.runningSince!)} 経過`
    : "計測していません";

  // 数字は「出たら意味があるもの」だけ並べる。0 件・0 日を出しても手応えにならない。
  const today = [`*今日の学習*　${formatDuration(params.todayTrackedSec)}`];
  if (params.todayCompleted > 0) today.push(`完了 ${params.todayCompleted} 件`);
  if (params.streakDays >= 2) today.push(`${params.streakDays} 日連続`);

  // 停止はここにも置く。タスクが並ぶと、走っている行が画面の下に隠れてしまう。
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `${today.join("　·　")}\n${runningLine}`,
    },
    ...(isRunning
      ? {
          accessory: {
            type: "button" as const,
            action_id: ACTION.stop,
            text: { type: "plain_text" as const, text: "停止", emoji: true },
            value: params.runningTaskId!,
            style: "danger" as const,
          },
        }
      : {}),
  });

  if (params.notice) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: params.notice }] });
  }

  if (params.warning) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*うまくいきませんでした*\n${params.warning}` },
    });
  }

  // 未設定のうちは、何をすればよいかをここに出す
  if (params.missing.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*設定が足りていません*\n${params.missing.map((m) => `• ${m}`).join("\n")}\n` +
          "下の「接続設定」から入力してください。",
      },
    });
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        action_id: ACTION.addTask,
        text: { type: "plain_text", text: "タスクを追加", emoji: true },
        value: "add",
      },
      {
        type: "button",
        action_id: ACTION.settingsConnection,
        text: { type: "plain_text", text: "接続設定", emoji: true },
        value: "connection",
        ...(params.missing.length > 0 ? { style: "primary" as const } : {}),
      },
      {
        type: "button",
        action_id: ACTION.settingsNotification,
        text: { type: "plain_text", text: "通知設定", emoji: true },
        value: "notification",
      },
    ],
  });

  blocks.push({ type: "divider" });

  // 分類での絞り込み。選んだものは D1 に残るので、cron が描き直しても保たれる。
  if (params.categories.length > 1) {
    const options = [
      { text: { type: "plain_text" as const, text: "すべての分類", emoji: true }, value: FILTER_ALL },
      ...params.categories.map((c) => ({
        text: { type: "plain_text" as const, text: c, emoji: true },
        value: c,
      })),
    ];
    const selected = options.find((o) => o.value === params.filter) ?? options[0]!;
    blocks.push({
      type: "actions",
      block_id: "home_filter_row",
      elements: [
        {
          type: "static_select",
          action_id: ACTION.filter,
          options,
          initial_option: selected,
        },
      ],
    });
  }

  if (tasks.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: params.filter
          ? `「${escapeMrkdwn(params.filter)}」のタスクはありません。`
          : "やることはありません。",
      },
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
          text: { type: "plain_text", text: "戻す", emoji: true },
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
        text: { type: "plain_text", text: "同期", emoji: true },
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
