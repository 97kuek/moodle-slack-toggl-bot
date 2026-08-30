import type { TaskKind } from "../db/types";

/** Moodle から取れた 1 件のタスク（正規化済み）。 */
export interface RawMoodleTask {
  /** Moodle event id / iCal UID。(source, source_id) で一意 */
  sourceId: string;
  courseId: string | null;
  courseName: string | null;
  title: string;
  kind: TaskKind;
  url: string | null;
  /** assign の instance id。提出状況の問い合わせに使う（Web Services のみ） */
  instanceId: number | null;
  dueAt: number | null;
}

export interface SubmissionStatus {
  sourceId: string;
  submitted: boolean;
  submittedAt: number | null;
}

/**
 * 大学ごとに違う Moodle の事情を、この 1 箇所に閉じ込める。
 * 同期・通知・Slack UI・Toggl の各レイヤは実装差を一切知らない。
 */
export interface MoodleClient {
  readonly source: string;
  fetchUpcoming(): Promise<RawMoodleTask[]>;
  /** Web Services モードのみ。iCal では提出状況を取得できない。 */
  fetchSubmissionStatus?(tasks: { sourceId: string; instanceId: number }[]): Promise<SubmissionStatus[]>;
}

/** トークン失効。呼び出し側はこれを見て「再設定して」の通知を出す。 */
export class MoodleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoodleAuthError";
  }
}

export class MoodleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoodleError";
  }
}
