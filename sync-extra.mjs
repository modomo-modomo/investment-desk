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
async function chart(symbol, range = "3mo") {
  const j = await jget(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d&includePrePost=true`);
  const r = j?.chart?.result?.[0];
  if (!r) throw new Error(`chart 无结果 ${symbol}`);
  const q = r.indicators.quote[0];
  const rows = r.timestamp.map((t, i) => ({
    date: new Date(t * 1000).toISOString().slice(0, 10),
    close: q.close?.[i] ?? null,
    volume: q.volume?.[i] ?? null,
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

let btc = null, eth = null;
try {
  const c = await chart("BTC-USD", "3mo");
  const last = c.rows[c.rows.length - 1], prev = c.rows[c.rows.length - 2];
  const base = c.rows.length >= 21 ? c.rows[c.rows.length - 21] : null;
  btc = { price: last.close, chg: prev ? (last.close / prev.close - 1) * 100 : null, d20: base ? (last.close / base.close - 1) * 100 : null, date: last.date };
} catch (e) { console.warn("BTC 失败:", e.message); }
try {
  const c = await chart("ETH-USD", "3mo");
  const last = c.rows[c.rows.length - 1], prev = c.rows[c.rows.length - 2];
  const base = c.rows.length >= 21 ? c.rows[c.rows.length - 21] : null;
  eth = { price: last.close, chg: prev ? (last.close / prev.close - 1) * 100 : null, d20: base ? (last.close / base.close - 1) * 100 : null, date: last.date };
} catch (e) { console.warn("ETH 失败:", e.message); }

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

const out = {
  meta: { syncedAt: new Date().toISOString(), source: "Yahoo Finance / Nasdaq", preDate: TODAY, postDate: YEST },
  quotes: quotesOut, sectors, btc, eth, breadth, spxVol,
  earnings: { preDate: TODAY, postDate: YEST,
              pre: pre.rows, preTotal: pre.total, preHit: pre.hit, preCached: pre.fromCache,
              post: post.rows, postTotal: post.total, postHit: post.hit, postCached: post.fromCache },
  nextEarn,
  crosscheck,
};
writeFileSync("cal-cache.json", JSON.stringify(CALCACHE, null, 1), "utf8");
writeFileSync("live-extra.js", "window.YF_DATA = " + JSON.stringify(out, null, 1) + ";\n", "utf8");
console.log(`live-extra.js｜校验 ${crosscheck ? crosscheck.okCount + "/" + crosscheck.total : "n/a"}｜板块 ${Object.keys(sectors).length}｜盘前 ${pre.rows.length}/${pre.total}｜盘后 ${post.rows.length}/${post.total}｜下次财报 ${Object.keys(nextEarn).length}｜BTC ${btc ? "ok" : "fail"}｜量能 ${spxVol ? "ok" : "fail"}`);
