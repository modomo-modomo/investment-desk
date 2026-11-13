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
  ["RUT.GI", "^RUT", "罗素2000"],
  ["SOX.GI", "^SOX", "费城半导体指数"],
  ["VIX.GI", "^VIX", "CBOE波动率"],
  ["N225.GI", "^N225", "日经225"],
  ["KS11.GI", "^KS11", "韩国综合指数"],
  ["GDAXI.GI", "^GDAXI", "德国DAX"],
  ["FTSE.GI", "^FTSE", "英国富时100"],
  ["SX5E.DF", "^STOXX50E", "欧元区STOXX50(欧元)"],
];
/* 港股 / A 股指数统一走东财日 K：
   Yahoo 对 000688.SS / 399006.SZ / 932000.SS / HSTECH.HK 这类只返回 1 根日线（算不出当日与 20 日），
   恒生医疗保健 / 恒生港股通 / 恒生港股通高股息率 / 北证50 干脆没有代码。 */
const EM_IDX = [
  ["HSI.HI", "100", "HSI", "恒生指数"],
  ["HSTECH.HI", "124", "HSTECH", "恒生科技指数"],
  ["HSHCI.HI", "124", "HSHCI", "恒生医疗保健"],
  ["HSHKI.HI", "124", "HSHKI", "恒生港股通"],
  ["HSSCHKY.HI", "124", "HSSCHKY", "恒生港股通高股息率"],
  ["000001.SH", "1", "000001", "上证指数"],
  ["000688.SH", "1", "000688", "科创50"],
  ["000698.SH", "1", "000698", "科创100"],
  ["399006.SZ", "0", "399006", "创业板指"],
  ["000300.SH", "1", "000300", "沪深300"],
  ["000905.SH", "1", "000905", "中证500"],
  ["000852.SH", "1", "000852", "中证1000"],
  ["932000.SH", "2", "932000", "中证2000"],
  ["BSE50.BJ", "0", "899050", "北证50"],
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

/* 美东日期（YYYYMMDD）：收盘结算类判断必须按交易所在时区，不能按 UTC */
const etDay = (ms) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ms)).replace(/-/g, "");

/* quote 回填：Yahoo 偶发在收盘后未及时结算最后一根日K（close=null），
   chart 的"最新收盘"会滞后一个交易日；quote v7 的 regularMarketPrice /
   regularMarketPreviousClose 是权威值。当 quote 的行情时间（美东日）
   晚于最后一根K线的日期时，用 quote 覆盖最新收盘与前收。 */
function backfill(rows, q) {
  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2] || last;
  const norm = (d) => String(d).replace(/-/g, "");
  if (!q || q.regularMarketPrice == null || !q.regularMarketTime) {
    return { date: last.date, price: last.close, prev: prev.close, fixed: false };
  }
  const qd = etDay(q.regularMarketTime * 1000);
  if (qd > norm(last.date)) {
    return {
      date: qd,
      price: q.regularMarketPrice,
      prev: q.regularMarketPreviousClose ?? prev.close,
      fixed: true,
    };
  }
  return { date: last.date, price: last.close, prev: prev.close, fixed: false };
}

/* 结算口径（期货/外汇/亚太欧洲指数）：这些品种 24h 或盘后仍在报价，
   chart 的最后一根日K可能是"进行中 session 的实时价"，绝不能当收盘。
   统一取"最近已结算收盘"：
   - REGULAR/PRE/POST（交易中）→ price = regularMarketPreviousClose（上一结算价）
   - POSTPOST（收盘态）        → price = regularMarketPrice（即最新收盘）
   - prev：若 price 与剔除进行中K线后的末根一致（chart 已含最新结算）取倒数第二根，
     否则取末根（chart 结算滞后一根的情形，如期货）。
   - 进行中K线判定：UTC 日期晚于行情时间的美东日期 → 剔除。 */
function settle(rows, q, cashIndex = false) {
  const norm = (d) => String(d).replace(/-/g, "");
  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2] || last;
  if (!q || q.regularMarketPrice == null || !q.regularMarketTime) {
    return { date: last.date, price: last.close, prev: prev.close, fixed: false };
  }
  const et = etDay(q.regularMarketTime * 1000);
  const rows2 = rows.filter((r) => norm(r.date) <= et);
  const l2 = rows2[rows2.length - 1] || last;
  const p2 = rows2[rows2.length - 2] || l2;
  /* 现金指数（标普/纳指/道指/费半…）常规时段收盘后 regularMarketPrice 即为官方收盘价，
     即使 marketState 仍为 POST（16:00–20:00 ET 盘后）也不能回退到 previousClose，
     否则会把上一交易日收盘当成"最新收盘"，涨跌符号随之反向。
     北京 07:00 场次（美东 18:00）恰好落在 POST 段，必踩此坑。
     期货/外汇 24h 报价仍需避开进行中的 session，保持原逻辑。 */
  const live = !cashIndex &&
    (q.marketState === "REGULAR" || q.marketState === "PRE" || q.marketState === "POST");
  if (cashIndex) {
    /* 现金指数：price 取 regularMarketPrice（收盘后即官方收盘）；前收取"不晚于美东当日的
       末根日K"。注意不能用 quote.regularMarketPreviousClose——亚太指数在次日上午查询时，
       Yahoo 给的前收仍是"上一交易日的前收"，会整体错一根（HSI/上证/日经都会中招）。
       仅当 price 与末根K线完全相等（chart 已含最新结算）时才退到倒数第二根；
       原先是 0.1% 容差，遇到当日微涨（STOXX50 +0.09%）会误判同一根、涨跌幅被放大。 */
    const price = q.regularMarketPrice;
    const same = Math.abs(price - l2.close) <= Math.abs(l2.close) * 1e-6;
    return { date: et, price, prev: same ? p2.close : l2.close, fixed: true };
  }
  const price = live && q.regularMarketPreviousClose != null ? q.regularMarketPreviousClose : q.regularMarketPrice;
  const sameAsL2 = Math.abs(price - l2.close) / Math.abs(l2.close) < 0.001;
  return { date: et, price: price, prev: sameAsL2 ? p2.close : l2.close, fixed: true };
}

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
const YTD_START = new Date().getFullYear() + "-01-01";
console.log("抓取标的行情（" + STOCKS.length + " 只）…");
const stockCharts = await batched(STOCKS, 5, async (s) => {
  const c = await chart(s[1], "1y");
  return { code: s[0], sym: s[1], name: s[2], rows: c.rows };
});
const stockQuotes = await quotes(STOCKS.map((s) => s[1]));

