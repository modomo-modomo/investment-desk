#!/usr/bin/env node
/**
 * Yahoo Finance + Nasdaq 辅助数据 → live-extra.js
 *  1) 与 Wind 逐票交叉校验（14 只）
 *  2) 补 Wind 缺口（BTC / 11 个板块 ETF / 标普量能）
 *  3) 当日真实财报日历（Nasdaq 单一日历口径，避免跨源错配）
 *     - 盘前表：今日盘前披露；盘后表：昨日盘后披露
 *     - 预测与实际 EPS 取自同一行，保证 surprise 自洽
 *     - 盘前/盘后股价反应取 Yahoo quote
 *  4) 覆盖标的的"下次财报日"（Yahoo calendarEvents）→ 强制跟踪业绩发布日
 * 用法：node sync-extra.mjs
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
/* 日期按美东时区自动推算，云端定时运行不需要人工传入。
 * 北京 20:30 → 美东当天 07:30：pre=今天、post=昨天（完整）
 * 北京 07:00 → 美东当天 18:00：pre=今天（可回填收盘）、post=昨天 */
const etDate = (off = 0) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(Date.now() + off * 86400e3));
const TODAY = process.env.RPT_PRE || etDate(0);   // 今日（盘前披露）
const YEST  = process.env.RPT_POST || etDate(-1); // 昨日（盘后披露）

/* 带退避重试：云端出口 IP 属数据中心段，Yahoo 偶发 429/5xx */
async function jget(url, headers = {}, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...headers } });
    if (r.ok) return r.json();
    lastErr = new Error(`HTTP ${r.status} ${url.slice(0, 90)}`);
    if ((r.status === 429 || r.status >= 500) && i < tries - 1) {
      await new Promise((s) => setTimeout(s, 1200 * (i + 1)));
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}

/* ---------------- Yahoo 鉴权 ---------------- */
let COOKIE = "", CRUMB = "";
async function yahooAuth() {
  try {
    const r = await fetch("https://fc.yahoo.com", { headers: { "User-Agent": UA } });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    COOKIE = sc.map((c) => c.split(";")[0]).join("; ");
    CRUMB = (await (await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": UA, cookie: COOKIE },
    })).text()).trim();
  } catch (e) { console.warn("Yahoo 鉴权失败:", e.message); }
}

/* ---------------- 行情 ---------------- */
async function chart(symbol, range = "3mo", interval = "1d") {
  const j = await jget(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=true`);
  const r = j?.chart?.result?.[0];
  if (!r) throw new Error(`chart 无结果 ${symbol}`);
  const q = r.indicators.quote[0];
  const rows = r.timestamp.map((t, i) => ({
    date: new Date(t * 1000).toISOString().slice(0, 10),
    close: q.close?.[i] ?? null,
    volume: q.volume?.[i] ?? null,
    ts: t,
  })).filter((x) => x.close != null);
  return { meta: r.meta, rows };
}

async function quotes(symbols) {
  if (!symbols.length) return {};
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols.map(encodeURIComponent).join(",")}&crumb=${encodeURIComponent(CRUMB)}`;
  try {
    const j = await jget(url, { cookie: COOKIE });
    const out = {};
    for (const q of j?.quoteResponse?.result || []) out[q.symbol] = q;
    return out;
  } catch { return {}; }
}

/* Yahoo 口径的实际 EPS，用于与实际披露做双源确认 */
async function yahooActual(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=earningsHistory,incomeStatementHistoryQuarterly&crumb=${encodeURIComponent(CRUMB)}`;
    const j = await jget(url, { cookie: COOKIE });
    const res = j?.quoteSummary?.result?.[0];
    const hist = res?.earningsHistory?.history || [];
    const h = hist[hist.length - 1];

    /* 季度利润表：取最新一期 + 去年同季，算营收/净利同比 */
    const qs = res?.incomeStatementHistoryQuarterly?.incomeStatementHistory || [];
    const pick = (x, k) => (x && x[k] ? x[k].raw : null);
    const latest = qs[0], yearAgo = qs[4];
    const fund = latest ? {
      period: latest.endDate?.fmt || null,
      rev: pick(latest, "totalRevenue"),
      revPrev: pick(yearAgo, "totalRevenue"),
      net: pick(latest, "netIncome"),
      netPrev: pick(yearAgo, "netIncome"),
      gross: pick(latest, "grossProfit"),
    } : null;

    if (!h && !fund) return null;
    return {
      quarter: h?.quarter?.fmt || null,
      actual: h?.epsActual?.raw ?? null,
      estimate: h?.epsEstimate?.raw ?? null,
      fund,
    };
  } catch { return null; }
}

/* 覆盖标的的下一财报日（强制跟踪业绩发布日） */
async function nextEarnings(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=calendarEvents,defaultKeyStatistics&crumb=${encodeURIComponent(CRUMB)}`;
    const j = await jget(url, { cookie: COOKIE });
    const c = j?.quoteSummary?.result?.[0]?.calendarEvents;
    const arr = c?.earnings?.earningsDate || [];
    const dates = arr.map((x) => x.fmt).filter(Boolean);
    return dates.length ? dates : null;
  } catch { return null; }
}

/* ---------------- 1. 交叉校验 ---------------- */
const CHECK = {
  TSLA: "TSLA", META: "META", IREN: "IREN", NBIS: "NBIS", CRWV: "CRWV", BE: "BE",
  AMD: "AMD", TSM: "TSM", TER: "TER", ONTO: "ONTO", NET: "NET", RBRK: "RBRK", OKTA: "OKTA", CHKP: "CHKP",
};
const quotesOut = {};
for (const [t, sym] of Object.entries(CHECK)) {
  try {
    const c = await chart(sym, "3mo");
    const last = c.rows[c.rows.length - 1], prev = c.rows[c.rows.length - 2];
    quotesOut[t] = {
      symbol: sym,
      price: c.meta.regularMarketPrice ?? last.close,
      prevClose: prev?.close ?? null,
      chg: prev?.close ? (last.close / prev.close - 1) * 100 : null,
      w52h: c.meta.fiftyTwoWeekHigh ?? null,
      w52l: c.meta.fiftyTwoWeekLow ?? null,
      date: last.date,
    };
  } catch (e) { console.warn(`行情失败 ${t}:`, e.message); }
}

/* ---------------- 2. 补缺 ---------------- */
const SECTORS = { XLK: "信息技术", XLC: "通信服务", XLY: "可选消费", XLF: "金融", XLV: "医疗", XLI: "工业", XLB: "原材料", XLE: "能源", XLP: "必需消费", XLU: "公用事业", XLRE: "房地产" };
const sectors = {};
for (const [sym, cn] of Object.entries(SECTORS)) {
  try {
    const c = await chart(sym, "3mo");
    const last = c.rows[c.rows.length - 1], prev = c.rows[c.rows.length - 2];
    const base = c.rows.length >= 21 ? c.rows[c.rows.length - 21] : null;
    sectors[sym] = { cn, chg: prev ? (last.close / prev.close - 1) * 100 : null, d20: base ? (last.close / base.close - 1) * 100 : null };
  } catch {}
}

