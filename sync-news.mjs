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

/* ---- 盘前 / 盘后大幅异动的事件归因 ----
   池子来自 live-extra.js 的 movers（大中市值活跃股，与业绩标的池解耦）。
   命中「融资 / 增发 / 评级 / 订单 / 指引 / 回购 / 减持」这类因果词优先，其次取最新一条。 */
const MV_MIN = 4;
const mvSeen = new Set();
const mvTargets = [];
for (const ses of ["post", "pre"]) {
  for (const m of (Y.movers && Y.movers[ses]) || []) {
    if (mvSeen.has(m.sym)) continue;
    if (Math.abs(m[ses] || 0) < MV_MIN) continue;
    if (m.earn) continue; /* 财报驱动的归 ① 业绩表，这里只处理非财报驱动 */
    mvSeen.add(m.sym);
    mvTargets.push({ ...m, ses: ses, dom: m[ses], up: (m[ses] || 0) > 0 });
  }
}

/* 本场次时间窗口（北京时间）。原因必须发生在这次异动的窗口内，
   否则很容易把“前一天的旧闻”当成本次下跌的理由。
   - 盘后：美东 D 日 16:00 起 → 北京 D+1 04:00 ~ 14:00
   - 盘前：美东 D 日 04:00 起 → 北京 D 16:00 ~ 22:30
   （11 月为 EST，UTC-5，窗口已放宽 1 小时容忍） */
function winOf(m) {
  const D = String(m.date || "").replace(/-/g, "");
  if (D.length !== 8) return null;
  const base = new Date(D.slice(0, 4) + "-" + D.slice(4, 6) + "-" + D.slice(6, 8) + "T00:00:00+08:00").getTime();
  const at = (days, h, mi) => base + days * 864e5 + h * 3600e3 + (mi || 0) * 60e3;
  return m.ses === "post" ? [at(1, 4, 0), at(1, 14, 0)] : [at(0, 16, 0), at(0, 22, 30)];
}

