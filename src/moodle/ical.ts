import { MoodleError, type MoodleClient, type RawMoodleTask } from "./client";
import type { TaskKind } from "../db/types";

/**
 * iCal エクスポート版（フォールバック）。
 *
 * SSO などで Web Services のトークンが取れない場合に使う。締切とイベントは取れるが
 * 「提出済みかどうか」は取得できないので、fetchSubmissionStatus を実装しない。
 * その代わり §9 の「締切 +24h で自動アーカイブ」が効くので、放置してもタスクは溜まり続けない。
 *
 * URL の取り方: Moodle にログイン → カレンダー → 「カレンダーをエクスポートする」
 */
export class ICalMoodleClient implements MoodleClient {
  readonly source = "moodle_ical";

  constructor(
    private readonly icalUrl: string,
    /** リンクが取れなかったイベントのフォールバック先を作るのに使う */
    private readonly baseUrl: string,
    /** DTSTART にタイムゾーン指定が無かった場合に採用するオフセット（分）。既定は JST。 */
    private readonly fallbackTzOffsetMin: number = 540,
  ) {}

  async fetchUpcoming(): Promise<RawMoodleTask[]> {
    const res = await fetch(this.icalUrl, { headers: { accept: "text/calendar" } });
    if (!res.ok) {
      throw new MoodleError(`iCal の取得に失敗しました (HTTP ${res.status})`);
    }
    const text = await res.text();
    return parseIcs(text, this.baseUrl, this.fallbackTzOffsetMin);
  }
}

/** 行の折り返し（次行の先頭が空白）を戻す。 */
function unfold(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function unescapeText(v: string): string {
  return v
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

function parseLine(line: string): IcsProperty | null {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = head.split(";");
  const name = (parts[0] ?? "").toUpperCase();
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name, params, value };
}

/**
 * DTSTART を unix 秒にする。
 * - 末尾 Z → UTC
 * - TZID 付き / 指定なし → fallbackTzOffsetMin を適用（Moodle は通常 UTC で出す）
 * - VALUE=DATE（日付のみ）→ その日の 00:00 として扱う
 */
function parseDateTime(prop: IcsProperty, fallbackTzOffsetMin: number): number | null {
  const v = prop.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, z] = m;
  const utcMs = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(hh ?? "0"),
    Number(mm ?? "0"),
    Number(ss ?? "0"),
  );
  const isUtc = z === "Z";
  const offsetMs = isUtc ? 0 : fallbackTzOffsetMin * 60 * 1000;
  return Math.floor((utcMs - offsetMs) / 1000);
}

/**
 * Moodle の日本語表示では SUMMARY の末尾に活動種別が括弧で付く。
 *   「2026年度プロジェクト研究B履修申請フォーム (アンケート終了)」
 *   「レポート課題3 (課題終了)」
 * ここを種別判定に使い、タイトルからは取り除いて表示を読みやすくする。
 */
const TRAILING_ACTIVITY = /[（(]\s*([^（()）]{1,20}?)\s*[)）]\s*$/;

function splitSummary(summary: string): { title: string; kind: TaskKind } {
  const m = TRAILING_ACTIVITY.exec(summary);
  const suffix = m?.[1] ?? "";
  const title = m ? summary.slice(0, m.index).trim() : summary;
  return { title: title || summary, kind: guessKind(suffix || summary) };
}

/**
 * 種別の推測。日本語表記を優先し、英語表記にもフォールバックする。
 * 外しても表示上のアイコンが変わるだけで、同期そのものには影響しない。
 */
function guessKind(text: string): TaskKind {
  const s = text.toLowerCase();
  if (text.includes("課題") || s.includes("is due") || s.includes("assignment")) return "assign";
  if (text.includes("小テスト") || text.includes("テスト") || s.includes("quiz")) return "quiz";
  return "event";
}

/** DESCRIPTION に埋まっているリンクを拾う。Moodle は活動ページの URL をここに入れる。 */
function extractUrl(description: string | undefined, baseUrl: string, dueAt: number | null): string | null {
  if (description) {
    const m = /https?:\/\/[^\s"'<>\\]+/.exec(unescapeText(description));
    if (m) return m[0].replace(/[.,)）]+$/, "");
  }
  // リンクが無いイベントもあるので、その日のカレンダーに飛ばす
  if (!baseUrl) return null;
  const time = dueAt ?? Math.floor(Date.now() / 1000);
  return `${baseUrl.replace(/\/$/, "")}/calendar/view.php?view=day&time=${time}`;
}

export function parseIcs(
  text: string,
  baseUrl: string,
  fallbackTzOffsetMin: number,
): RawMoodleTask[] {
  const tasks: RawMoodleTask[] = [];
  let current: Record<string, IcsProperty> | null = null;

  for (const line of unfold(text)) {
    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (current) {
        const task = toTask(current, baseUrl, fallbackTzOffsetMin);
        if (task) tasks.push(task);
      }
      current = null;
      continue;
    }
    if (!current) continue;
    const prop = parseLine(line);
    if (prop) current[prop.name] = prop;
  }
  return tasks;
}

function toTask(
  props: Record<string, IcsProperty>,
  baseUrl: string,
  fallbackTzOffsetMin: number,
): RawMoodleTask | null {
  const uid = props["UID"]?.value?.trim();
  const summaryProp = props["SUMMARY"];
  if (!uid || !summaryProp) return null;

  const summary = unescapeText(summaryProp.value).trim();
  const { title, kind } = splitSummary(summary);

  // 締切は DTSTART。無いイベントのために DTEND も見る。
  const dtstart = props["DTSTART"] ?? props["DTEND"];
  const dueAt = dtstart ? parseDateTime(dtstart, fallbackTzOffsetMin) : null;

  const categories = props["CATEGORIES"]?.value;
  const courseName = categories ? shortenCourseName(unescapeText(categories)) : null;

  return {
    // UID は "12345@moodle.example.ac.jp" 形式。Moodle の event id 部分だけを鍵にする。
    sourceId: uid.split("@")[0] || uid,
    // iCal には科目 id が入らないので、科目名をそのまま鍵にする（Toggl プロジェクトの対応表用）
    courseId: courseName,
    courseName,
    title,
    kind,
    // URL プロパティを出さない Moodle があるため、DESCRIPTION からも拾う
    url: props["URL"]?.value?.trim() || extractUrl(props["DESCRIPTION"]?.value, baseUrl, dueAt),
    instanceId: null,
    dueAt,
  };
}

/**
 * CATEGORIES は科目のフルネームで、"CSCE All Students/情報理工・情報通信全学生" のように
 * 区切りを含む長い名前が入ることがある。
 *
 * 区切りで分割して片方だけを採る案も試したが、"英語名/日本語名" と "科目名/対象学部" が
 * 混在していて、どちらが科目名なのかを一般に判定できない。誤って切ると Toggl の
 * プロジェクト名が黙って別物になるため、**分割せず全体を使う**。
 * 表示を短くしたい場合はここだけを書き換えればよい。
 */
function shortenCourseName(raw: string): string | null {
  const trimmed = raw
    .trim()
    .replace(/\s+/g, " ")
    // 末尾の科目コード "(2019ZZ2600000126)" は読む側に意味がないので落とす。
    // 英大文字と数字だけ・8 文字以上の括弧に限定しているので、科目名を巻き込まない。
    .replace(/\s*[（(][A-Z0-9]{8,}[)）]\s*$/, "")
    .trim();
  if (!trimmed) return null;
  return trimmed.length > 60 ? `${trimmed.slice(0, 59)}…` : trimmed;
}

