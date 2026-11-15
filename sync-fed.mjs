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
import { inflateSync, inflateRawSync } from "node:zlib";

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
const KEY_RE = /inflation|monetary policy|federal funds rate|policy rate|labor market|employment|unemployment|balance sheet|restrictive|tariff|productivity|rate cut|rate hike|outlook|financial conditions|market|equit|yield|price stability/i;
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
const BOLD_ZH = ["通胀预期", "通胀", "联邦基金利率", "政策利率", "限制性", "劳动力市场", "就业", "资产负债表", "关税", "生产率", "降息", "加息"];
function boldZh(txt) {
  let out = txt, n = 0;
  for (const w of BOLD_ZH) {
    if (n >= 4) break;
    if (out.includes(w)) { out = out.replace(w, "<b>" + w + "</b>"); n++; }
  }
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

/* ================= 4b) 议息记者会（PDF 文稿 → 只留主席发言） =================
   联储每次议息后 1-2 天发布记者会逐字稿 PDF：
     https://www.federalreserve.gov/mediacenter/files/FOMCpresconfYYYYMMDD.pdf
   文稿里讲者名全大写 + " . " 分隔（CHAIRMAN WARSH . …），据此切出发言轮次，
   只保留主席本人的段落（开场声明 + 答问），用来判断他对市场 / 通胀 / 就业 / 利率的口径。 */
const TOPIC_DEF = [
  ["市场", /market|financial conditions|equit|stock|bond|yield|financial stability|asset price/i],
  ["通胀", /inflation|price stability|CPI|PCE|price level|prices/i],
  ["就业", /employment|unemployment|job|payroll|labor market|workforce|hiring/i],
  ["利率", /federal funds rate|policy rate|target range|rate (hike|cut)|restrictive|basis point|rate path/i],
];
const topicsOf = (t) => TOPIC_DEF.filter(([, re]) => re.test(t)).map(([k]) => k);

async function getBuf(url, tries = 2) {
  let last;
  for (let i = 0; i < tries; i++) {
    const c = new AbortController();
    const to = setTimeout(() => c.abort(), 30000);
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" }, signal: c.signal, redirect: "follow" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { last = e; } finally { clearTimeout(to); }
  }
  throw last;
}
function pdfUnescape(s) {
  return String(s).replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (m, g) => {
    if (g === "n") return "\n";
    if (g === "t") return "\t";
    if (g === "(") return "(";
    if (g === ")") return ")";
    if (g === "\\") return "\\";
    if (/^[0-7]+$/.test(g)) return String.fromCharCode(parseInt(g, 8));
    return "";
  });
}
/* 最小 PDF 文本抽取：inflate 每个 stream → 取 Tj / TJ 里的字符串 */
function pdfText(buf) {
  const raw = buf.toString("latin1");
  const chunks = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) continue;
    const seg = buf.subarray(start, end);
    let out = null;
    try { out = inflateSync(seg); } catch { try { out = inflateRawSync(seg); } catch { } }
    if (out) chunks.push(out.toString("latin1"));
  }
  const body = chunks.join("\n");
  const parts = [];
  const tj = /\((?:\\.|[^\\()])*\)\s*Tj|\[(?:[^\[\]]|\\.)*\]\s*TJ/g;
  let t;
  while ((t = tj.exec(body))) {
    const s = t[0];
    if (s.endsWith("TJ")) {
      const arr = s.slice(0, s.lastIndexOf("]"));
      parts.push([...arr.matchAll(/\((?:\\.|[^\\()])*\)/g)].map((x) => pdfUnescape(x[0].slice(1, -1))).join(""));
    } else {
      const mm = s.match(/\(((?:\\.|[^\\()])*)\)\s*Tj/);
      if (mm) parts.push(pdfUnescape(mm[1]));
    }
  }
  /* 清理 PDF 拆字：撇号变 \u0092、标点前多空格、单词被拆成 "don ’ t" */
  return parts.join(" ")
    .replace(/[\u0092\u2019]/g, "’")
    .replace(/\s+’\s+/g, "’")
    .replace(/\s+([.,;:!?%])/g, "$1")
    /* 分数写法归一化：3 ¾ → 3.75、¼ percentage point → 0.25 percentage point
       （不归一化的话机翻会把 3¾ 译成 "3.5%"、把 ¼ 译成 "0.4 个百分点"） */
    .replace(/(\d+(?:\.\d+)?)\s*([¼½¾])/g, (m, a, f) => (+a + FRAC[f]).toFixed(2))
    .replace(/([¼½¾])\s*(percentage point|basis points?|of a percentage point)/gi, (m, f, unit) => FRAC[f].toFixed(2) + " " + unit)
    .replace(/\s+/g, " ")
    .trim();
}
/* 按「全大写讲者名 + 空格句点」切轮次 */
function turns(text) {
  const re = /([A-Z][A-Z.'\- ]{2,40}?)\s\.\s/g;
  const marks = [];
  let m;
  while ((m = re.exec(text))) marks.push({ i: m.index, len: m[0].length, name: m[1].trim() });
  const out = [];
  for (let k = 0; k < marks.length; k++) {
    const s = marks[k].i + marks[k].len;
    const e = k + 1 < marks.length ? marks[k + 1].i : text.length;
    out.push({ name: marks[k].name, text: text.slice(s, e).trim() });
  }
  return out;
}
const FRAC = { "¼": 0.25, "½": 0.5, "¾": 0.75 };
function numOf(s) {
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*([¼½¾])?$/);
  if (!m) return null;
  return +m[1] + (m[2] ? FRAC[m[2]] : 0);
}
/* 从开场声明解析本次决议：动作 / 幅度 / 新目标区间
   注意：区间写法带分数（3¾ to 4），幅度只认「by a ¼ percentage point」这类短语，
   不能拿全文里的 ¾ 判幅度（9 月那次会被误判成 75bp） */
function parseDecision(text) {
  /* 按句定位：区间里的小数点（3.75）会被 [^.] 截断，所以先切句再在句内解析 */
  const sents = String(text).split(/(?<=[.!?])\s+/);
  const seg = sents.find((x) => /target (?:range|rate)/i.test(x) && /(raise|lower|maintain|leave|hold)/i.test(x)) || "";
  if (!seg) return null;
  const w = (seg.match(/(raise|lower|maintain|leave|hold)/i) || [])[1].toLowerCase();
  const act = w === "raise" ? "加息" : w === "lower" ? "降息" : "维持不变";
  let bp = 0;
  const bm = seg.match(/by\s+(?:a\s+|an\s+)?(¼|½|¾|\d+(?:\.\d+)?)\s*(?:percentage point|basis points?)/i);
  if (bm) {
    const v = bm[1];
    if (v === "¼") bp = 25; else if (v === "½") bp = 50; else if (v === "¾") bp = 75;
    else { const n = +v; bp = n < 1 ? Math.round(n * 100) : Math.round(n); }
  }
  const r = seg.match(/(\d+(?:\.\d+)?[¼½¾]?|[¼½¾])\s*(?:to|–|—|-)\s*(\d+(?:\.\d+)?[¼½¾]?|[¼½¾])\s*percent/i);
  let range = "";
  if (r) {
    const a = numOf(r[1]), b = numOf(r[2]);
    if (a != null && b != null) range = a.toFixed(2) + "–" + b.toFixed(2) + "%";
  }
  return { act, bp, range, label: act + (bp && act !== "维持不变" ? " " + bp + "bp" : "") + (range ? " → " + range : "") };
}

async function loadPressers(prevLog, limit = 3) {
  const out = [];
  let dates = [];
  try {
    const r = await get("https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", 2);
    dates = [...new Set([...r.text.matchAll(/\/monetarypolicy\/fomcpresconf(\d{8})\.htm/g)].map((m) => m[1]))];
  } catch (e) { console.log("记者会日历抓取失败：" + e.message); }
  const today = new Date().toISOString().slice(0, 10);
  dates = dates
    .map((d) => d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6, 8))
    .filter((d) => /^20\d\d-\d\d-\d\d$/.test(d) && d <= today)
    .sort().reverse();
  console.log("议息记者会：可用文稿 " + dates.length + " 场（最近 " + (dates[0] || "—") + "）");
  for (const date of dates.slice(0, limit)) {
    const ym = date.replace(/-/g, "");
    const url = "https://www.federalreserve.gov/mediacenter/files/FOMCpresconf" + ym + ".pdf";
    const old = (prevLog || []).find((p) => p.url === url);
    if (old) { out.push({ ...old, isNew: false }); continue; }
    try {
      const raw = pdfText(await getBuf(url, 2));
      const all = turns(raw);
      const chair = all.filter((t) => /^CHAIRMAN\s+WARSH/i.test(t.name)).map((t) => t.text).join(" ").trim();
      const body = chair || raw;                 /* 没有标记时退回全文（罕见） */
      if (body.length < 400) { console.log("  跳过（文稿过短）：" + date); continue; }
      const dec = parseDecision(body);
      const snips = pickPresserSentences(body);
      const snip = snips.length ? snips.join(" ／ ") : pickSentences(body);
      if (!snip) { console.log("  跳过（无可抽取句）：" + date); continue; }
      const R = read(body);
      let cnSnip = "";
      for (const one of (snips.length ? snips : [snip])) {
        const zh = await tr(one);
        if (zh) cnSnip += (cnSnip ? "；" : "") + zh.replace(/[。；;]\s*$/, "");
      }
      const cnTitle = await tr("Chairman Warsh's press conference, " + date) || ("议息会议记者会 " + date);
      await sleep(300);
      out.push({
        date, url, kind: "presser",
        title: "Chairman Warsh's Press Conference (" + date + ")",
        cnTitle: (date.slice(5, 7).replace(/^0/, "") + " 月议息会议记者会") + (dec ? " · " + dec.label : ""),
        speaker: "沃什", en: "Kevin Warsh", role: "主席",
        venue: dec ? dec.label : "",
        decision: dec, topics: topicsOf(body),
        snip: cnSnip ? boldZh(cnSnip) : boldify(snip), snipEn: snip,
        tone: R.tone, read: R.read, impact: R.impact, isNew: true,
      });
      console.log("  记者会 " + date + "：" + (dec ? dec.label : "决议未解析") + " · 主席发言 " + body.length + " 字符 · 主题 " + topicsOf(body).join("/"));
    } catch (e) { console.log("  记者会抓取失败 " + date + "：" + e.message); }
    await sleep(600);
  }
  return out;
}

