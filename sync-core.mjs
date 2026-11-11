#!/usr/bin/env node
/**
 * 核心行情 → live-data.js（Yahoo 版）
 *
 * 云端替代 sync.mjs：原版依赖本机 Wind CLI（~/.agents/skills/wind-mcp-skill），
 * GitHub Actions 上没有该环境，因此改用 Yahoo 生成同样结构的 window.WIND_LIVE。
 * 字段名与 Wind 版完全一致，页面无需改动。
 *
 * 用法：node sync-core.mjs [--out=live-data.js]
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const outArg = argv.find((a) => a.startsWith("--out="));
const OUT = path.join(DIR, outArg ? outArg.slice(6) : "live-data.js");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/* code 保持 Wind 口径不变，页面用这些 key 索引 */
const STOCKS = [
  ["TSLA.O", "TSLA", "特斯拉(TESLA)"],
  ["META.O", "META", "脸书(META PLATFORMS)"],
  ["IREN.O", "IREN", "IREN"],
  ["NBIS.O", "NBIS", "NEBIUS"],
  ["CRWV.O", "CRWV", "COREWEAVE"],
  ["BE.N", "BE", "BLOOM ENERGY"],
  ["AMD.O", "AMD", "超威半导体(AMD)"],
  ["TSM.N", "TSM", "台积电(TAIWAN SEMICONDUCTOR MANUFACTURING)"],
  ["TER.O", "TER", "泰瑞达(TERADYNE)"],
  ["ONTO.N", "ONTO", "ONTO INNOVATION"],
  ["NET.N", "NET", "CLOUDFLARE"],
  ["RBRK.N", "RBRK", "RUBRIK"],
  ["OKTA.O", "OKTA", "OKTA"],
  ["CHKP.O", "CHKP", "CHECK POINT SOFTWARE TECHNOLOGIES"],
];

const INDICES = [
  ["SPX.GI", "^GSPC", "标普500"],
  ["NDX.GI", "^NDX", "纳斯达克100"],
  ["IXIC.GI", "^IXIC", "纳斯达克指数"],
  ["DJI.GI", "^DJI", "道琼斯工业平均"],
  ["SOX.GI", "^SOX", "费城半导体指数"],
  ["VIX.GI", "^VIX", "CBOE波动率"],
  ["HSI.HI", "^HSI", "恒生指数"],
  ["000001.SH", "000001.SS", "上证指数"],
  ["N225.GI", "^N225", "日经225"],
  ["KS11.GI", "^KS11", "韩国综合指数"],
  ["GDAXI.GI", "^GDAXI", "德国DAX"],
  ["FTSE.GI", "^FTSE", "英国富时100"],
  ["SX5E.DF", "^STOXX50E", "欧元区STOXX50(欧元)"],
];

/* [key, yahoo, 名称, 单位, 换算系数, 是否以 bp 记变动] */
const CROSS = [
  ["UST10Y", "^TNX", "美国:国债收益率:10年", "%", 1, true],
  ["DXY", "DX-Y.NYB", "美元指数", "1973年3月=100", 1, false],
  ["GOLD", "GC=F", "COMEX黄金(近月)", "美元/金衡盎司", 1, false],
  ["SILVER", "SI=F", "COMEX白银(近月)", "美元/金衡盎司", 1, false],
  ["COPPER", "HG=F", "COMEX铜(近月，折美元/吨)", "美元/吨", 2204.6226, false],
  ["WTI", "CL=F", "WTI原油(近月)", "美元/桶", 1, false],
  ["BRENT", "BZ=F", "布伦特原油(近月)", "美元/桶", 1, false],
];

/* 带退避重试：GitHub Actions 的出口 IP 属于数据中心段，Yahoo 偶发 429/5xx */
async function jget(url, headers = {}, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...headers } });
    if (r.ok) return r.json();
    lastErr = new Error(`HTTP ${r.status} ${url.slice(0, 80)}`);
    if ((r.status === 429 || r.status >= 500) && i < tries - 1) {
      await new Promise((s) => setTimeout(s, 1200 * (i + 1)));
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}

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