/* 加密 24×7：日线最后一根可能"进行中"或 close=null（Yahoo 结算延迟），
   不能当收盘。口径统一为"昨日 UTC 收盘"：
   - 价格：1h 线里今日 UTC 0 点前最后一根已收线的收盘（即昨日 23:00–24:00 UTC 的收）
   - 20 日基准 / 前收：日线序列中已完成的K线 */
const utcToday = new Date().toISOString().slice(0, 10);
const prevUTC = new Date(Date.parse(utcToday + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);

async function cryptoClose(sym) {
  const daily = await chart(sym, "3mo");
  const done = daily.rows.filter((r) => r.date < utcToday);
  const base = done.length >= 21 ? done[done.length - 21] : done[0];
  const prevDay = done[done.length - 1];
  let price = prevDay.close;
  try {
    const h = await chart(sym, "5d", "60m");
    const cutoff = Date.parse(utcToday + "T00:00:00Z") / 1000 - 1;
    let lastH = null;
    for (const r of h.rows) if (r.ts <= cutoff) lastH = r;
    if (lastH) price = lastH.close;
  } catch (e) { console.warn(sym + " 小时线取值失败，回退日线:", e.message); }
  return {
    price,
    chg: prevDay ? (price / prevDay.close - 1) * 100 : null,
    d20: base ? (price / base.close - 1) * 100 : null,
    date: prevUTC,
  };
}

let btc = null, eth = null;
try { btc = await cryptoClose("BTC-USD"); } catch (e) { console.warn("BTC 失败:", e.message); }
try { eth = await cryptoClose("ETH-USD"); } catch (e) { console.warn("ETH 失败:", e.message); }

/* 等权 vs 市值加权：个股分化的可计算代理（RSP / SPY） */
let breadth = null;
try {
  const [rsp, spy] = await Promise.all([chart("RSP", "3mo"), chart("SPY", "3mo")]);
  const rd = rsp.rows, sd = spy.rows;
  const r20 = rd.length >= 21 ? (rd[rd.length - 1].close / rd[rd.length - 21].close - 1) * 100 : null;
  const s20 = sd.length >= 21 ? (sd[sd.length - 1].close / sd[sd.length - 21].close - 1) * 100 : null;
  breadth = { rsp20: r20, spy20: s20, rel20: (r20 != null && s20 != null) ? r20 - s20 : null };
} catch (e) { console.warn("等权/市值权重失败:", e.message); }

let spxVol = null;
try {
  const c = await chart("^GSPC", "6mo");
  const vols = c.rows.map((r) => r.volume).filter(Boolean);
  const avg20 = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  spxVol = { today: vols[vols.length - 1], avg20, ratio: vols[vols.length - 1] / avg20 };
} catch (e) { console.warn("SPX 量能失败:", e.message); }

/* ---------------- 3. 财报日历 ---------------- */
const capNum = (s) => { try { return Number(String(s).replace(/[$,]/g, "")); } catch { return 0; } };
const numOf = (s) => {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t || t === "N/A") return null;
  const neg = /^\(.*\)$/.test(t);
  const v = Number(t.replace(/[()$,]/g, ""));
  return Number.isFinite(v) ? (neg ? -v : v) : null;
};
/* 日历快照缓存：Nasdaq 在披露完成后会把 time 置为 time-not-supplied，
   导致"昨日盘后"名单在次日之后无法复原——所以首次看到的名单要落盘。 */
let CALCACHE = {};
try { CALCACHE = JSON.parse(readFileSync("cal-cache.json", "utf8")); } catch {}

async function cal(date, session) {
  const fresh = (await jget(`https://api.nasdaq.com/api/calendar/earnings?date=${date}`))?.data?.rows || [];
  const tagged = fresh.filter((r) => r.time === session).map((r) => r.symbol);
  const key = `${date}|${session}`;
  const c = CALCACHE[key];
  if (!c || tagged.length > c.symbols.length) {
    CALCACHE[key] = { at: new Date().toISOString(), symbols: tagged };
  }
  const keep = new Set(CALCACHE[key].symbols);
  const hit = fresh.filter((r) => keep.has(r.symbol));
  if (process.env.DBG) console.log(`  [dbg] ${key} fresh=${fresh.length} tagged=${tagged.length} keep=${keep.size} hit=${hit.length}`);
  return { rows: hit, total: keep.size, fromCache: tagged.length < keep.size };
}


function tier(mcap) {
  if (mcap >= 10e9) return "大市值";
  if (mcap >= 2e9) return "中市值";
  return "中小市值";
}
function threshold(t) { return t === "大市值" ? 3 : t === "中市值" ? 3 : 5; }

async function build(date, session, limit) {
  let snap = { rows: [], total: 0, fromCache: false };
  try { snap = await cal(date, session); } catch (e) { console.warn("日历失败", date, e.message); }

  const rows = snap.rows;
  /* 用缓存名单时，日历可能已丢失 marketCap，不能再按市值过滤，否则整表塌掉 */
  const pool = rows.filter((r) => snap.fromCache ? true : capNum(r.marketCap) > 0);
  const seenSym = new Set(), seenName = new Set();
  const picked = pool
    .filter((r) => capNum(r.marketCap) > 0)
    .sort((a, b) => capNum(b.marketCap) - capNum(a.marketCap))
    // 去掉同一公司的第二类别股（PBR.A / BRK.B 之类），避免重复
    .filter((r) => {
      if (r.symbol.includes(".") && rows.some((x) => x.symbol === r.symbol.split(".")[0])) return false;
      if (seenName.has(r.name) || seenSym.has(r.symbol)) return false;
      seenName.add(r.name); seenSym.add(r.symbol);
      return true;
    })
    .slice(0, limit);

  const q = await quotes(picked.map((r) => r.symbol));
  const MON = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
  const out = [];
  for (const r of picked) {
    const m = q[r.symbol] || {};
    const mcap = capNum(r.marketCap);
    const tr = tier(mcap);
    const qEnd = r.fiscalQuarterEnding || "";
    const want = qEnd.replace(/([A-Za-z]{3})\/(\d{4})/, (_, mo, yr) => `${yr}-${MON[mo] || "01"}`);

    /* 实际值：优先 Yahoo earningsHistory（同财季才算数），Nasdaq 的 eps 字段仅作备查。
       理由：Nasdaq eps 与 Yahoo 大面积不一致（PBR 0.82 vs 1.45、VIV 0.22 vs 1.54），
       而 Yahoo 的 actual/estimate 在同一行内自洽，且与盘前盘后股价反应的方向吻合。 */
    const y = await yahooActual(r.symbol);
    const yMatch = !!(y && y.actual != null && y.quarter && y.quarter.slice(0, 7) === want);
    const nasAct = numOf(r.eps);

    const actual = yMatch ? y.actual : nasAct;
    const est = yMatch && y.estimate != null ? y.estimate : numOf(r.epsForecast);
    const src = yMatch ? "Yahoo earningsHistory" : (nasAct != null ? "Nasdaq 日历" : null);
    // 同源分子分母，分母取 |est|，负 EPS 时表达为"减亏/扩亏幅度"
    const surprise = actual != null && est != null && est !== 0 ? ((actual - est) / Math.abs(est)) * 100 : null;

    let cross = null;
    if (yMatch && nasAct != null) {
      const diff = Math.abs(nasAct - y.actual) / Math.max(Math.abs(nasAct), Math.abs(y.actual), 0.01);
      cross = { yahoo: y.actual, nasdaq: nasAct, diffPct: diff * 100, conflict: diff > 0.2 };
    }

    const prevClose = m.regularMarketPreviousClose ?? null;
    const reg = m.regularMarketPrice ?? null;
    const preChg = m.preMarketPrice && prevClose ? (m.preMarketPrice / prevClose - 1) * 100 : null;
    const postChg = m.postMarketPrice && reg ? (m.postMarketPrice / reg - 1) * 100 : null;

    out.push({
      symbol: r.symbol, name: r.name, mcap, tier: tr, threshold: threshold(tr),
      quarter: qEnd || null,
      est, estRaw: r.epsForecast || null, nEst: r.noOfEsts || null,
      last: numOf(r.lastYearEPS), lastRaw: r.lastYearEPS || null,
      actual, reported: actual != null, surprise, src, cross,
      fund: (y && y.fund) || null,
      price: reg, prevClose,
      preChg, postChg,
      dayChg: m.regularMarketChangePercent ?? null,
      marketState: m.marketState || null,
    });
  }
  return { rows: out, total: snap.total || pool.length, fromCache: snap.fromCache,
           /* 该场次「全部」披露标的（含被 limit 截掉的），用于把异动分成“财报驱动 / 非财报驱动” */
           allSyms: [...new Set(rows.map((r) => String(r.symbol || "").replace(/\./g, "-")))],
           hit: out.filter((r) => Math.abs(r.postChg ?? r.preChg ?? 0) >= r.threshold).length };
}