/* 记者会取句：开场声明与政策声明重复，价值在答问里的前瞻表述，
   故跳过开头、排除记者提问（问号结尾）、按「主题命中 + 前瞻用词」打分；
   只取 2 句、每句在逗号处截断（口语长句机翻会糊成一团），并清掉 you know / I mean 之类填充词 */
function pickPresserSentences(body) {
  const sents = body.split(/(?<=[.!?])\s+(?=[A-Z“"(])/).map((s) => s.trim()).filter((s) => s.length > 80 && s.length < 430);
  const scored = sents.map((s, i) => {
    if (i < 4) return { s, i, sc: -99 };
    let sc = (s.match(KEY_RE) || []).length * 3;
    sc += TOPIC_DEF.filter(([, re]) => re.test(s)).length * 2;
    if (/I (expect|anticipate|believe|think|would|will)|going forward|in the (coming|months ahead)|over the (next|coming)|outlook|trajectory|path/i.test(s)) sc += 3;
    if (/\?\s*$/.test(s)) sc -= 6;
    if (/^(Q|QUESTION)/.test(s)) sc -= 4;
    return { s, i, sc };
  }).sort((a, b) => b.sc - a.sc).slice(0, 2).sort((a, b) => a.i - b.i);
  return scored.map((x) => {
    let t = x.s.replace(/\b(you know|I mean|um|uh|well,|so,)\b/gi, "").replace(/\s+/g, " ").replace(/^[,;\s]+/, "").trim();
    if (t.length > 210) {
      const cut = t.slice(0, 210);
      const k = Math.max(cut.lastIndexOf(", "), cut.lastIndexOf("; "));
      t = (k > 90 ? cut.slice(0, k) : cut) + "…";
    }
    return t;
  });
}

/* 综合预判：近 200 天主席表态的鹰鸽分布 + 最近一次记者会决议 + 期货自算概率是否同向 */
function predictOf(list, probs) {
  const cut = new Date(Date.now() - 200 * 864e5).toISOString().slice(0, 10);
  const recent = list.filter((x) => x.date >= cut);
  const h = recent.filter((x) => x.tone === "偏鹰").length;
  const d = recent.filter((x) => x.tone === "偏鸽").length;
  const n = recent.filter((x) => x.tone === "中性").length;
  const topicHit = {};
  recent.forEach((x) => (x.topics || []).forEach((k) => (topicHit[k] = (topicHit[k] || 0) + 1)));
  const dir = h > d ? "继续收紧" : d > h ? "转向宽松" : "维持观望";
  const lastP = recent.find((x) => x.kind === "presser" && x.decision);
  let agree = null;
  if (probs && probs.probs && probs.probs.length) {
    const top = probs.probs[0];
    const mkt = /加息/.test(top.label) ? "继续收紧" : /降息/.test(top.label) ? "转向宽松" : "维持观望";
    agree = mkt === dir;
    const dec = lastP && lastP.decision ? "最近一次记者会（" + lastP.date + "）已" + lastP.decision.label + "，" : "";
    return {
      tone: dir, hawk: h, dove: d, neutral: n, total: recent.length, topics: topicHit, agree,
      text: dec + "近 200 天主席表态 偏鹰 " + h + " / 中性 " + n + " / 偏鸽 " + d +
        " → 方向指向<b>" + dir + "</b>；期货自算 " + probs.meeting + "最可能为<b>" + top.label + " " + top.p + "%</b>，" +
        (agree ? "<b>与表态同向</b>（口径一致，可作为基准情形）" : "<b>与表态不同向</b>（市场定价走得更远或更近，注意会后修正风险）") + "。",
    };
  }
  return { tone: dir, hawk: h, dove: d, neutral: n, total: recent.length, topics: topicHit, agree: null,
    text: "近 200 天主席表态 偏鹰 " + h + " / 中性 " + n + " / 偏鸽 " + d + " → 方向指向<b>" + dir + "</b>（期货概率未取到，暂无法交叉验证）。" };
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
  /* 只保留主席（沃什）的讲话：副主席 / 理事 / 地区联储一律不收 */
  const chairOnly = mine.filter((x) => /^Warsh$/i.test(x.member.surname));
  console.log("讲话：联储官网 " + list.length + " 条 → 主席（沃什）" + chairOnly.length + " 条");
  return chairOnly;
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
    /* 英文 → 中文：标题与摘要都译，摘要保留英文原文备查 */
    const cnSnip = await tr(snip.replace(/<[^>]+>/g, ""));
    const cnTitle = await tr(x.title);
    await sleep(300);
    out.push({
      date: x.date, url: x.url, title: x.title, cnTitle: cnTitle || x.title,
      speaker: x.member.zh, en: x.member.name,
      role: x.member.role || ZH_TITLE[x.member.title] || x.member.title, venue: x.venue,
      snip: cnSnip ? boldZh(cnSnip) : boldify(snip), snipEn: snip,
      tone: R.tone, read: R.read, impact: R.impact, isNew: true,
    });
    await sleep(500);
  }
  out.sort((a, b) => b.date.localeCompare(a.date));
  console.log("  精读成功 " + out.length + " 篇（候选 " + order.length + "，配额 " + (prevLog.length ? 12 : 22) + "）");
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================= 英译中（免费接口，失败回退） ================= */
const trCache = new Map();
async function tr(text) {
  const src = String(text || "").trim();
  if (!src) return "";
  if (trCache.has(src)) return trCache.get(src);
  let out = "";
  try {
    const u = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=" + encodeURIComponent(src.slice(0, 1800));
    const r = await get(u, 2);
    const j = JSON.parse(r.text);
    out = (j[0] || []).map((x) => x[0]).join("").trim();
  } catch { }
  if (!out) {
    try {
      const u = "https://api.mymemory.translated.net/get?langpair=en|zh-CN&q=" + encodeURIComponent(src.slice(0, 450));
      const r = await get(u, 1);
      out = (JSON.parse(r.text).responseData || {}).translatedText || "";
    } catch { }
  }
  if (!out) out = "";
  trCache.set(src, out);
  return out;
}

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
/* 议息记者会（含 9 月会议）——主席开场声明 + 答问，按「市场 / 通胀 / 就业 / 利率」四大主题抽取 */
const pressers = await loadPressers(log, 3);
const merged = speeches.concat(pressers)
  .filter((x, i, a) => a.findIndex((y) => y.url === x.url) === i);
/* 长期滚动积累：主席讲话本来就少，保留 400 天 / 最多 60 条 */
const cut = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
log = merged.filter((x) => x.date >= cut)
  .sort((a, b) => b.date.localeCompare(a.date))
  .slice(0, 60);
const predict = predictOf(log, probs);
console.log("讲话留档 " + log.length + " 条（含记者会 " + log.filter((x) => x.kind === "presser").length +
  " 场），本轮新增 " + log.filter((x) => x.isNew).length + " 条");
console.log("预判：" + predict.text.replace(/<[^>]+>/g, ""));

if (!DRY) {
  writeFileSync("fed-log.json", JSON.stringify(log, null, 1), "utf8");
  writeFileSync("fed-news.js", "window.FED_DATA = " + JSON.stringify({
    meta: {
      syncedAt: new Date().toISOString(),
      board: BOARD.map((b) => ({ zh: b.zh, en: b.name, title: ZH_TITLE[b.title] || b.title })),
      probsSrc: probs ? probs.src : "",
      note: "讲话摘要与解读为规则生成（关键句抽取 + 鹰鸽计数），非人工判断；原话以联储官网为准。含议息会议记者会（只取主席发言）。",
    },
    probs,
    predict,
    speeches: log,
  }, null, 1) + ";\n", "utf8");
  console.log("已写入 fed-news.js / fed-log.json");
}
