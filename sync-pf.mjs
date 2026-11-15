/* ==========================================================================
   sync-pf.mjs —— 模拟组合：净值序列 + 调仓记录
   1) 从 index.html 里解析 PF 配置（持仓 / 建仓权重 / 11-06 买入价 / 现金比例）
      —— 单一事实来源仍在页面，避免两处手改不一致
   2) 拉每只持仓自建仓日至今的日收盘，按「建仓权重、不再平衡」算每日净值
      净值(d) = Σ 权重_i × 收盘_i(d)/买入价_i + 现金比例
   3) 基准：纳斯达克 100（^NDX）、恒生指数（^HSI），以建仓日收盘归一为 1
      —— 页面上默认不画，用户勾选后才叠加
   4) 读 pf-trades.json（调仓记录，人工维护，只增不减）→ 一起写进 pf-nav.js
   产物：pf-nav.js  →  window.PF_NAV = { base, series, bench, trades, meta }
   ========================================================================== */
import fs from "node:fs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36";
const html = fs.readFileSync("index.html", "utf8");

/* ---------- 1. 解析 PF 配置 ---------- */
const blockM = html.match(/const PF = \{[\s\S]*?\n\};/);
if (!blockM) { console.error("未找到 PF 配置"); process.exit(1); }
const block = blockM[0];
const base = (block.match(/base:\s*"([\d-]+)"/) || [])[1];
const cashW = +((block.match(/cashW:\s*(\d+)/) || [])[1] || 0);
const rows = [...block.matchAll(/\{\s*t:\s*"([^"]+)",\s*w:\s*(\d+),\s*px0:\s*([\d.]+)\s*\}/g)]
  .map((m) => ({ t: m[1], w: +m[2], px0: +m[3] }));
console.log(`组合：建仓 ${base} · ${rows.length} 只 + 现金 ${cashW}%`);
rows.forEach((r) => console.log(`  ${r.t.padEnd(11)} ${String(r.w).padStart(3)}%  买入价 ${r.px0}`));

/* ---------- 2. 抓日线 ---------- */
const SYM = { "2105.HK": "2105.HK", "002436.SZ": "002436.SZ" };
const ysym = (t) => SYM[t] || t;
async function chart(sym) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d`;
  const r = await fetch(u, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  const res = j.chart.result[0];
  const ts = res.timestamp || [], cl = res.indicators.quote[0].close || [];
  const out = {};
  ts.forEach((t, i) => {
    if (cl[i] == null) return;
    const d = new Date(t * 1000).toISOString().slice(0, 10);
    out[d] = cl[i];
  });
  return out;
}
const closes = {};
for (const r of rows) {
  try { closes[r.t] = await chart(ysym(r.t)); console.log(`  ✓ ${r.t} ${Object.keys(closes[r.t]).length} 天`); }
  catch (e) { console.warn(`  ✗ ${r.t}: ${e.message}`); }
  await new Promise((x) => setTimeout(x, 180));
}
const BENCH = { NDX: { sym: "^NDX", n: "纳指 100" }, HSI: { sym: "^HSI", n: "恒生指数" } };
const benchRaw = {};
for (const [k, b] of Object.entries(BENCH)) {
  try { benchRaw[k] = await chart(b.sym); console.log(`  ✓ ${b.n} ${Object.keys(benchRaw[k]).length} 天`); }
  catch (e) { console.warn(`  ✗ ${b.n}: ${e.message}`); }
  await new Promise((x) => setTimeout(x, 180));
}

/* ---------- 3. 交易日历：以纳指（回退到任一只持仓）的日期为准，后续日期前向填充 ---------- */
const calKey = benchRaw.NDX ? "NDX" : null;
const allDates = [...new Set(
  (calKey ? Object.keys(benchRaw[calKey]) : Object.values(closes)[0] ? Object.keys(Object.values(closes)[0]) : [])
)].filter((d) => d >= base).sort();
console.log(`净值区间：${allDates[0]} → ${allDates[allDates.length - 1]}（${allDates.length} 个交易日）`);

function ffill(map, dates) {
  const out = {};
  let last = null;
  const keys = Object.keys(map).sort();
  let i = 0;
  for (const d of dates) {
    while (i < keys.length && keys[i] <= d) { last = map[keys[i]]; i++; }
    out[d] = last;
  }
  return out;
}
const series = [];
for (const d of allDates) {
  let nav = cashW / 100;
  let ok = true;
  for (const r of rows) {
    const m = closes[r.t];
    if (!m) { ok = false; break; }
    const px = ffill(m, [d])[d];
    if (px == null) { ok = false; break; }
    nav += (r.w / 100) * (px / r.px0);
  }
  if (ok) series.push({ d, nav: +nav.toFixed(4) });
}

/* ---------- 4. 基准归一 ---------- */
const bench = {};
for (const [k, b] of Object.entries(BENCH)) {
  const raw = benchRaw[k];
  if (!raw || raw[base] == null) { console.warn(`  基准 ${b.n} 缺少建仓日收盘，跳过`); continue; }
  const lv = ffill(raw, allDates);
  bench[k] = { n: b.n, series: allDates.map((d) => ({ d, v: lv[d] == null ? null : +(lv[d] / raw[base]).toFixed(4) })).filter((x) => x.v != null) };
}

/* ---------- 5. 调仓记录 ---------- */
let trades = [];
if (fs.existsSync("pf-trades.json")) {
  try { trades = JSON.parse(fs.readFileSync("pf-trades.json", "utf8")).trades || []; }
  catch (e) { console.warn("pf-trades.json 解析失败：" + e.message); }
}
trades.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0));

const out = {
  base,
  series,
  bench,
  trades,
  meta: {
    updated: new Date().toISOString().slice(0, 10),
    points: series.length,
    last: series.length ? series[series.length - 1] : null,
    source: "Yahoo Finance 日收盘 · 权重按建仓比例不再平衡",
    note: "净值仅用于检验建仓决策，不含交易成本与汇率波动"
  }
};
fs.writeFileSync("pf-nav.js", "window.PF_NAV = " + JSON.stringify(out) + ";\n");
console.log(`完成 → pf-nav.js（${series.length} 个点 · 调仓 ${trades.length} 条）`);
console.log(`  期末净值 ${out.meta.last ? out.meta.last.nav : "—"}（${out.meta.last ? out.meta.last.d : "—"}）`);