async function chart(symbol, range = "6mo") {
  const j = await jget(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d&includePrePost=true`);
  const r = j?.chart?.result?.[0];
  if (!r) throw new Error("chart 无结果 " + symbol);
  const q = r.indicators.quote[0];
  const rows = r.timestamp
    .map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: q.close?.[i] ?? null, volume: q.volume?.[i] ?? null }))
    .filter((x) => x.close != null);
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
  } catch (e) {
    console.warn("quote 批量取数失败:", e.message);
    return {};
  }
}

const pct = (a, b) => (b ? ((a - b) / Math.abs(b)) * 100 : null);

/* 分批抓取，避免被限流 */
async function batched(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    const res = await Promise.all(batch.map((x) => fn(x).catch((e) => { console.warn("  跳过 " + x[1] + ": " + e.message); return null; })));
    out.push(...res);
    if (i + size < items.length) await new Promise((r) => setTimeout(r, 260));
  }
  return out;
}

console.log("Yahoo 鉴权…");
await yahooAuth();
console.log(CRUMB ? "  已取得 crumb" : "  警告：未取得 crumb，市值/盘前盘后可能缺失");

/* ---------- 标的 ---------- */
console.log("抓取标的行情（" + STOCKS.length + " 只）…");
const stockCharts = await batched(STOCKS, 5, async (s) => {
  const c = await chart(s[1]);
  return { code: s[0], sym: s[1], name: s[2], rows: c.rows };
});
const stockQuotes = await quotes(STOCKS.map((s) => s[1]));

const stocks = {};
for (const c of stockCharts) {
  if (!c || !c.rows.length) continue;
  const rows = c.rows;
  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2] || last;
  const base20 = rows[rows.length - 22] || rows[0];
  const q = stockQuotes[c.sym] || {};
  stocks[c.code] = {
    name: c.name,
    date: last.date.replace(/-/g, ""),
    price: +last.close.toFixed(2),
    prev: +prev.close.toFixed(2),
    chg: +(pct(last.close, prev.close) ?? 0).toFixed(2),
    d20: +(pct(last.close, base20.close) ?? 0).toFixed(2),
    mcap: q.marketCap ?? null,
    pre: q.preMarketChangePercent != null ? +Number(q.preMarketChangePercent).toFixed(2) : null,
    post: q.postMarketChangePercent != null ? +Number(q.postMarketChangePercent).toFixed(2) : null,
  };
}

/* ---------- 指数 ---------- */
console.log("抓取指数（" + INDICES.length + " 个）…");
const idxCharts = await batched(INDICES, 5, async (s) => {
  const c = await chart(s[1]);
  return { code: s[0], sym: s[1], name: s[2], rows: c.rows };
});

const indices = {};
for (const c of idxCharts) {
  if (!c || !c.rows.length) continue;
  const rows = c.rows;
  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2] || last;
  const base20 = rows[rows.length - 22] || rows[0];
  /* 指数用 amount 表示成交额，Yahoo chart 只有 volume，这里留 null 由 live-extra 补 */
  indices[c.code] = {
    name: c.name,
    date: last.date.replace(/-/g, ""),
    level: +last.close.toFixed(2),
    prev: +prev.close.toFixed(2),
    chg: +(pct(last.close, prev.close) ?? 0).toFixed(2),
    d20: +(pct(last.close, base20.close) ?? 0).toFixed(2),
    amount: null,
  };
}

/* ---------- 跨资产 ---------- */
console.log("抓取跨资产（" + CROSS.length + " 项）…");
const crossCharts = await batched(CROSS, 4, async (s) => {
  const c = await chart(s[1], "3mo");
  return { row: s, rows: c.rows };
});

const cross = {};
for (const c of crossCharts) {
  if (!c || !c.rows.length) continue;
  const [key, , name, unit, mul, isBp] = c.row;
  const rows = c.rows;
  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2] || last;
  const base20 = rows[rows.length - 22] || rows[0];
  const v = last.close * mul;
  const p1 = prev.close * mul;
  const p20 = base20.close * mul;
  cross[key] = {
    name,
    unit,
    date: last.date.replace(/-/g, ""),
    value: +v.toFixed(v >= 1000 ? 2 : 4),
    d1: +(pct(v, p1) ?? 0).toFixed(2),
    d20: +(pct(v, p20) ?? 0).toFixed(2),
    dbp1: isBp ? +((v - p1) * 100).toFixed(2) : null,
    dbp20: isBp ? +((v - p20) * 100).toFixed(2) : null,
  };
}

/* ---------- 输出 ---------- */
const dates = Object.values(stocks).map((s) => s.date).sort();
const idxDates = Object.values(indices).map((s) => s.date).sort();
const crossDates = Object.values(cross).map((s) => s.date).sort();

const payload = {
  meta: {
    syncedAt: new Date().toISOString(),
    source: "Yahoo Finance",
    stockDate: dates[dates.length - 1] || null,
    indexDate: idxDates[idxDates.length - 1] || null,
    crossDate: crossDates[crossDates.length - 1] || null,
  },
  stocks,
  indices,
  cross,
};

writeFileSync(OUT, "window.WIND_LIVE = " + JSON.stringify(payload, null, 1) + ";\n");

console.log("\n完成 → " + path.basename(OUT));
console.log("  标的 " + Object.keys(stocks).length + "/" + STOCKS.length +
  " · 指数 " + Object.keys(indices).length + "/" + INDICES.length +
  " · 跨资产 " + Object.keys(cross).length + "/" + CROSS.length);
console.log("  股票日期 " + payload.meta.stockDate + " · 指数日期 " + payload.meta.indexDate);
if (Object.keys(stocks).length < STOCKS.length) {
  const miss = STOCKS.filter((s) => !stocks[s[0]]).map((s) => s[1]);
  console.warn("  缺失标的: " + miss.join(", "));
}
