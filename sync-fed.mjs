#!/usr/bin/env node
/**
 * 美联储跟踪：议息概率（联邦基金期货推算）+ 主席/副主席/理事讲话摘要
 *
 * 概率口径：
 *   EFFR ← 纽约联储 markets API（真实有效联邦基金利率 + 目标区间）
 *   期货 ← CME 30 天联邦基金期货 ZQ（经 Yahoo 行情，逐月合约）
 *   算法 ← CME FedWatch 同法：r_after = (隐含月均利率 − EFFR×(1−w)) / w，w = 决议后剩余天数/当月天数
 *         隐含变动 ÷ 25bp → 相邻两档拆分概率（如 28bp = 加息25bp 88% + 加息50bp 12%）
 *   注：CME 官网已封禁脚本访问（403），故自行推算；页面会标注“自算”与计算基准。
 *
 * 讲话口径：
 *   名单 ← federalreserve.gov 理事会名录（Chairman / Vice Chair / Vice Chair for Supervision / Governor）
 *          → 只保留理事会成员，地区联储主席的讲话一律剔除
 *   正文 ← 讲话详情页正文，抽取关键句做摘要（规则筛选，非人工），重点词加粗
 *
 * 输出：fed-log.json（滚动留档）+ fed-news.js（window.FED_DATA）
 * 用法：node sync-fed.mjs [--dry]
 */
import { readFileSync, writeFileSync } from "node:fs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const DRY = process.argv.includes("--dry");
const BJ = (d) => new Date(d.getTime() + 8 * 3600e3).toISOString();

