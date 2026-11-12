#!/usr/bin/env node
/**
 * 业绩内容抓取：业绩要点 / 指引 / 出处
 *
 * 数据源（按优先级，任一命中即用）：
 *   1) 东方财富 7×24 快讯（免费、无需 key、含中文公司名与数字，主用）
 *   2) Yahoo Finance 新闻标题（仅标题兜底）
 *
 * 输出：live-news.js → window.NEWS_DATA
 * 用法：node sync-news.mjs [--only=CRWV,PBR]
 */
import { readFileSync, writeFileSync } from "node:fs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/* ================= 名单 ================= */
const Y = JSON.parse(readFileSync("live-extra.js", "utf8").replace(/^window\.YF_DATA\s*=\s*/, "").replace(/;\s*$/, ""));
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? onlyArg.split("=")[1].split(",").map((s) => s.trim().toUpperCase()) : null;

const targets = [];
for (const r of Y.earnings.post || []) targets.push({ symbol: r.symbol, name: r.name, session: "post", date: Y.earnings.postDate });
for (const r of Y.earnings.pre || []) targets.push({ symbol: r.symbol, name: r.name, session: "pre", date: Y.earnings.preDate });
const list = only ? targets.filter((t) => only.includes(t.symbol)) : targets;

/* ================= 别名（中文名 + 英文名 + 代码） ================= */
const ALIAS = {
  PBR: ["巴西石油", "Petrobras", "Petroleo Brasileiro"],
  ALC: ["爱尔康", "Alcon", "爱尔康公司"],
  EC: ["Ecopetrol", "哥伦比亚国家石油", "哥伦比亚石油", "哥国油"],
  CRWV: ["CoreWeave", "Coreweave"],
  VIV: ["Telefonica Brasil", "巴西电信", "Vivo", "西班牙电信巴西"],
  MRCY: ["Mercury Systems", "水星系统", "Mercury系统"],
  RGTI: ["Rigetti", "里盖蒂", "Rigetti Computing"],
  FLY: ["FlyExclusive", "Fly Exclusive", "Flyex"],
  GIB: ["CGI", "CGI集团"],
  AYA: ["Aya Gold", "Aya Gold & Silver"],
  RUM: ["RUM Group"],
  BGSI: ["Boyd Group", "Boyd"],
  AADX: ["Applied Aerospace"],
  NYAX: ["Nayax"],
  FLNG: ["FLEX LNG"],
  ODD: ["ODDITY", "Oddity"],
  TTEK: ["Tetra Tech"],
  CTVA: ["Corteva", "科迪华"],
  ENS: ["EnerSys"],
  FNV: ["Franco-Nevada", "Franco Nevada"],
};

