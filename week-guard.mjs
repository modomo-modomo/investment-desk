/* week-guard.mjs — 事件日历周次窗口校验（20261122）
 *
 * 规则：页面「本周 / 下周」按北京时间自动选取，每周六 07:30 切换：
 *   周六 07:30 之前 → 本周 = 本周一~周日；周六 07:30 起与周日 → 本周 = 下周一~下周日。
 *
 * 本脚本只做校验，不改文件：
 *   ① DATA.events.weeks 是否已覆盖「本周」「下周」两个窗口（缺 → ::warning::，页面会如实显示“预排待录入”）；
 *   ② 每周是否 7 天、日期是否与周一日期连续对应。
 * 退出码恒为 0，不阻塞抓数；周六 07:30 场跑完后如果报缺周，按官方日历补录即可。
 */
import fs from "node:fs";

const html = fs.readFileSync("index.html", "utf8");
const m = html.match(/events:\{[\s\S]*?weeks:\[([\s\S]*?)\]\s*,\s*month:/);
if (!m) { console.log("::warning::index.html 未找到 events.weeks 结构，周次校验跳过"); process.exit(0); }

const starts = [...m[1].matchAll(/start:"(\d{4}-\d{2}-\d{2})"/g)].map((x) => x[1]);
const dayDates = [...m[1].matchAll(/date:"(\d{2}-\d{2})"/g)].map((x) => x[1]);

const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23"
}).formatToParts(new Date()).map((x) => [x.type, x.value]));
const base = new Date(p.year + "-" + p.month + "-" + p.day + "T00:00:00Z");
const dow = base.getUTCDay(), cur = (+p.hour) * 60 + (+p.minute);
let mon = new Date(base.getTime() + ((dow === 0 ? -6 : 1 - dow)) * 864e5);
if (dow === 0 || (dow === 6 && cur >= 7 * 60 + 30)) mon = new Date(mon.getTime() + 7 * 864e5);
const addD = (s, n) => new Date(Date.parse(s + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const thisW = mon.toISOString().slice(0, 10), nextW = addD(thisW, 7);

console.log("北京时间 " + p.year + "-" + p.month + "-" + p.day + " " + p.hour + ":" + p.minute +
  "｜周次锚点（本周一）" + thisW + "｜窗口：本周 " + thisW + " ~ " + addD(thisW, 6) + " / 下周 " + nextW + " ~ " + addD(nextW, 6));
console.log("已录入周次：" + (starts.length ? starts.join(", ") : "（无）"));

for (const [label, s] of [["本周", thisW], ["下周", nextW]]) {
  if (!starts.includes(s)) {
    console.log("::warning::事件日历缺少" + label + "预排（" + s + " 起）：页面会显示“预排待录入”，请按官方日历补录 DATA.events.weeks");
  }
}
const bad = starts.filter((s) => {
  const mmdd = s.slice(5);
  const want = Array.from({ length: 7 }, (_, i) => addD(s, i).slice(5));
  return !want.every((d) => dayDates.includes(d));
});
if (bad.length) console.log("::warning::以下周次的 7 天日期不完整或与周一起始日不对应：" + bad.join(", "));
if (!bad.length && starts.includes(thisW) && starts.includes(nextW)) console.log("周次校验通过 ✓");