async function get(url, tries = 2) {
  let last;
  for (let i = 0; i < tries; i++) {
    const c = new AbortController();
    const to = setTimeout(() => c.abort(), 25000);
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" }, signal: c.signal, redirect: "follow" });
      return { ok: r.ok, status: r.status, text: await r.text() };
    } catch (e) { last = e; } finally { clearTimeout(to); }
  }
  throw last;
}
const decode = (s) => String(s || "")
  .replace(/<!\[CDATA\[|\]\]>/g, "")
  .replace(/&#8217;|&rsquo;/g, "’").replace(/&#8216;|&lsquo;/g, "‘")
  .replace(/&#8220;|&ldquo;/g, "“").replace(/&#8221;|&rdquo;/g, "”")
  .replace(/&#8212;|&mdash;/g, "—").replace(/&#8211;|&ndash;/g, "–")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, " ")
  .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

/* ================= 1) 理事会名单 ================= */
const BOARD = [];   /* {name, surname, title, zh} */
const ZH_TITLE = {
  "Chairman": "主席", "Chair": "主席",
  "Vice Chair": "副主席", "Vice Chairman": "副主席",
  "Vice Chair for Supervision": "监管副主席",
  "Governor": "理事",
};
const ZH_NAME = { Warsh: "沃什", Jefferson: "杰斐逊", Bowman: "鲍曼", Barr: "巴尔", Cook: "库克", Powell: "鲍威尔", Waller: "沃勒", Miran: "米兰", Kugler: "库格勒", Williams: "威廉姆斯", WilliamsJr: "威廉姆斯" };

async function loadBoard() {
  try {
    const r = await get("https://www.federalreserve.gov/aboutthefed/bios/board/default.htm", 1);
    const links = [...r.text.matchAll(/href="\/aboutthefed\/bios\/board\/([a-z]+)\.htm"[^>]*>([\s\S]{3,400}?)<\/a>/g)];
    for (const m of links) {
      const slug = m[1], txt = decode(m[2]);
      if (slug === "default" || slug === "boardmembership") continue;
      const cm = txt.match(/^(.*?),\s*(.+)$/);
      const name = (cm ? cm[1] : txt).trim();
      const title = (cm ? cm[2] : "Governor").trim();
      const surname = name.split(/\s+/).pop();
      BOARD.push({ name, surname, title, zh: ZH_NAME[surname] || surname, slug });
    }
  } catch (e) { console.log("理事会名单抓取失败：" + e.message); }
  console.log("理事会成员 " + BOARD.length + " 人：" + BOARD.map((b) => b.zh + "（" + b.title + "）").join("、"));
}
const bySurname = (s) => BOARD.find((b) => b.surname.toLowerCase() === String(s).toLowerCase());

/* ================= 2) FOMC 日历 ================= */
const FOMC_FALLBACK = ["2026-12-09", "2027-01-27", "2027-03-17", "2027-04-28", "2027-06-16", "2027-07-28", "2027-09-22", "2027-10-27", "2027-12-15"];
async function loadFomc() {
  /* 官方日历页：按 fomc-meeting 区块解析；年份取该区块之前最近的 “20xx FOMC Meetings” 标题 */
  try {
    const r = await get("https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", 1);
    const t = r.text;
    const heads = [...t.matchAll(/id="\d+">(20\d\d) FOMC Meetings/g)].map((m) => ({ y: +m[1], i: m.index }));
    const MON = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const out = [];
    const blocks = [...t.matchAll(/class="[^"]*\bfomc-meeting\b[^"]*"[\s\S]{0,600}?fomc-meeting__month[^>]*>\s*<strong>([A-Za-z]+)<\/strong>[\s\S]{0,200}?fomc-meeting__date[^>]*>\s*([\d\-]+)/g)];
    for (const m of blocks) {
      const mon = MON.indexOf(m[1]) + 1;
      if (!mon) continue;
      const y = heads.filter((h) => h.i < m.index).map((h) => h.y).pop();
      if (!y) continue;
      const days = (m[2].match(/\d{1,2}/g) || []).map(Number);
      if (!days.length) continue;
      out.push(y + "-" + String(mon).padStart(2, "0") + "-" + String(days[days.length - 1]).padStart(2, "0"));
    }
    const future = [...new Set(out)].filter((d) => d >= new Date().toISOString().slice(0, 10)).sort();
    if (future.length >= 2) { console.log("FOMC 日历：" + future.slice(0, 4).join(" · ")); return future; }
  } catch (e) { console.log("FOMC 日历解析失败，用内置日历：" + e.message); }
  return FOMC_FALLBACK.filter((d) => d >= new Date().toISOString().slice(0, 10));
}

/* ================= 3) 概率：EFFR + ZQ 期货 ================= */
const MC = { 1: "F", 2: "G", 3: "H", 4: "J", 5: "K", 6: "M", 7: "N", 8: "Q", 9: "U", 10: "V", 11: "X", 12: "Z" };
const zqSym = (y, m) => "ZQ" + MC[m] + String(y).slice(2) + ".CBT";

async function effr() {
  const r = await get("https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json", 2);
  const j = JSON.parse(r.text);
  const x = (j.refRates || [])[0] || {};
  return { rate: +x.percentRate, from: +x.targetRateFrom, to: +x.targetRateTo, date: x.effectiveDate };
}
async function zqClose(y, m) {
  try {
    const r = await get("https://query1.finance.yahoo.com/v8/finance/chart/" + zqSym(y, m) + "?range=5d&interval=1d", 1);
    const j = JSON.parse(r.text);
    const meta = j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
    if (!meta || meta.regularMarketPrice == null) return null;
    return { px: meta.regularMarketPrice, t: meta.regularMarketTime };
  } catch { return null; }
}
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

async function buildProbs() {
  let E;
  try { E = await effr(); } catch (e) { console.log("EFFR 抓取失败：" + e.message); return null; }
  const meetings = await loadFomc();
  if (meetings.length < 2) return null;
  const next = meetings[0];
  const [ny, nm, nd] = [+next.slice(0, 4), +next.slice(5, 7), +next.slice(8, 10)];
  const pad = (n) => String(n).padStart(2, "0");

  const cache = new Map();
  async function impliedOf(y, m) {
    const k = y + "-" + pad(m);
    if (cache.has(k)) return cache.get(k);
    const q = await zqClose(y, m);
    if (!q) { cache.set(k, null); return null; }
    const v = { rate: 100 - q.px, t: q.t, sym: zqSym(y, m) };
    cache.set(k, v);
    return v;
  }
  const mtIn = (y, m) => meetings.findIndex((d) => d.startsWith(y + "-" + pad(m)));
  /** 会议 i 之后的利率水平：递归到“下一个月无会议”的月份为止 */
  async function levelAfter(i, depth = 0) {
    if (depth > 3) return null;
    const y = +meetings[i].slice(0, 4), m = +meetings[i].slice(5, 7);
    const ny2 = m === 12 ? y + 1 : y, nm2 = m === 12 ? 1 : m + 1;
    const imp = await impliedOf(ny2, nm2);
    if (!imp) return null;
    const j = mtIn(ny2, nm2);
    if (j < 0) return imp.rate;                       /* 下月无会议 → 该月隐含利率即会后水平 */
    const L2 = await levelAfter(j, depth + 1);        /* 下月有会议 → 先解下下次会后水平 */
    if (L2 == null) return null;
    const d2 = +meetings[j].slice(8, 10);
    const dim2 = daysIn(ny2, nm2);
    const w2 = (dim2 - d2 + 1) / dim2;
    if (w2 <= 0.02 || w2 >= 0.98) return null;
    return (imp.rate - L2 * w2) / (1 - w2);
  }

  const after = await levelAfter(0);
  if (after == null) { console.log("会后利率推算失败"); return null; }
  const moveBp = (after - E.rate) * 100;

  const monthPx = await impliedOf(ny, nm);
  /* 相邻两档拆分：25bp 为一档 */
  const step = 25;
  let buckets = [];
  const push2 = (k0, k1, p1, dir) => {
    const label = (k) => (k === 0 ? "维持不变" : dir + " " + k * step + "bp");
    const color = (k) => (k === 0 ? "#7a8798" : dir === "加息" ? "#d2373a" : "#1f9d6b");
    buckets.push({ label: label(k0), p: (1 - p1) * 100, color: color(k0) });
    if (p1 > 0.005) buckets.push({ label: label(k1), p: p1 * 100, color: color(k1) });
  };
  if (moveBp >= 0) {
    const base = Math.floor(moveBp / step + 1e-9);
    push2(base, base + 1, Math.max(0, Math.min(1, (moveBp - base * step) / step)), "加息");
  } else {
    const abs = -moveBp;
    const base = Math.floor(abs / step + 1e-9);
    push2(base, base + 1, Math.max(0, Math.min(1, (abs - base * step) / step)), "降息");
  }
  buckets = buckets.filter((b) => b.p >= 0.2).map((b) => ({ ...b, p: Math.round(b.p * 10) / 10 }));

  /* 后续 3 次会议的隐含会后水平（看路径） */
  const path = [];
  for (let i = 1; i < Math.min(meetings.length, 4); i++) {
    const L = await levelAfter(i);
    if (L != null) path.push({ d: meetings[i], implied: Math.round(L * 1000) / 1000 });
  }

  const MZ = ["1 月", "2 月", "3 月", "4 月", "5 月", "6 月", "7 月", "8 月", "9 月", "10 月", "11 月", "12 月"];
  return {
    meeting: ny + " 年 " + MZ[nm - 1] + " " + (nd - 1) + "-" + nd + " 日",
    decision: (() => { const d = new Date(Date.UTC(ny, nm - 1, nd + 1)); return pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) + " 03:00（北京时间，决议公布）"; })(),
    nextDate: next,
    probs: buckets,
    impliedAfter: Math.round(after * 1000) / 1000,
    impliedMoveBp: Math.round(moveBp * 10) / 10,
    effr: E.rate, target: E.from + "–" + E.to + "%", effrDate: E.date,
    futPx: monthPx ? monthPx.rate : null, futSym: monthPx ? monthPx.sym : zqSym(ny, nm),
    futAt: BJ(new Date(((monthPx && monthPx.t) || Date.now() / 1000) * 1000)).slice(0, 16).replace("T", " "),
    path,
    src: "自算：EFFR " + E.rate + "%（纽约联储 " + E.date + "）+ 30 天联邦基金期货 " + zqSym(ny, nm) +
      " 及后续月份（Yahoo 行情）。算法同 CME FedWatch；CME 官网已封禁脚本抓取，故不引用其数字",
  };
}
function dstr(nd, nm, ny) {
  const d = new Date(Date.UTC(ny, nm - 1, nd));
  return (nm < 10 ? "0" : "") + nm + "-" + (nd < 10 ? "0" : "") + nd;
}

/* ================= 4) 讲话 ================= */
const KEY_RE = /inflation|monetary policy|federal funds rate|policy rate|labor market|employment|unemployment|balance sheet|restrictive|tariff|productivity|rate cut|rate hike|outlook/i;
const HAWK = /restrictive|elevated|upside risk|not yet|higher for longer|persistent|above (our )?2|firming|tighten|remain high|still high|further (rate )?(increase|hike)/gi;
const DOVE = /cooling|soften|easing|downside risk|patient|well positioned|gradual|cut|accommodat|slack/gi;
const BOLD = ["inflation", "inflation expectations", "federal funds rate", "policy rate", "restrictive", "labor market", "balance sheet", "tariff", "tariffs", "productivity", "rate cut", "rate hike"];

function pickSentences(body) {
  const sents = body.split(/(?<=[.!?])\s+(?=[A-Z“"(])/).map((s) => s.trim()).filter((s) => s.length > 60 && s.length < 420);
  const scored = sents.map((s, i) => {
    let sc = 0;
    const hits = (s.match(KEY_RE) || []).length;
    sc += hits * 3;
    if (i < 8) sc += 2;                       /* 开头段落通常是主旨 */
    if (/I (expect|anticipate|believe|will)/i.test(s)) sc += 1;
    if (/^(Thank you|It is a pleasure|I would like to thank)/i.test(s)) sc -= 4;
    return { s, i, sc };
  }).sort((a, b) => b.sc - a.sc).slice(0, 3).sort((a, b) => a.i - b.i);
  let out = scored.map((x) => x.s).join(" ");
  if (out.length > 420) out = out.slice(0, 415).replace(/[,;，；]\s*$/, "") + "…";
  return out;
}
function boldify(txt) {
  let out = txt, n = 0;
  for (const w of BOLD) {
    if (n >= 4) break;
    const re = new RegExp("\\b(" + w + ")\\b", "i");
    if (re.test(out)) { out = out.replace(re, "<b>$1</b>"); n++; }
  }
  return out;
}
function read(text) {
  const pts = [];
  const add = (t, txt) => pts.push({ t, txt });
  if (/inflation/i.test(text) && /(above|exceed|higher than|too high)[^.]{0,50}(target|2 percent|2%)/i.test(text)) add("hawk", "明确通胀仍高于目标，政策需要保持限制性");
  if (/(further|additional)[^.]{0,25}(tighten|firming|increase)/i.test(text)) add("hawk", "不排除进一步收紧");
  if (/tariff/i.test(text)) add("hawk", "把关税纳入通胀评估，供给端冲击可能延长紧缩时间");
  if (/(labor market|employment)[^.]{0,90}(cool|soften|slow|moderat|weak)/i.test(text)) add("dove", "就业市场在降温，为后续宽松留出空间");
  if (/(rate cut|cutting (rates|the target)|easing of policy|reduce the target range|lower the target range)/i.test(text)) add("dove", "提及降息或宽松路径");
  if (/balance sheet/i.test(text)) add("info", "提到资产负债表，缩表节奏影响准备金与流动性");
  if (/(AI|artificial intelligence|productivity)/i.test(text)) add("info", "强调 AI/生产率是供给端变量，属结构性而非周期信号");
  if (/uncertain/i.test(text)) add("info", "反复强调不确定性，倾向以数据为准、不做前瞻承诺");

  const h = pts.filter((x) => x.t === "hawk").length, d = pts.filter((x) => x.t === "dove").length;
  const hw = (text.match(HAWK) || []).length, dw = (text.match(DOVE) || []).length;
  const tone = h > d ? "偏鹰" : d > h ? "偏鸽" : hw > dw + 2 ? "偏鹰" : dw > hw + 2 ? "偏鸽" : "中性";
  const core = pts.filter((x) => x.t === (tone === "偏鹰" ? "hawk" : tone === "偏鸽" ? "dove" : "info"));
  const rest = pts.filter((x) => x.t === "info");
  const lines = [...core, ...rest].slice(0, 2).map((x) => x.txt);
  const readTxt = tone + "：" + (lines.length ? lines.join("；") : "表态围绕数据依赖，未给出明确方向指引") + "。";
  const impact = tone === "偏鹰"
    ? "短端利率与美元有上行压力，2Y 最敏感；成长股与长久期资产估值受压制，AI 基建 / Neocloud 的融资成本抬升"
    : tone === "偏鸽"
      ? "短端下行、曲线陡峭化，利好久期资产与黄金；成长股弹性大于价值，小盘与高杠杆板块受益"
      : "对定价影响有限，市场更看重随后公布的数据（CPI / 非农）而非表态本身";
  return { tone, read: readTxt, impact };
}

/* 纽约联储主席（FOMC 永久票委）：讲话不在联储官网，需从 newyorkfed.org 单独抓 */
const NYFED = { zh: "威廉姆斯", name: "John C. Williams", title: "President, Federal Reserve Bank of New York", role: "纽约联储主席 · 永久票委" };
async function loadNyFed() {
  const out = [];
  try {
    const r = await get("https://www.newyorkfed.org/newsevents/speeches", 2);
    const rows = [...r.text.matchAll(/<a href="(\/newsevents\/speeches\/(20\d\d)\/([a-z]+)(\d{2})(\d{2})(\d{2}))"[^>]*>([^<]+)<\/a>/g)];
    for (const m of rows) {
      const [, href, , slug, yy, mm, dd, title] = m;
      if (!/^wil/i.test(slug)) continue;                       /* 只要 Williams 本人 */
      if (!/^Williams\s*:/i.test(decode(title))) continue;
      const date = "20" + yy + "-" + mm + "-" + dd;
      if (date < new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10)) continue;
      out.push({
        date, url: "https://www.newyorkfed.org" + href,
        title: decode(title).replace(/^Williams\s*:\s*/i, "").trim(),
        speaker: "John C. Williams", venue: "", nyfed: true,
        member: { name: NYFED.name, surname: "Williams", title: NYFED.title, zh: NYFED.zh, role: NYFED.role },
      });
    }
  } catch (e) { console.log("纽约联储讲话抓取失败：" + e.message); }
  /* 去重 + 取最近 8 篇 */
  const seen = new Set();
  const uniq = out.filter((x) => (seen.has(x.url) ? false : (seen.add(x.url), true)));
  uniq.sort((a, b) => b.date.localeCompare(a.date));
  console.log("纽约联储主席讲话：命中 " + uniq.length + " 篇（近 400 天）");
  return uniq.slice(0, 8);
}

async function loadSpeeches() {
  const yr = new Date().getUTCFullYear();
  let list = [];
  try {
    const r = await get("https://www.federalreserve.gov/newsevents/speech/" + yr + "-speeches.htm", 2);
    const rows = r.text.split('<div class="row">').slice(1);
    for (const row of rows) {
      const tm = row.match(/<time>([^<]+)<\/time>/);
      if (!tm) continue;
      const dm = tm[1].trim().match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (!dm) continue;
      const date = dm[3] + "-" + dm[1].padStart(2, "0") + "-" + dm[2].padStart(2, "0");
      const lm = row.match(/<p><a href="(\/newsevents\/speech\/[^"]+\.htm)">([\s\S]*?)<\/a><\/p>/);
      if (!lm) continue;
      const sp = row.match(/class="news__speaker">([^<]+)</);
      const venue = row.match(/news__speaker">[^<]+<\/p>\s*<p>([\s\S]*?)<\/p>/);
      list.push({
        date, url: "https://www.federalreserve.gov" + lm[1],
        title: decode(lm[2]), speaker: sp ? decode(sp[1]) : "", venue: venue ? decode(venue[1]) : "",
      });
    }
  } catch (e) { console.log("讲话列表抓取失败：" + e.message); }
  /* 只留理事会成员（剔除地区联储主席） */
  const mine = [];
  for (const x of list) {
    const who = x.speaker.replace(/^(Chairman|Chair|Vice Chairman|Vice Chair for Supervision|Vice Chair|Governor)\s+/i, "").trim();
    const surname = who.split(/\s+/).pop();
    const b = bySurname(surname);
    if (!b) continue;                 /* 地区联储主席 / 非理事 */
    mine.push({ ...x, member: b });
  }
  const ny = await loadNyFed();
  const all = mine.concat(ny).sort((a, b) => b.date.localeCompare(a.date));
  console.log("讲话：联储官网 " + list.length + " 条 → 理事会 " + mine.length + " 条 ｜ 纽约联储主席 " + ny.length + " 条 ｜ 合计 " + all.length);
  return all;
}

async function enrich(list, prevLog) {
  const out = [];
  let fetched = 0;
  /* 抓取顺序：主席 → 纽约联储主席 → 副主席/理事，保证关键人物每轮都能进 */
  const prio = (x) => (/纽约联储/.test(x.member.role || "") ? 3 : ZH_TITLE[x.member.title] === "主席" ? 4 : 1);
  const order = list.slice().sort((a, b) => prio(b) - prio(a) || b.date.localeCompare(a.date));
  for (const x of order.slice(0, 30)) {
    const old = prevLog.find((p) => p.url === x.url);
    if (old) { out.push({ ...old, isNew: false }); continue; }
    if (fetched >= (prevLog.length ? 12 : 22)) continue;   /* 首轮多补（22 篇），之后每轮 12 篇 */
    let body = "";
    try {
      const r = await get(x.url, 2);
      const isNy = /newyorkfed\.org/.test(x.url);
      const i = isNy ? r.text.indexOf("<h1") : r.text.indexOf('id="article"');
      const j = r.text.indexOf('id="lastUpdate"', i);
      const seg = r.text.slice(i > 0 ? i : 0, j > i && j > 0 ? j : undefined);
      const paras = [...seg.matchAll(/<p[^>]*>([\s\S]{40,1500}?)<\/p>/g)]
        .map((m) => decode(m[1]))
        .filter((t) => t.length > 60 && !/Official websites use|Secure \.gov|Federal Open Market Committee$/.test(t));
      /* 去掉正文前的页眉：标题、讲者、日期、Share 之类 */
      const ttl = x.title.slice(0, 26).toLowerCase();
      const nm = x.member.name.toLowerCase();
      const clean = paras.filter((t) => {
        const low = t.toLowerCase();
        if (t.length < 220 && ttl && low.includes(ttl)) return false;
        if (t.length < 220 && low.includes(nm)) return false;
        if (/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+20\d\d/.test(t)) return false;
        if (/^(Share|Watch Live|Audio|Video)\b/i.test(t)) return false;
        if (/^At the [A-Z]/.test(t) && t.length < 320) return false;        /* 会议地点 */
        if (/^Thank you\b/i.test(t) && t.length < 260) return false;       /* 开场致谢 */
        return true;
      });
      body = clean.join(" ");
      fetched++;
    } catch { }
    if (!body) { console.log("  跳过（正文抓取失败）：" + x.date + " " + x.title.slice(0, 40)); continue; }
    const snip = pickSentences(body);
    if (!snip) { console.log("  跳过（无可抽取句）：" + x.date + " " + x.title.slice(0, 40)); continue; }
    const R = read(body);
    out.push({
      date: x.date, url: x.url, title: x.title, speaker: x.member.zh, en: x.member.name,
      role: x.member.role || ZH_TITLE[x.member.title] || x.member.title, venue: x.venue,
      snip: boldify(snip), tone: R.tone, read: R.read, impact: R.impact, isNew: true,
    });
    await sleep(500);
  }
  out.sort((a, b) => b.date.localeCompare(a.date));
  console.log("  精读成功 " + out.length + " 篇（候选 " + order.length + "，配额 " + (prevLog.length ? 12 : 22) + "）");
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================= 主流程 ================= */
await loadBoard();
const probs = await buildProbs();
if (probs) {
  console.log("议息：" + probs.meeting + " · 隐含会后 " + probs.impliedAfter + "%（EFFR " + probs.effr + "%），隐含变动 " +
    probs.impliedMoveBp + "bp → " + probs.probs.map((p) => p.label + " " + p.p + "%").join(" / "));
}
const speechesRaw = await loadSpeeches();

let log = [];
try { log = JSON.parse(readFileSync("fed-log.json", "utf8")); } catch { }
if (!Array.isArray(log)) log = [];
const speeches = await enrich(speechesRaw, log);
/* 滚动窗口：一般理事留 120 天；主席与纽约联储主席讲话少，留 400 天，避免“窗口内无主席讲话” */
const cut = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
const cutKey = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
const isKeyRole = (x) => x.role === "主席" || /纽约联储/.test(x.role || "");
log = speeches.filter((x) => x.date >= (isKeyRole(x) ? cutKey : cut))
  .sort((a, b) => b.date.localeCompare(a.date))
  .slice(0, 40);
console.log("讲话留档 " + log.length + " 条，本轮新增 " + log.filter((x) => x.isNew).length + " 条");

if (!DRY) {
  writeFileSync("fed-log.json", JSON.stringify(log, null, 1), "utf8");
  writeFileSync("fed-news.js", "window.FED_DATA = " + JSON.stringify({
    meta: {
      syncedAt: new Date().toISOString(),
      board: BOARD.map((b) => ({ zh: b.zh, en: b.name, title: ZH_TITLE[b.title] || b.title })),
      probsSrc: probs ? probs.src : "",
      note: "讲话摘要与解读为规则生成（关键句抽取 + 鹰鸽计数），非人工判断；原话以联储官网为准",
    },
    probs,
    speeches: log,
  }, null, 1) + ";\n", "utf8");
  console.log("已写入 fed-news.js / fed-log.json");
}