await yahooAuth();
const pre = await build(TODAY, "time-pre-market", 8);
const post = await build(YEST, "time-after-hours", 8);

/* 覆盖标的下一财报日 */
const nextEarn = {};
for (const sym of Object.values(CHECK)) {
  const d = await nextEarnings(sym);
  if (d) nextEarn[sym] = d;
}

/* 交叉校验：Wind 与 Yahoo 收盘价差 */
let crosscheck = null;
/* 双端点校验：live-data.js 的收盘价来自 chart v8，live-extra.js 的现价来自 quote v7。
 * 两者是 Yahoo 的两个独立接口，一致即说明抓取链路没出错。 */
try {
  if (existsSync("live-data.js")) {
    const src = readFileSync("live-data.js", "utf8").replace(/^window\.WIND_LIVE\s*=\s*/, "").replace(/;\s*$/, "");
    const W = JSON.parse(src);
    const CODE = { TSLA: "TSLA.O", META: "META.O", IREN: "IREN.O", NBIS: "NBIS.O", CRWV: "CRWV.O", BE: "BE.N", AMD: "AMD.O", TSM: "TSM.N", TER: "TER.O", ONTO: "ONTO.N", NET: "NET.N", RBRK: "RBRK.N", OKTA: "OKTA.O", CHKP: "CHKP.O" };
    const rows = [];
    /* 真正的双端点：chart v8 的"昨收" vs quote v7 的 regularMarketPreviousClose。
     * 比昨收而不是现价——现价盘中一直在动，两端抓取时刻不同必然有差；
     * 昨收是静态值，两端一致才说明两条链路都没出错。 */
    /* CODE 的 key 是 Yahoo 裸代码（TSLA），value 是 Wind 口径代码（TSLA.O）；
     * quote 接口只认裸代码，live-data 只认带后缀的 key。 */
    const q7 = await quotes(Object.keys(CODE));
    for (const t of Object.keys(CODE)) {
      const w = W.stocks?.[CODE[t]], y = q7[t];
      const ref = y?.regularMarketPreviousClose;
      if (!w || w.prev == null || ref == null) continue;
      const diff = Math.abs(w.prev - ref) / ref * 100;
      rows.push({ t, chart: w.prev, quote: ref, diffPct: diff, ok: diff <= 0.05 });
    }
    crosscheck = { rows, okCount: rows.filter((r) => r.ok).length, total: rows.length };
  }
} catch (e) { console.warn("双端点校验失败:", e.message); }

/* ---------------- 赛道代表标的池：股价 / 涨幅 / 20日 / YTD ----------------
   排序按用户口径：AI应用 → AI基础设施/数据中心 → 先进封测 → CPU → 物理AI/机器人
   → 端侧AI → 网安 → 金融科技 → 生物医药 */