/* 强因果事件词：出现即说明是“有具体事情”，而不是盘面综述 */
const STRONG = /融资|贷款|增发|配售|可转债|发债|定增|回购|减持|增持|评级|目标价|上调|下调|指引|订单|合同|中标|收购|并购|诉讼|调查|罚款|召回|出口管制|禁令|裁员|离职|辞职|CEO|CFO|投产|扩产|获批|业绩预告|下调预期/i;
/* 盘面综述 / ETF 点评：这类是二手报道，不能当归因 */
const SECONDARY = /ETF|标的指数|成分股|基金|收涨|收跌|吸金|美股三大指数/i;
const UP_RE = /涨|走强|飙升|拉升|走高|反弹|上涨|涨幅|新高/;
const DOWN_RE = /跌|下挫|下滑|走低|重挫|大跌|暴跌|承压|回落|跳水|跌幅|新低/i;
const parsed = (x) => new Date(String(x.showTime || "").replace(/-/g, "/")).getTime();
/* Yahoo 新闻兜底：东财快讯对中小盘覆盖有限，这些标的用英文媒体标题补（标注来源语言） */
async function yahooMoverNews(sym, win) {
  if (!win) return null;
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(sym)}&newsCount=15&quotesCount=0`, { headers: { "User-Agent": UA } });
    const j = await r.json();
    const inw = (j.news || []).filter((x) => {
      const t = (x.providerPublishTime || 0) * 1000;
      return t >= win[0] && t <= win[1];
    });
    if (!inw.length) return null;
    inw.sort((a, b) => (b.providerPublishTime || 0) - (a.providerPublishTime || 0));
    const n = inw[0];
    const bj = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date((n.providerPublishTime || 0) * 1000)).reduce((a, x) => (a[x.type] = x.value, a), {});
    return {
      title: n.title,
      t: bj.month + "-" + bj.day + " " + bj.hour + ":" + bj.minute,
      src: (n.publisher || "Yahoo Finance") + "（英文）",
      url: n.link,
    };
  } catch { return null; }
}

const mvNews = {};
/* 标题里必须真的出现该公司，否则不算“因此事而动” */
const titleHit = (t, m) => {
  const s = String(t || "").toLowerCase();
  if (m.sym && m.sym.length >= 3 && s.includes(String(m.sym).toLowerCase())) return true;
  if (m.cn && s.includes(String(m.cn).toLowerCase())) return true;
  if (m.en && String(m.en).length >= 5) {
    const w = String(m.en).toLowerCase().split(/[ ,]+/)[0];
    if (w.length >= 5 && s.includes(w)) return true;
  }
  return false;
};
for (const m of mvTargets) {
  /* 别名门槛：中文名 ≥2 字（“英伟达”只有 3 个字符，不能按英文 5 字符算）、英文名 ≥5 字符；
     代码始终作为别名之一（≥3 字符，大写更不易误伤） */
  const als = [];
  if (m.cn && String(m.cn).length >= 2) als.push(String(m.cn));
  if (m.en && String(m.en).length >= 5) als.push(String(m.en));
  if (m.sym && String(m.sym).length >= 3) als.push(String(m.sym));
  /* 公司必须是“标题主语”，或出现在摘要开头 —— 仅在正文后半段被提及的不算
     （反例：「杭州园林签署 GPU 采购合同」里提到英伟达，不能当成 NVDA 下跌的原因） */
  const hitOk = (x) => {
    const t = String(x.title || ""), s = String(x.summary || "");
    return als.some((a) => t.includes(a)) || als.some((a) => s.slice(0, 60).includes(a));
  };
  const hits = als.length ? corpus.filter(hitOk) : [];
  const win = winOf(m);
  const inWin = win ? hits.filter((x) => { const t = parsed(x); return !isNaN(t) && t >= win[0] && t <= win[1]; }) : [];

  if (!inWin.length) {
    const yn = await yahooMoverNews(m.sym, win);
    if (yn && titleHit(yn.title, m)) {
      mvNews[m.sym] = { ok: true, title: yn.title, summary: "", t: yn.t, src: yn.src, cause: false, en: true };
      continue;
    }
    const latest = hits.filter((x) => !isNaN(parsed(x))).sort((a, b) => parsed(b) - parsed(a))[0];
    mvNews[m.sym] = {
      ok: false,
      note: latest
        ? "原因未知（本场次窗口内未检索到对应消息；最近相关：" + norm(latest.title || "").slice(0, 48) + "，" + String(latest.showTime).slice(5, 16) + "）"
        : "原因未知（东财快讯与 Yahoo 新闻均未检索到本场次窗口内的消息，需人工核对公告）",
    };
    continue;
  }

  /* 打分：强事件 +3；盘面综述 −3；方向一致 +2、相反 −2；离收盘越近越好 */
  let best = null, bestScore = -99, bestMismatch = false;
  for (const x of inWin) {
    const txt = (x.title || "") + " " + (x.summary || "");
    let sc = 0;
    if (STRONG.test(txt)) sc += 3;
    if (SECONDARY.test(txt)) sc -= 3;
    const same = m.up ? UP_RE.test(txt) : DOWN_RE.test(txt);
    const opp = m.up ? DOWN_RE.test(txt) : UP_RE.test(txt);
    if (same) sc += 2;
    if (opp && !same) sc -= 2;
    if (win && parsed(x) - win[0] <= 6 * 3600e3) sc += 1; /* 收盘/开盘后 6h 内最贴近本次异动 */
    if (sc > bestScore || (sc === bestScore && parsed(x) > parsed(best || x))) {
      best = x; bestScore = sc; bestMismatch = opp && !same;
    }
  }
  const txt = (best.title || "") + " " + (best.summary || "");
  mvNews[m.sym] = {
    ok: true,
    title: norm(best.title || "").slice(0, 90),
    summary: norm(best.summary || "").slice(0, 170),
    t: String(best.showTime || "").slice(5, 16),
    src: "东方财富 7×24",
    cause: STRONG.test(txt) && !bestMismatch,
    mismatch: bestMismatch,
    score: bestScore,
    cand: inWin.length,
  };
}
const mvOk = Object.values(mvNews).filter((x) => x.ok).length;
const mvCause = Object.values(mvNews).filter((x) => x.cause).length;
console.log("异动归因：" + mvTargets.length + " 只待归因，窗口内匹配 " + mvOk + " 只，其中命中具体事件 " + mvCause + " 只");

/* ---- 地缘滚动跟踪：APEC / 美伊谈判 / 俄乌局势（geo-log.json 滚动积累，最新在前） ---- */
const GEO_RULES = [
  { re: /APEC|亚太经合/i, topic: "APEC", imp: "贸易与供应链" },
  { re: /美伊|伊朗/i, topic: "美伊谈判", imp: "原油与地缘风险溢价" },
  { re: /俄乌|乌克兰|俄罗斯|普京|泽连/i, topic: "俄乌局势", imp: "能源/军工/欧洲风险偏好" },
];
const GEO_READ = [
  [/停火|停战|和平|协议|谈判|会谈|磋商/, "谈判类表态先按「预期扰动」处理：有文本协议才算拐点，口头善意不改变仓位。"],
  [/制裁|禁运|关税|出口管制|没收|冻结/, "制裁升级利空受影响供应链、利好替代环节；落地前是情绪波动，不提前建仓。"],
  [/空袭|袭击|导弹|无人机|军事|军队|交火/, "军事行动抬高短期风险溢价，油价与黄金最先反应；未升级到封锁级事件通常 3-5 个交易日回吐。"],
  [/峰会|会见|声明|公报|宣言/, "峰会声明逐条核对：有具体承诺才计入基本面，措辞性共识不评分。"],
];
let geoLog = [];
try { geoLog = JSON.parse(readFileSync("geo-log.json", "utf8")); } catch {}
const seenG = new Set(geoLog.map((x) => x.t + "|" + x.topic));
const geoAll = [];
for (const x of corpus) {
  const txt = (x.title || "") + (x.summary || "");
  const rule = GEO_RULES.find((r) => r.re.test(txt));
  if (!rule) continue;
  const t = String(x.showTime || "").slice(0, 16);
  const key = t + "|" + rule.topic;
  if (seenG.has(key)) continue;
  const body = String(x.summary || x.title || "").trim().replace(/\s+/g, " ").slice(0, 150);
  const rd2 = GEO_READ.find(([re]) => re.test(body));
  geoAll.push({ t, topic: rule.topic, o: body, r: rd2 ? rd2[1] : "地缘表态，暂无具体动作，观察后续是否落地。", imp: rule.imp, isNew: true });
  seenG.add(key);
}
geoAll.sort((a, b) => b.t.localeCompare(a.t));
const geoItems = geoAll.slice(0, 12);
for (const it of geoItems) if (it.isNew) geoLog.unshift({ t: it.t, topic: it.topic, o: it.o, r: it.r, imp: it.imp });
const geoCutoff = new Date(Date.now() - 60 * 86400000).toISOString().slice(5, 10);
geoLog = geoLog.filter((x) => String(x.t).slice(0, 5) >= geoCutoff).slice(0, 60);
writeFileSync("geo-log.json", JSON.stringify(geoLog, null, 1), "utf8");
console.log("地缘跟踪：本轮新增 " + geoItems.length + " 条（APEC/美伊/俄乌），日志 " + geoLog.length + " 条");

/* 核心结论存档：brief-log.json（每日更新会话写入：daily/weekly/month-draft/month-final），透传给页面复盘 */
let briefLog = [];
try { briefLog = JSON.parse(readFileSync("brief-log.json", "utf8")); } catch {}
if (!Array.isArray(briefLog)) briefLog = [];
{
  const m = new Map(); /* 同日同 kind 只留最新一条（重复写入时以后写的为准） */
  for (const e of briefLog) if (e && e.d) m.set(e.d + "|" + (e.kind || "daily"), e);
  briefLog = [...m.values()];
}
const briefCutoff = new Date(Date.now() - 200 * 86400000).toISOString().slice(0, 10);
briefLog = briefLog.filter((x) => x.d >= briefCutoff)
  .sort((a, b) => b.d.localeCompare(a.d) || String(b.t || "").localeCompare(String(a.t || "")));
writeFileSync("brief-log.json", JSON.stringify(briefLog, null, 1), "utf8");
console.log("核心结论存档：" + briefLog.length + " 条（当日 " + briefLog.filter((x) => (x.kind || "daily") === "daily").length +
  " · 周月 " + briefLog.filter((x) => x.kind && x.kind !== "daily").length + "）");

writeFileSync("live-news.js", "window.NEWS_DATA = " + JSON.stringify({
  meta: { syncedAt: new Date().toISOString(), source: "东方财富 7×24 / Yahoo 标题", corpus: corpus.length, total: list.length, ok: okCount, full: fullCount },
  items: results,
  trump: { items: trumpItems, logCount: trumpLog.length },
  moversNews: mvNews,
  geo: { items: geoItems, logCount: geoLog.length },
  briefLog,
}, null, 1) + ";\n", "utf8");
console.log(`live-news.js｜${fullCount}/${list.length} 家有业绩数字，${okCount}/${list.length} 家有内容`);