const stocks = {};
let backfilled = 0;
for (const c of stockCharts) {
  if (!c || !c.rows.length) continue;
  const rows = c.rows;
  const base20 = rows[rows.length - 22] || rows[0];
  const q = stockQuotes[c.sym] || {};
  const bx = backfill(rows, q);
  if (bx.fixed) backfilled++;
  const ytd0 = rows.find((r) => r.date >= YTD_START);
  stocks[c.code] = {
    name: c.name,
    date: bx.date.replace(/-/g, ""),
    price: +bx.price.toFixed(2),
    prev: +bx.prev.toFixed(2),
    chg: +(pct(bx.price, bx.prev) ?? 0).toFixed(2),
    d20: +(pct(bx.price, base20.close) ?? 0).toFixed(2),
    ytd: ytd0 ? +(pct(bx.price, ytd0.close) ?? 0).toFixed(2) : null,
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
const idxQuotes = await quotes(INDICES.map((s) => s[1]));

const indices = {};
for (const c of idxCharts) {
  if (!c || !c.rows.length) continue;
  const rows = c.rows;
  const base20 = rows[rows.length - 22] || rows[0];
  const bx = settle(rows, idxQuotes[c.sym] || {}, true);
  if (bx.fixed) backfilled++;
  /* 指数用 amount 表示成交额，Yahoo chart 只有 volume，这里留 null 由 live-extra 补 */
  indices[c.code] = {
    name: c.name,
    date: bx.date.replace(/-/g, ""),
    level: +bx.price.toFixed(2),
    prev: +bx.prev.toFixed(2),
    chg: +(pct(bx.price, bx.prev) ?? 0).toFixed(2),
    d20: +(pct(bx.price, base20.close) ?? 0).toFixed(2),
    amount: null,
  };
}

/* 东财日 K 兜底：Yahoo 缺恒生医疗保健 / 恒生港股通 / 恒生港股通高股息率 / 北证50 */
async function emKline(mkt, code) {
  const u = "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=" + mkt + "." + code +
    "&klt=101&fqt=1&end=20500101&lmt=40&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f53,f59";
  let lastErr = null;
  for (let i = 0; i < 3; i++) { /* 东财偶发连接重置，重试 3 次（每次退避 800ms） */
    try {
      const r = await fetch(u, { headers: { "User-Agent": UA, Referer: "https://quote.eastmoney.com/" } });
      const j = await r.json();
      const kl = (j.data && j.data.klines) || [];
      return kl.map((s) => { const p = s.split(","); return { date: p[0], close: +p[1], chg: +p[2] }; });
    } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 800 * (i + 1))); }
  }
  throw lastErr;
}
for (const [code, mkt, emc, name] of EM_IDX) {
  try {
    const rows = await emKline(mkt, emc);
    if (rows.length < 2) { console.warn("东财指数无数据 " + name); continue; }
    const last = rows[rows.length - 1];
    const base20 = rows[rows.length - 22] || rows[0];
    indices[code] = {
      name,
      date: last.date.replace(/-/g, ""),
      level: +last.close.toFixed(2),
      prev: +(rows[rows.length - 2].close).toFixed(2),
      chg: +last.chg.toFixed(2),
      d20: +(((last.close / base20.close) - 1) * 100).toFixed(2),
      amount: null,
    };
  } catch (e) { console.warn("东财指数抓取失败 " + name + ": " + e.message); }
}

/* ---------- 跨资产 ---------- */console.log("抓取跨资产（" + CROSS.length + " 项）…");
const crossCharts = await batched(CROSS, 4, async (s) => {
  const c = await chart(s[1], "3mo");
  return { row: s, rows: c.rows };
});
const crossQuotes = await quotes(CROSS.map((s) => s[1]));

const cross = {};
for (const c of crossCharts) {
  if (!c || !c.rows.length) continue;
  const [key, sym, name, unit, mul, isBp] = c.row;
  const rows = c.rows;
  const base20 = rows[rows.length - 22] || rows[0];
  /* 期货/外汇 24h 报价，chart 末根可能是盘中价——统一取"最近已结算收盘" */
  const bx = settle(rows, crossQuotes[sym] || {});
  if (bx.fixed) backfilled++;
  const v = bx.price * mul;
  const p1 = bx.prev * mul;
  const p20 = base20.close * mul;
  cross[key] = {
    name,
    unit,
    date: bx.date.replace(/-/g, ""),
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
if (backfilled) console.log("  quote 回填 " + backfilled + " 条（收盘后日K结算延迟，已用 quote v7 覆盖）");
if (Object.keys(stocks).length < STOCKS.length) {
  const miss = STOCKS.filter((s) => !stocks[s[0]]).map((s) => s[1]);
  console.warn("  缺失标的: " + miss.join(", "));
}