const TRACKS = [
  { id: "app",   syms: [["MSFT","MSFT"],["CRM","CRM"],["NOW","NOW"],["PLTR","PLTR"],["RBRK","RBRK"],["OKTA","OKTA"],["NET","NET"],["ADBE","ADBE"]] },
  { id: "infra", syms: [["NVDA","NVDA"],["AVGO","AVGO"],["CRWV","CRWV"],["IREN","IREN"],["NBIS","NBIS"],["BE","BE"],["VRT","VRT"],["ANET","ANET"],["GEV","GEV"]] },
  { id: "pkg",   syms: [["TSM","TSM"],["AMKR","AMKR"],["ASX","ASX"],["ONTO","ONTO"],["TER","TER"],["长电科技","600584.SS"],["通富微电","002156.SZ"]] },
  { id: "cpu",   syms: [["ARM","ARM"],["AMD","AMD"],["INTC","INTC"],["QCOM","QCOM"],["NVDA","NVDA"],["MRVL","MRVL"]] },
  { id: "phy",   syms: [["TSLA","TSLA"],["NVDA","NVDA"],["三花智控","002050.SZ"],["拓普集团","601689.SS"],["绿的谐波","688017.SS"],["优必选","9880.HK"]] },
  { id: "edge",  syms: [["QCOM","QCOM"],["AAPL","AAPL"],["联发科","2454.TW"],["恒玄科技","688608.SS"],["乐鑫科技","688018.SS"],["瑞芯微","603893.SS"]] },
  { id: "sec",   syms: [["CRWD","CRWD"],["PANW","PANW"],["ZS","ZS"],["S","S"],["RBRK","RBRK"],["OKTA","OKTA"],["CHKP","CHKP"],["奇安信","688561.SS"],["深信服","300454.SZ"]] },
  { id: "fin",   syms: [["V","V"],["MA","MA"],["PYPL","PYPL"],["XYZ","XYZ"],["COIN","COIN"],["HOOD","HOOD"],["SOFI","SOFI"],["NU","NU"],["INTU","INTU"],["ADYEY","ADYEY"],["PAGS","PAGS"]] },
  { id: "bio",   syms: [["LLY","LLY"],["PFE","PFE"],["MRK","MRK"],["JNJ","JNJ"],["UNH","UNH"],["ABBV","ABBV"],["TMO","TMO"],["AMGN","AMGN"],["ISRG","ISRG"],["VRTX","VRTX"],["REGN","REGN"]] },
];
const uniqSyms = [...new Set(TRACKS.flatMap((t) => t.syms.map((s) => s[1])))];
const trkQuotes = await quotes(uniqSyms);
const trkCharts = {};
for (let i = 0; i < uniqSyms.length; i += 4) {
  const part = uniqSyms.slice(i, i + 4);
  await Promise.all(part.map(async (sym) => {
    try { trkCharts[sym] = (await chart(sym, "1y")).rows; }
    catch (e) { console.warn("赛道标的 chart 失败 " + sym + ": " + e.message); }
  }));
  if (i + 4 < uniqSyms.length) await new Promise((r) => setTimeout(r, 260));
}
const YTD0 = new Date().getFullYear() + "-01-01";
const ccyOf = (sym) => /\.(SS|SZ)$/.test(sym) ? "¥" : (/\.HK$/.test(sym) ? "HK$" : (/\.TW$/.test(sym) ? "NT$" : "$"));
const trackRow = (name, sym) => {
  const q = trkQuotes[sym] || {}, rows = trkCharts[sym] || [];
  const ccy = ccyOf(sym);
  if (q.regularMarketPrice == null && !rows.length) return { name, sym, price: null, chg: null, d20: null, ytd: null, ccy };
  const price = q.regularMarketPrice ?? rows[rows.length - 1].close;
  const chg = q.regularMarketChangePercent != null ? +q.regularMarketChangePercent.toFixed(2)
    : (rows.length > 1 ? +((price / rows[rows.length - 2].close - 1) * 100).toFixed(2) : null);
  const d20 = rows.length >= 22 ? +((price / rows[rows.length - 22].close - 1) * 100).toFixed(2) : null;
  const y0 = rows.find((r) => r.date >= YTD0);
  const ytd = y0 ? +((price / y0.close - 1) * 100).toFixed(2) : null;
  return { name, sym, price: price != null ? +price.toFixed(price >= 1000 ? 0 : (price >= 100 ? 1 : 2)) : null, chg, d20, ytd, ccy, mcap: q.marketCap ?? null };
};
const trackData = {};
for (const t of TRACKS) trackData[t.id] = t.syms.map(([n, s]) => trackRow(n, s));

/* ---------------- GPU 租金（Ornn OCPI 口径，$/GPU·h，成交价日结算） ----------------
   没有公开免费接口，序列由 Agent 每日更新维护在 gpu-rent.json；
   这里只读取并透传，页面在 AI 基础设施赛道内画趋势图。 */
let gpuRent = null;
try {
  gpuRent = JSON.parse(readFileSync("gpu-rent.json", "utf8"));
  console.log("GPU 租金：最新 " + (gpuRent.latest?.date || "—") + " · 序列 " + ((gpuRent.series?.h100 || []).length) + " 点");
} catch (e) { console.warn("gpu-rent.json 读取失败:", e.message); }

/* -------- 创新高检测 + 滚动日志（52周新高 / 历史新高 / 三大市场指数） -------- */
const etToday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
/* 新高记录必须记在「交易日」上，不是「运行日」上：
   11-13 07:00 那次跑的是 11-12 的收盘，记成 11-13 会让日志整体错位一天。 */
let usCloseDate = etToday;
try {
  const g = (await chart("^GSPC", "5d")).rows;
  const last = g[g.length - 1];
  if (last && last.date) usCloseDate = last.date;
} catch (e) { console.warn("交易日探测失败，回退运行日:", e.message); }
console.log("美股最近已结算交易日：" + usCloseDate + "（运行日 ET " + etToday + "）");
const POOL = [
  ["TSLA","特斯拉","电动车/机器人"],["META","脸书","社交媒体"],["IREN","IREN","AI基础设施"],["NBIS","NEBIUS","AI基础设施"],
  ["CRWV","COREWEAVE","AI基础设施"],["BE","BLOOM ENERGY","电力设备"],["AMD","超威半导体","半导体"],["TSM","台积电","半导体"],
  ["TER","泰瑞达","半导体设备"],["ONTO","ONTO INNOVATION","半导体设备"],["NET","CLOUDFLARE","网络/网安"],["RBRK","RUBRIK","网安"],
  ["OKTA","OKTA","网安"],["CHKP","CHECK POINT","网安"],
];
const SYM2WIND = { TSLA:"TSLA.O", META:"META.O", IREN:"IREN.O", NBIS:"NBIS.O", CRWV:"CRWV.O", BE:"BE.N", AMD:"AMD.O", TSM:"TSM.N", TER:"TER.O", ONTO:"ONTO.N", NET:"NET.N", RBRK:"RBRK.N", OKTA:"OKTA.O", CHKP:"CHKP.O" };
const MKT_IDX = [["^GSPC","标普500","US"],["^HSI","恒生指数","HK"],["000001.SS","上证指数","CN"]];
const highsToday = [];
const poolQuotes = await quotes(POOL.map((p) => p[0]));
/* 新高判定的价格必须用「已结算收盘」：
   2026-11-13 早晨跑时 quote 返回的是 11-11 前收 552.9，而 11-12 真实收盘 585.3，
   导致记录价格错位。这里以日 K 最后一根有值收盘为准。 */
