export type TaskStatus = "open" | "in_progress" | "done" | "archived" | "removed";
export type TaskKind = "assign" | "quiz" | "event";
export type NotificationKind = "new" | "due_tomorrow" | "due_3h" | "overdue" | "token_expired";

export interface TaskRow {
  id: string;
  source: string;
  source_id: string;
  course_id: string | null;
  course_name: string | null;
  title: string;
  kind: TaskKind | null;
  url: string | null;
  instance_id: number | null;
  due_at: number | null;
  submitted_at: number | null;
  status: TaskStatus;
  snooze_until: number | null;
  tracked_sec: number;
  completed_at: number | null;
  submission_checked_at: number | null;
  first_seen_at: number;
  last_seen_at: number;
}

export interface TimeSessionRow {
  id: string;
  task_id: string;
  toggl_entry_id: string | null;
  started_at: number;
  stopped_at: number | null;
  duration_sec: number | null;
}

export interface CourseProjectRow {
  course_id: string;
  course_name: string | null;
  toggl_project_id: string;
}