function aliasesOf(t) {
  const out = new Set();
  (ALIAS[t.symbol] || []).forEach((x) => out.add(x));
  const clean = (t.name || "")
    .replace(/[,.].*$/, "")
    .replace(/\b(Inc|Corp|Corporation|Ltd|Limited|plc|Co|Group|Holdings?)\b\.?/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (clean.length >= 4) out.add(clean);
  const first2 = clean.split(" ").slice(0, 2).join(" ");
  if (first2.length >= 4) out.add(first2);
  out.add(t.symbol);
  return [...out].filter((x) => x && x.length >= 3);
}

/* ================= 数据源 1：东方财富 7×24 快讯 ================= */
async function emPage(sortEnd) {
  const u = `https://np-weblist.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=${sortEnd || ""}&pageSize=100&req_trace=${Date.now()}`;
  const r = await fetch(u, { headers: { "User-Agent": UA, Referer: "https://kuaixun.eastmoney.com/" } });
  const j = await r.json();
  return j?.data?.fastNewsList || [];
}

async function buildCorpus(oldest) {
  const all = [];
  let end = "";
  for (let p = 0; p < 40; p++) {
    let rows;
    try { rows = await emPage(end); } catch (e) { console.warn("  东财翻页失败:", e.message); break; }
    if (!rows.length) break;
    all.push(...rows);
    const last = rows[rows.length - 1].showTime;
    if (last < oldest) break;
    end = rows[rows.length - 1].realSort || "";
    if (!end) break;
  }
  return all;
}

/* ================= 文本处理 ================= */
const fixNum = (s) => s.replace(/(\d)\.\s+(\d)/g, "$1.$2").replace(/\s{2,}/g, " ");
const norm = (s) => fixNum(s)
  .replace(/^\s*\d{4}-\d{2}-\d{2}\s*\d{2}:\d{2}(:\d{2})?\s*/, "")
  .replace(/^\s*【[^】]{0,60}】\s*/, "")
  .replace(/观点网讯[:：]?|香港万得通讯社报道[，,]?|讯[:：]/g, "")
  .replace(/\s+/g, " ").trim();

function sentences(t) {
  return norm(t).replace(/\n+/g, "。").split(/。|；|;/).map((x) => x.trim()).filter((x) => x.length >= 8 && x.length <= 220);
}

const RE_RES = /营收|营业收入|收入|每股|EPS|净利润|净亏损|毛利|销售额|同比增长|环比增长|超预期|低于预期/i;
const RE_GUIDE = /指引|预计|预期|资本支出|资本开支|capex|订单|积压|backlog|预付|电话会|管理层|CEO|展望|上调|下调|全年|毛利率/i;
const NUM = /\d/;

function pick(sents, re, used, n) {
  const out = [];
  for (const s of sents) {
    if (out.length >= n) break;
    if (used.has(s) || !re.test(s) || !NUM.test(s)) continue;
    out.push(s); used.add(s);
  }
  return out;
}

/* ================= 抓取 ================= */
const oldestD = new Date(Math.min(new Date(Y.earnings.postDate), new Date(Y.earnings.preDate)));
oldestD.setDate(oldestD.getDate() - 1);
const oldestStr = oldestD.toISOString().slice(0, 10) + " 00:00:00";

console.log("构建东财快讯语料（回溯至 " + oldestStr + "）…");
const corpus = await buildCorpus(oldestStr);
console.log("  语料 " + corpus.length + " 条，时间跨度 " + (corpus.length ? corpus[corpus.length - 1].showTime + " ~ " + corpus[0].showTime : "—"));

const results = {};
for (const t of list) {
  const als = aliasesOf(t);
  const hits = corpus.filter((x) => als.some((a) => (x.summary || x.title || "").includes(a)));
  /* 只保留与披露日同期的快讯，避免把上一季度旧闻当本次业绩 */
  const kept = hits.filter((x) => {
    const d = Math.abs((new Date(x.showTime.replace(/-/g, "/")) - new Date(t.date)) / 86400000);
    return d <= 1.5;
  });

  let res = [], guide = [], src = "", url = "", headline = "", date = "";
  if (kept.length) {
    const all = sentences(kept.map((x) => x.summary || x.title || "").join("。"));
    const used = new Set();
    res = pick(all, RE_RES, used, 3);
    guide = pick(all, RE_GUIDE, used, 3);
    const main = kept.slice().sort((a, b) => (b.summary || "").length - (a.summary || "").length)[0];
    headline = norm(main.title || "");
    date = (main.showTime || "").slice(0, 10);
    src = "东方财富 7×24";
    url = "https://kuaixun.eastmoney.com/";
  }

  const ok = !!(res.length || guide.length);
  results[t.symbol] = {
    symbol: t.symbol, name: t.name, session: t.session, ok,
    headline, date, url, res, guide, src,
    matched: hits.length, kept: kept.length,
    note: ok ? "" : (hits.length
      ? "有相关快讯 " + hits.length + " 条，但均非本次披露同期（已过滤）"
      : "东财快讯未检索到该公司本次业绩（小市值公司覆盖有限）"),
  };
  console.log(`  ${ok ? "✓" : "~"} ${t.symbol} res=${res.length} guide=${guide.length} 命中${hits.length}/留存${kept.length}｜${(headline || "").slice(0, 36)}`);
}

/* ================= 数据源 3：Yahoo 标题兜底 ================= */
async function yahooHeadline(t) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(t.symbol)}&newsCount=8&quotesCount=0`, { headers: { "User-Agent": UA } });
    const j = await r.json();
    const near = (j.news || []).filter((x) => Math.abs((new Date((x.providerPublishTime || 0) * 1000) - new Date(t.date)) / 86400000) <= 3);
    const n = near.find((x) => /result|earnings|quarter|profit|revenue|beats|misses/i.test(x.title || "")
      && !/forecast|expected to|preview|analyst|estimate|to announce/i.test(x.title || ""));
    return n ? { title: n.title, date: new Date((n.providerPublishTime || 0) * 1000).toISOString().slice(0, 10), url: n.link } : null;
  } catch { return null; }
}

for (const t of list) {
  const r = results[t.symbol];
  if (r && r.ok) continue;
  const h = await yahooHeadline(t);
  if (h) {
    results[t.symbol] = Object.assign({}, r || { symbol: t.symbol, name: t.name, session: t.session }, {
      ok: true, headline: h.title, date: h.date, url: h.url, res: [], guide: [],
      src: "Yahoo 新闻标题（仅标题）", note: "仅取到新闻标题，正文待补",
    });
    console.log(`  ~ ${t.symbol} Yahoo 标题兜底`);
  }
}

const okCount = Object.values(results).filter((x) => x.ok).length;
const fullCount = Object.values(results).filter((x) => (x.res || []).length).length;

/* ---- 川普语录：东财 7×24 过滤（转载 X / 财经媒体）+ trump-log.json 滚动积累 ---- */
const TRUMP_RE = /川普|特朗普|Trump/i;
const TRUMP_RULES = [
  [/关税|加征/, "关税威胁是其常用施压工具，历史落地率不足一半——按“预期扰动”处理，关注受影响行业收入敞口，不提前建仓。"],
  [/芯片|半导体/, "半导体关税/出口表态直接冲击设备与代工对华收入占比，落地前对板块是情绪扰动而非基本面变化。"],
  [/美联储|联储|降息|加息|鲍威尔/, "对联储独立性的施压与当前利率路径正面对撞，会放大波动，但不改变数据决定的政策方向。"],
  [/俄乌|乌克兰|俄罗斯|普京/, "地缘表态缺乏可执行细节时，对能源只有短期扰动，不作为交易依据。"],
  [/中国|中方/, "对华措辞影响出口链与港股风险偏好，关键看后续是否有具体政策动作。"],
  [/AI|人工智能|算力/, "AI 相关表态利好本土算力与电力投资，同时是出口管制进一步收紧的信号。"],
  [/石油|原油|OPEC/, "能源价格表态短期扰动油价，供需才是定价主轴。"],
];
let trumpLog = [];
try { trumpLog = JSON.parse(readFileSync("trump-log.json", "utf8")); } catch {}
const seenT = new Set(trumpLog.map((x) => x.t));
const trumpHits = corpus.filter((x) => TRUMP_RE.test((x.title || "") + (x.summary || "")));
const trumpItems = trumpHits.slice(0, 12).map((x) => {
  const txt = (x.summary || x.title || "").trim().replace(/\s+/g, " ").slice(0, 140);
  const t = (x.showTime || "").slice(5, 16);
  const rule = TRUMP_RULES.find(([re]) => re.test(txt));
  return {
    t, o: txt,
    src: "东方财富 7×24（转载 X / 财经媒体）",
    r: rule ? rule[1] : "情绪类表态，暂无具体政策动作，观察后续是否落地。",
    isNew: !seenT.has(t),
  };
});
for (const it of trumpItems) if (it.isNew) trumpLog.unshift({ t: it.t, o: it.o, src: it.src, r: it.r });
/* 滚动保留约 31 天（t 格式 "MM-DD HH:mm"，跨年仅在 12 月末有一处边界，可接受） */
const cutoffMD = new Date(Date.now() - 31 * 86400000).toISOString().slice(5, 10);
trumpLog = trumpLog.filter((x) => x.t.slice(0, 5) >= cutoffMD).slice(0, 40);
writeFileSync("trump-log.json", JSON.stringify(trumpLog, null, 1), "utf8");
console.log("川普语录：语料命中 " + trumpHits.length + " 条，本轮新增 " + trumpItems.filter((x) => x.isNew).length + " 条，日志 " + trumpLog.length + " 条");

writeFileSync("live-news.js", "window.NEWS_DATA = " + JSON.stringify({
  meta: { syncedAt: new Date().toISOString(), source: "东方财富 7×24 / Yahoo 标题", corpus: corpus.length, total: list.length, ok: okCount, full: fullCount },
  items: results,
  trump: { items: trumpItems, logCount: trumpLog.length },
}, null, 1) + ";\n", "utf8");
console.log(`live-news.js｜${fullCount}/${list.length} 家有业绩数字，${okCount}/${list.length} 家有内容`);