const settledClose = async (sym, fb) => {
  try {
    const rows = (await chart(sym, "6mo")).rows.filter((r) => r.close != null);
    const last = rows[rows.length - 1];
    if (last && fb != null && Math.abs(fb - last.close) / last.close > 0.01) return last.close;
    return last ? last.close : fb;
  } catch { return fb; }
};
for (const [sym, name, sec] of POOL) {
  try {
    const q = poolQuotes[sym];
    if (!q || q.regularMarketPrice == null || q.fiftyTwoWeekHigh == null) continue;
    const cur = await settledClose(sym, q.regularMarketPrice);
    /* 52 周：收盘站上 52 周高点（容差 0.1%）；持平历史最高不算创新高 */
    const chgOf = q.regularMarketChangePercent != null ? +Number(q.regularMarketChangePercent).toFixed(2) : null;
    const capOf = q.marketCap || 0;
    if (cur >= q.fiftyTwoWeekHigh * 0.999) {
      highsToday.push({ d: usCloseDate, sym, name, type: "52w", market: "US", sec, px: +cur.toFixed(2), chg: chgOf, mcap: capOf });
    }
    const mx = await chart(sym, "max");
    if (mx.rows.length > 1) {
      const done = mx.rows.filter((r) => r.close != null);
      const prevMax = Math.max(...done.slice(0, -1).map((r) => r.close));
      /* 严格大于：持平（如 2026-11-11 的 552.9 == 2026-09-01 的 552.9）不算历史新高 */
      if (cur > prevMax) highsToday.push({ d: usCloseDate, sym, name, type: "ath", market: "US", sec, px: +cur.toFixed(2), chg: chgOf, mcap: capOf });
    }
  } catch (e) { console.warn("新高检测失败 " + sym + ": " + e.message); }
}
for (const [sym, name, mkt] of MKT_IDX) {
  try {
    const rows = (await chart(sym, "1y")).rows;
    if (rows.length < 2) continue;
    const cur = rows[rows.length - 1].close;
    const prevMax = Math.max(...rows.slice(0, -1).map((r) => r.close));
    if (cur > prevMax) highsToday.push({ d: usCloseDate, sym, name, type: "mkt", market: mkt, sec: "指数", px: +cur.toFixed(2) });
  } catch (e) { console.warn("市场新高检测失败 " + sym + ": " + e.message); }
}
let highsLog = [];
try { highsLog = JSON.parse(readFileSync("highs-log.json", "utf8")); } catch {}
const seenH = new Set(highsLog.map((x) => x.d + "|" + x.sym + "|" + x.type));
for (const h of highsToday) {
  const k = h.d + "|" + h.sym + "|" + h.type;
  if (!seenH.has(k)) { highsLog.push(h); seenH.add(k); }
}
const highsCutoff = new Date(Date.parse(etToday) - 180 * 86400000).toISOString().slice(0, 10);
highsLog = highsLog.filter((x) => x.d >= highsCutoff).sort((a, b) => b.d.localeCompare(a.d) || a.sym.localeCompare(b.sym));
writeFileSync("highs-log.json", JSON.stringify(highsLog, null, 1));
const analyzeHighs = (days) => {
  const from = new Date(Date.parse(etToday) - days * 86400000).toISOString().slice(0, 10);
  const rows = highsLog.filter((x) => x.d >= from);
  const byMkt = {}, bySec = {};
  rows.forEach((x) => { byMkt[x.market] = (byMkt[x.market] || 0) + 1; bySec[x.sec] = (bySec[x.sec] || 0) + 1; });
  return { total: rows.length, byMkt, bySec, days };
};
const highs = { date: usCloseDate, today: highsToday, log: highsLog.slice(0, 100), weekly: analyzeHighs(7), monthly: analyzeHighs(30) };
console.log("创新高检测：当日 " + highsToday.length + " 条 · 累计日志 " + highsLog.length + " 条");

/* ---------------- 盘前 / 盘后异动：全市场扫描 ----------------
   口径 = 全市场美股，不局限于研究标的。
   流程：Nasdaq screener 取全市场清单（约 7000 只）→ 按市值截断到 ≥5 亿美元（约 3200 只，
   覆盖美股市值与成交额 98%+）→ Yahoo 批量 quote 取盘前 / 盘后涨跌。
   nano-cap（<5 亿美元）不扫：流动性太差，异动没有交易意义。
   SEED 三合一：给东财快讯匹配中文别名、提供更贴业务的板块名、清单接口挂掉时兜底。 */
const SEED = [
  /* 半导体 / 硬件 */
  { s: "NVDA", cn: "英伟达", en: "NVIDIA", sec: "半导体" },
  { s: "AVGO", cn: "博通", en: "BROADCOM", sec: "半导体" },
  { s: "AMD", cn: "超威半导体", en: "AMD", sec: "半导体" },
  { s: "TSM", cn: "台积电", en: "TAIWAN SEMICONDUCTOR", sec: "半导体" },
  { s: "MU", cn: "美光", en: "MICRON", sec: "半导体" },
  { s: "MRVL", cn: "迈威尔", en: "MARVELL", sec: "半导体" },
  { s: "ARM", cn: "安谋", en: "Arm Holdings", sec: "半导体" },
  { s: "ASML", cn: "阿斯麦", en: "ASML", sec: "半导体" },
  { s: "LRCX", cn: "泛林", en: "LAM RESEARCH", sec: "半导体" },
  { s: "AMAT", cn: "应用材料", en: "APPLIED MATERIALS", sec: "半导体" },
  { s: "KLAC", cn: "科磊", en: "KLA", sec: "半导体" },
  { s: "QCOM", cn: "高通", en: "QUALCOMM", sec: "半导体" },
  { s: "INTC", cn: "英特尔", en: "INTEL", sec: "半导体" },
  { s: "ONTO", cn: "", en: "ONTO INNOVATION", sec: "半导体" },
  { s: "TER", cn: "泰瑞达", en: "TERADYNE", sec: "半导体" },
  { s: "SMCI", cn: "超微电脑", en: "SUPER MICRO", sec: "硬件" },
  { s: "DELL", cn: "戴尔", en: "DELL", sec: "硬件" },
  { s: "ANET", cn: "", en: "ARISTA", sec: "硬件" },
  /* 软件 / 云 / 安全 */
  { s: "MSFT", cn: "微软", en: "MICROSOFT", sec: "软件" },
  { s: "ORCL", cn: "甲骨文", en: "ORACLE", sec: "软件" },
  { s: "PLTR", cn: "", en: "Palantir", sec: "软件" },
  { s: "SNOW", cn: "", en: "Snowflake", sec: "软件" },
  { s: "DDOG", cn: "", en: "Datadog", sec: "软件" },
  { s: "MDB", cn: "", en: "MongoDB", sec: "软件" },
  { s: "CRM", cn: "", en: "Salesforce", sec: "软件" },
  { s: "NOW", cn: "", en: "ServiceNow", sec: "软件" },
  { s: "NET", cn: "", en: "CLOUDFLARE", sec: "网安" },
  { s: "RBRK", cn: "", en: "RUBRIK", sec: "网安" },
  { s: "OKTA", cn: "", en: "OKTA", sec: "网安" },
  { s: "CHKP", cn: "", en: "CHECK POINT", sec: "网安" },
  { s: "CRWD", cn: "", en: "CrowdStrike", sec: "网安" },
  { s: "PANW", cn: "", en: "Palo Alto", sec: "网安" },
  /* 平台 / 互联网 */
  { s: "AAPL", cn: "苹果", en: "APPLE", sec: "平台" },
  { s: "GOOGL", cn: "谷歌", en: "ALPHABET", sec: "平台" },
  { s: "AMZN", cn: "亚马逊", en: "AMAZON", sec: "平台" },
  { s: "META", cn: "脸书", en: "META", sec: "平台" },
  { s: "NFLX", cn: "奈飞", en: "NETFLIX", sec: "平台" },
  { s: "SHOP", cn: "", en: "Shopify", sec: "平台" },
  { s: "UBER", cn: "优步", en: "UBER", sec: "平台" },
  { s: "APP", cn: "", en: "AppLovin", sec: "平台" },
  /* AI 基础设施 / 电力 */
  { s: "VRT", cn: "", en: "Vertiv", sec: "AI基建" },
  { s: "CEG", cn: "", en: "Constellation Energy", sec: "AI电力" },
  { s: "GEV", cn: "", en: "GE Vernova", sec: "AI电力" },
  { s: "OKLO", cn: "", en: "Oklo", sec: "AI电力" },
  { s: "SMR", cn: "", en: "NuScale", sec: "AI电力" },
  { s: "BE", cn: "", en: "BLOOM ENERGY", sec: "AI电力" },
  { s: "NBIS", cn: "", en: "NEBIUS", sec: "AI基建" },
  { s: "IREN", cn: "", en: "IREN", sec: "AI基建" },
  { s: "CRWV", cn: "", en: "CoreWeave", sec: "AI基建" },
  { s: "APLD", cn: "", en: "Applied Digital", sec: "AI基建" },
  /* 加密相关 */
  { s: "COIN", cn: "", en: "Coinbase", sec: "加密" },
  { s: "MSTR", cn: "", en: "Strategy", sec: "加密" },
  { s: "HOOD", cn: "", en: "Robinhood", sec: "加密" },
  /* 新势力 / 车 */
  { s: "TSLA", cn: "特斯拉", en: "TESLA", sec: "汽车" },
  { s: "RIVN", cn: "", en: "Rivian", sec: "汽车" },
  { s: "LCID", cn: "", en: "Lucid", sec: "汽车" },
  { s: "NIO", cn: "蔚来", en: "NIO", sec: "汽车" },
  { s: "XPEV", cn: "小鹏", en: "XPENG", sec: "汽车" },
  { s: "LI", cn: "理想", en: "LI AUTO", sec: "汽车" },
];

