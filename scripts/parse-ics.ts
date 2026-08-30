/**
 * 手元の .ics を実際のパーサに通して、正規化結果を確認する開発用スクリプト。
 *
 *   npm run parse:ics -- /tmp/moodle.ics
 *
 * ネットワークにも Slack にも触れず、認証情報も読まない。
 * 大学ごとに違う Moodle の書式に合わせ込むときはこれで確かめる。
 */
import { readFileSync } from "node:fs";
import { parseIcs } from "../src/moodle/ical";
import { dueGroupLabel, formatDue, formatRemaining } from "../src/time";

const path = process.argv[2];
if (!path) {
  console.error("使い方: npm run parse:ics -- <path/to/moodle.ics> [moodle-base-url]");
  process.exit(1);
}
const baseUrl = process.argv[3] ?? "https://wsdmoodle.waseda.jp";

const tasks = parseIcs(readFileSync(path, "utf-8"), baseUrl, 540);
const now = Math.floor(Date.now() / 1000);

console.log(`\n取り込めたイベント: ${tasks.length} 件\n`);

const kinds = new Map<string, number>();
let noDue = 0;
let noCourse = 0;
let noUrl = 0;

for (const t of tasks) {
  kinds.set(t.kind, (kinds.get(t.kind) ?? 0) + 1);
  if (t.dueAt === null) noDue++;
  if (!t.courseName) noCourse++;
  if (!t.url) noUrl++;
}

console.log("種別の内訳:", Object.fromEntries(kinds));
console.log(`締切なし: ${noDue} / 科目名なし: ${noCourse} / リンクなし: ${noUrl}\n`);

const upcoming = tasks
  .filter((t) => t.dueAt !== null && t.dueAt > now)
  .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0))
  .slice(0, 12);

console.log("これから締切を迎えるもの（App Home に並ぶ順）:");
for (const t of upcoming) {
  const due = t.dueAt!;
  console.log(
    `  [${dueGroupLabel(due, now)}] ${formatDue(due, now)} (${formatRemaining(due, now)})\n` +
      `      ${t.kind.padEnd(6)} ${t.courseName ?? "(科目名なし)"} / ${t.title}\n` +
      `      ${t.url ?? "(リンクなし)"}`,
  );
}
if (upcoming.length === 0) console.log("  なし");
console.log();