const SEED_BY = Object.fromEntries(SEED.map((x) => [x.s, x]));
const SECTOR_CN = {
  Technology: "科技", "Electronic Technology": "电子", "Health Care": "医疗", "Health Technology": "医疗科技",
  Finance: "金融", "Consumer Discretionary": "可选消费", "Consumer Staples": "必需消费",
  "Consumer Non-Durables": "必需消费", "Consumer Durables": "耐用消费", "Retail Trade": "零售",
  Energy: "能源", "Non-Energy Minerals": "矿产", Industries: "工业", Industrials: "工业",
  "Producer Manufacturing": "制造", "Process Industries": "流程工业", "Capital Goods": "资本品",
  Materials: "原材料", "Basic Materials": "原材料", "Real Estate": "房地产", Utilities: "公用事业",
  Telecommunications: "通信服务", "Commercial Services": "商业服务", "Distribution Services": "分销",
};
/* 非普通股剔除：权证/优先股/债券/单位/权利/ETF 不是“公司”，
   把它们的 52 周新高混进榜里会污染板块与赛道统计（2026-11-13 曾出现 CORZZ/RUMBW/OXLCZ 等）。 */
const JUNK_RE = /warrant|preferred|notes? due|\bdepositary\b|\bunits?\b|\brights?\b|\betf\b|\betn\b|\bfund\b|%|\btranche\b|acquisition corp|blank check/i;
const isJunk = (sym, name) => JUNK_RE.test(String(name || "")) || /^[A-Z]{4,6}[WRU]$/.test(String(sym || ""));
const cleanName = (s) => String(s || "")
  .replace(/\b(Inc|Incorporated|Corp|Corporation|Ltd|Limited|plc|Co|Company|Holdings?|Group|Class [A-Z]|Common Stock|Ordinary Shares|American Depositary Shares|Sponsored ADR|ADR|N\.V\.|S\.A\.|AG|SE|LP|LLC)\b\.?/gi, "")
  .replace(/\s{2,}/g, " ")
  .replace(/[\s,&\-–]+$/g, "")
  .replace(/^[\s,]+/g, "")
  .trim();

let universe = [];
try {
  const s = await jget("https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=25&offset=0&download=true", {
    Origin: "https://www.nasdaq.com", Referer: "https://www.nasdaq.com/",
  });
  universe = (s?.data?.rows || [])
    .map((x) => ({
      sym: String(x.symbol || "").replace(/\./g, "-"),
      name: String(x.name || ""),
      sector: String(x.sector || "Technology"),
      mcap: capNum(x.marketCap),
    }))
    .filter((x) => x.sym && x.mcap >= 5e8 && !isJunk(x.sym, x.name));
} catch (e) { console.warn("全市场清单获取失败:", e.message); }
if (universe.length < 200) {
  console.warn("全市场清单异常（" + universe.length + " 只），回退 SEED 兜底池");
  universe = SEED.map((x) => ({ sym: x.s, name: x.en, sector: x.sec, mcap: 0 }));
}
console.log("全市场清单：" + universe.length + " 只（市值 ≥5 亿美元），开始批量取盘前/盘后…");

const mvQuote = {};
for (let i = 0; i < universe.length; i += 30) {
  Object.assign(mvQuote, await quotes(universe.slice(i, i + 30).map((x) => x.sym)));
  await new Promise((r) => setTimeout(r, 110));
}

const numOf2 = (v) => (v == null ? null : +Number(v).toFixed(2));
const etDayOf = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ms));
const moverRows = universe.map((m) => {
  const q = mvQuote[m.sym];
  if (!q) return null;
  const seed = SEED_BY[m.sym];
  const cn = seed ? seed.cn : "";
  const en = cleanName(seed ? seed.en : m.name) || m.sym;
  return {
    sym: m.sym, cn: cn, en: en,
    name: cn ? cn + "(" + en + ")" : en,
    sec: (seed && seed.sec) ? seed.sec : (SECTOR_CN[m.sector] || m.sector || ""),
    mcap: m.mcap,
    px: numOf2(q.regularMarketPrice),
    chg: numOf2(q.regularMarketChangePercent),
    pre: numOf2(q.preMarketChangePercent),
    post: numOf2(q.postMarketChangePercent),
    prePx: numOf2(q.preMarketPrice),
    postPx: numOf2(q.postMarketPrice),
    state: q.marketState || "",
    date: q.regularMarketTime ? etDayOf(q.regularMarketTime * 1000).replace(/-/g, "") : etToday.replace(/-/g, ""),
  };
}).filter(Boolean);

/* 财报驱动的归 ①，其余归 ② —— 这里先按当日该场次“全部披露标的”打标 */
const preEarnSet = new Set(pre.allSyms || []);
const postEarnSet = new Set(post.allSyms || []);
const markEarn = (x, set) => ({ ...x, earn: set.has(x.sym) });
const MV_EMIT = Number(process.env.MV_EMIT || 3); /* 抓取侧放宽到 3%，页面按 4% 展示 */
/* 赛道归类函数 trackOfClass 定义在本段之后（TDZ），这里先留空，留档写盘前再补 */
const TRACK_CLASS = {
  "AI应用": ["MSFT","CRM","NOW","PLTR","RBRK","OKTA","NET","ADBE","SNOW","DDOG","MDB","APP","SHOP","UBER","PINS","SPOT","ROKU","DUOL","FRSH","TWLO","GEN","SAP","ORCL","DOCU","ZM","CSD"],
  "AI基础设施/数据中心": ["NVDA","AVGO","CRWV","IREN","NBIS","BE","VRT","ANET","GEV","CEG","OKLO","SMR","APLD","DELL","SMCI","MU","MRVL","WDC","STX","ETN","PWR","DLR","EQIX","ALAB","CLS","NVT","TSM","AMAT","LRCX","KLAC","ASML","AMKR","ASX","ONTO","TER","COHR","AAOI","FN","CIEN","APH","GLW","TDY","MCHP","ADI","NXPI","SWKS","QRVO","MPWR","ON","TLN","VST","NRG","XEL","SRE","PEG","ED","AEE","EXC","EIX","WEC","CNP","D","DUK","SO","NEE","AES","FLNC","PLUG"],
  "先进封测": ["AMKR","ASX","ONTO","TER","BESI","UCTT","IEX"],
  "CPU": ["AMD","INTC","ARM","QCOM"],
  "物理AI/机器人": ["TSLA","HNST","RR","ROK","SERV"],
  "端侧AI": ["AAPL"],
  "网安": ["CRWD","PANW","ZS","S","OKTA","CHKP","QLYS","TENB","RPD","CYBR","FORTY"],
  "金融科技": ["V","MA","PYPL","XYZ","COIN","HOOD","SOFI","NU","INTU","ADYEY","PAGS","MELI","AFRM","UPST","LC","GPN","FIS","FI"],
  "生物医药": ["PFE","MRK","JNJ","LLY","UNH","ABBV","TMO","AMGN","ISRG","VRTX","REGN","GILD","BIIB","ZTS","NVO","NVS","AZN","BMY","CI","HUM","BSX","SYK","MDT","EW","DXCM","ALNY","MRNA","BNTX","SRPT","RARE","TEVA"],
};
const SEED_TRACK = { TSM: "先进封测", AMKR: "先进封测", ASX: "先进封测", ONTO: "先进封测", TER: "先进封测",
  AMD: "CPU", INTC: "CPU", ARM: "CPU", QCOM: "CPU",
  NVDA: "AI基础设施/数据中心", AVGO: "AI基础设施/数据中心", CRWV: "AI基础设施/数据中心", IREN: "AI基础设施/数据中心",
  NBIS: "AI基础设施/数据中心", BE: "AI基础设施/数据中心", VRT: "AI基础设施/数据中心", ANET: "AI基础设施/数据中心", GEV: "AI基础设施/数据中心",
  MSFT: "AI应用", CRM: "AI应用", NOW: "AI应用", PLTR: "AI应用", RBRK: "AI应用", OKTA: "AI应用", NET: "AI应用", ADBE: "AI应用",
  CRWD: "网安", PANW: "网安", ZS: "网安", S: "网安", CHKP: "网安",
  V: "金融科技", MA: "金融科技", PYPL: "金融科技", XYZ: "金融科技", COIN: "金融科技", HOOD: "金融科技", SOFI: "金融科技", NU: "金融科技", INTU: "金融科技", ADYEY: "金融科技", PAGS: "金融科技",
  TSLA: "物理AI/机器人", AAPL: "端侧AI" };
const TRACKS_ORDER = ["AI应用","AI基础设施/数据中心","先进封测","CPU","物理AI/机器人","端侧AI","网安","金融科技","生物医药"];
const trackOfClass = (sym, sector) => {
  if (SEED_TRACK[sym]) return SEED_TRACK[sym];
  for (const tk of TRACKS_ORDER) if ((TRACK_CLASS[tk] || []).includes(sym)) return tk;
  if (/bio|health|pharma/i.test(sector || "")) return "生物医药";
  return "其它";
};

const slim = (x) => ({ sym: x.sym, name: x.name, sec: x.sec, track: x.track || "",
  mv: x.mv != null ? x.mv : (x.post != null ? x.post : x.pre), px: x.px, earn: !!x.earn });

const movers = {
  date: etToday.replace(/-/g, ""),
  closeDate: usCloseDate,
  ts: new Date().toISOString(),
  pool: moverRows.length,
  universe: universe.length,
  preTotal: preEarnSet.size,
  postTotal: postEarnSet.size,
  state: (moverRows[0] && moverRows[0].state) || "",
  pre: moverRows.filter((x) => x.pre != null && Math.abs(x.pre) >= MV_EMIT)
    .map((x) => markEarn({ ...x, mv: x.pre }, preEarnSet)).sort((a, b) => Math.abs(b.pre) - Math.abs(a.pre)),
  post: moverRows.filter((x) => x.post != null && Math.abs(x.post) >= MV_EMIT)
    .map((x) => markEarn({ ...x, mv: x.post }, postEarnSet)).sort((a, b) => Math.abs(b.post) - Math.abs(a.post)),
};

/* ---------- 盘前/盘后异动滚动留档 ----------
   问题：Yahoo 只在「当前场次」给 preMarket/postMarket 涨跌，窗口一过就没了。
   20:30 那次抓的是当日盘前、07:00 那次抓的是前一日盘后，任何一次补跑都可能错过一整个场次。
   做法：每个场次抓到时非空就写一条 movers-log.json，页面从这个档案里取「最近一次有效场次」。 */
let mvLog = [];
try { mvLog = JSON.parse(readFileSync("movers-log.json", "utf8")); } catch {}
const mvState = movers.state;
const sessionNow = /PRE/i.test(mvState) ? "pre" : (/POST/i.test(mvState) ? "post" : "");
const upsert = (session, rows, dateTag) => {
  if (!rows.length) return;
  const rec = { date: dateTag, session, ts: movers.ts, state: mvState, rows: rows.map(slim) };
  const i = mvLog.findIndex((x) => x.date === rec.date && x.session === session);
  if (i >= 0) mvLog[i] = rec; else mvLog.push(rec);
};
if (sessionNow === "pre") upsert("pre", movers.pre, etToday);
if (sessionNow === "post") upsert("post", movers.post, usCloseDate);
mvLog = mvLog.filter((x) => x.date >= new Date(Date.parse(usCloseDate) - 45 * 86400000).toISOString().slice(0, 10))
  .sort((a, b) => b.date.localeCompare(a.date) || String(a.session).localeCompare(String(b.session)));
writeFileSync("movers-log.json", JSON.stringify(mvLog, null, 1));

const lastOf = (s) => mvLog.find((x) => x.session === s) || null;
const lastPost = lastOf("post"), lastPre = lastOf("pre");
/* 当前场次为空时，用档案里最近一次有效记录顶上，并标明是哪一场 */
if (!movers.post.length && lastPost) {
  movers.post = lastPost.rows.map((r) => ({ ...r, earn: postEarnSet.has(r.sym) }));
  movers.postDate = lastPost.date; movers.postFromLog = true;
} else movers.postDate = usCloseDate;
if (!movers.pre.length && lastPre) {
  movers.pre = lastPre.rows.map((r) => ({ ...r, earn: preEarnSet.has(r.sym) }));
  movers.preDate = lastPre.date; movers.preFromLog = true;
} else movers.preDate = (sessionNow === "pre") ? etToday : usCloseDate;
movers.history = mvLog.slice(0, 10).map((x) => ({ date: x.date, session: x.session, n: x.rows.length }));
/* 赛道归类补写（此时 trackOfClass 已定义） */
mvLog.forEach((r) => r.rows.forEach((x) => { if (!x.track) x.track = trackOfClass(x.sym, ""); }));
writeFileSync("movers-log.json", JSON.stringify(mvLog, null, 1));
console.log("全市场异动：" + moverRows.length + " 只取到报价 · 盘前 ≥" + MV_EMIT + "% " + movers.pre.length +
  " 条（财报 " + movers.pre.filter((x) => x.earn).length + " / 非财报 " + movers.pre.filter((x) => !x.earn).length + "）" +
  " · 盘后 ≥" + MV_EMIT + "% " + movers.post.length +
  " 条（财报 " + movers.post.filter((x) => x.earn).length + " / 非财报 " + movers.post.filter((x) => !x.earn).length + "）");

/* ---------------- 全市场 52 周新高扫描 + 赛道归类 ----------------
   与异动共用同一份批量报价。判定口径：收盘价站上 52 周高点（容差 0.1%）。
   价格用 previousClose × (1+chg) 反推，避免 POSTPOST 时 quote 滞后返回前收
   （2026-11-13 早晨 AMD 被记成 552.9 即此原因，真实收盘 585.3）。 */
const seedSec = (sym) => (SEED_BY[sym] ? SEED_BY[sym].sec : "");
const uniBySym = Object.fromEntries(universe.map((u) => [u.sym, u]));
const usHighs = [];
let junkSkipped = 0;
for (const [sym, q] of Object.entries(mvQuote)) {
  if (q.regularMarketPrice == null || q.fiftyTwoWeekHigh == null) continue;
  const u = uniBySym[sym] || {};
  const nm = moverRows.find((x) => x.sym === sym)?.name || cleanName(u.name) || sym;
  if (isJunk(sym, nm) || isJunk(sym, u.name)) { junkSkipped++; continue; }
  /* 价格：用前收 × (1+当日涨跌%) 反推，规避 quote 滞后；
     判定也用这个「已结算收盘」价，而不是 quote 的 regularMarketPrice */
  const px = q.regularMarketPreviousClose != null && q.regularMarketChangePercent != null
    ? +(q.regularMarketPreviousClose * (1 + q.regularMarketChangePercent / 100)).toFixed(2)
    : +Number(q.regularMarketPrice).toFixed(2);
  if (!(px >= q.fiftyTwoWeekHigh * 0.999)) continue;
  usHighs.push({
    d: usCloseDate, sym, name: nm,
    type: "52w", market: "US",
    sec: (seedSec(sym) || SECTOR_CN[u.sector] || u.sector || "其它"),
    track: trackOfClass(sym, u.sector),
    px, chg: numOf2(q.regularMarketChangePercent),
    hi: +Number(q.fiftyTwoWeekHigh).toFixed(2),
    mcap: u.mcap || 0,
  });
}
usHighs.sort((a, b) => (b.mcap || 0) - (a.mcap || 0));
console.log("全市场 52 周新高：" + usHighs.length + " 只（剔除权证/优先股/债券等 " + junkSkipped + " 只）");

/* 并入滚动日志（与 SEED 池检测的 52w/ATH 去重合并） */
try {
  let hl = JSON.parse(readFileSync("highs-log.json", "utf8"));
  const seen = new Set(hl.map((x) => x.d + "|" + x.sym + "|" + x.type));
  for (const h of usHighs) {
    const k = h.d + "|" + h.sym + "|" + h.type;
    if (!seen.has(k)) { hl.push(h); seen.add(k); }
  }
  const cut2 = new Date(Date.parse(etToday) - 180 * 86400000).toISOString().slice(0, 10);
  hl = hl.filter((x) => x.d >= cut2).sort((a, b) => b.d.localeCompare(a.d) || a.sym.localeCompare(b.sym));
  writeFileSync("highs-log.json", JSON.stringify(hl, null, 1));
  const todayKeys = new Set([...highsToday, ...usHighs].map((h) => h.sym + "|" + h.type));
  highs.today = [...highsToday, ...usHighs].filter((h, i, arr) => arr.findIndex((y) => y.sym + "|" + y.type === h.sym + "|" + h.type) === i);
  /* 赛道归类统一补齐（POOL 检测发生在本段之前，那里还没有 trackOfClass） */
  const backfill = (rows) => rows.forEach((x) => { if (!x.track) x.track = trackOfClass(x.sym, x.sec || ""); });
  backfill(highs.today); backfill(hl);
  highs.log = hl.slice(0, 400);
  const withTrack = (rows) => {
    const byMkt = {}, bySec = {}, byTrack = {};
    rows.forEach((x) => {
      byMkt[x.market] = (byMkt[x.market] || 0) + 1;
      bySec[x.sec || "其它"] = (bySec[x.sec || "其它"] || 0) + 1;
      const tk = x.track || SEED_TRACK[x.sym] || "其它";
      byTrack[tk] = (byTrack[tk] || 0) + 1;
    });
    return byMkt, { byMkt, bySec, byTrack };
  };
  const wk = withTrack(hl.filter((x) => x.d >= new Date(Date.parse(etToday) - 7 * 86400000).toISOString().slice(0, 10)));
  const mo = withTrack(hl.filter((x) => x.d >= new Date(Date.parse(etToday) - 30 * 86400000).toISOString().slice(0, 10)));
  highs.weekly = { total: hl.filter((x) => x.d >= new Date(Date.parse(etToday) - 7 * 86400000).toISOString().slice(0, 10)).length, ...wk, days: 7 };
  highs.monthly = { total: hl.filter((x) => x.d >= new Date(Date.parse(etToday) - 30 * 86400000).toISOString().slice(0, 10)).length, ...mo, days: 30 };
} catch (e) { console.warn("全市场新高日志合并失败:", e.message); }

const out = {
  meta: { syncedAt: new Date().toISOString(), source: "Yahoo Finance / Nasdaq", preDate: TODAY, postDate: YEST },
  quotes: quotesOut, sectors, btc, eth, breadth, spxVol,
  earnings: { preDate: TODAY, postDate: YEST,
              pre: pre.rows, preTotal: pre.total, preHit: pre.hit, preCached: pre.fromCache,
              post: post.rows, postTotal: post.total, postHit: post.hit, postCached: post.fromCache },
  nextEarn,
  crosscheck,
  tracks: trackData,
  highs,
  gpuRent,
  movers,
};
writeFileSync("cal-cache.json", JSON.stringify(CALCACHE, null, 1), "utf8");
writeFileSync("live-extra.js", "window.YF_DATA = " + JSON.stringify(out, null, 1) + ";\n", "utf8");
console.log(`live-extra.js｜校验 ${crosscheck ? crosscheck.okCount + "/" + crosscheck.total : "n/a"}｜板块 ${Object.keys(sectors).length}｜盘前 ${pre.rows.length}/${pre.total}｜盘后 ${post.rows.length}/${post.total}｜下次财报 ${Object.keys(nextEarn).length}｜BTC ${btc ? "ok" : "fail"}｜量能 ${spxVol ? "ok" : "fail"}`);
