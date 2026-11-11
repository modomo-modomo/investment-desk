#!/usr/bin/env node
/**
 * Wind 数据同步 → live-data.js
 * 用法：node sync.mjs
 *
 * 依赖已安装的 Wind Skill：~/.agents/skills/wind-mcp-skill
 * 每次运行 3 次 Wind 调用（股票 / 指数 / 宏观），产出可直接被 index.html 读取的 JS 文件。
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const SKILL = path.join(homedir(), ".agents", "skills", "wind-mcp-skill");
if (!existsSync(path.join(SKILL, "scripts", "cli.mjs"))) {
  console.error("未找到 Wind Skill，请先安装 wind-mcp-skill");
  process.exit(1);
}

function call(serverType, toolName, params) {
  const out = execFileSync(process.execPath, ["scripts/cli.mjs", "call", serverType, toolName, JSON.stringify(params)], {
    cwd: SKILL,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const env = JSON.parse(out);
  if (env.ok === false) throw new Error(`${serverType}.${toolName}: ${env.code} ${env.message}`);
  const txt = env.content?.[0]?.text;
  if (!txt) throw new Error(`${serverType}.${toolName}: 空响应`);
  const body = JSON.parse(txt);
  if (body.error) throw new Error(`${serverType}.${toolName}: ${JSON.stringify(body.error)}`);
  // 股票/指数返回 {data:{columns,rows}}；宏观 EDB 返回 {metrics:[...]} 在根层
  return body.data ?? body;
}

const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const rowsToTable = (data) => {
  const cols = data.columns.map((c) => c.name);
  return data.rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
};

/* ---------------- 1. 股票 ----------------
   覆盖标的研究池（SPCX 为一级市场，无行情，不在此列） */
const STOCK_CODES = [
  "TSLA.O", "META.O", "IREN.O", "NBIS.O", "CRWV.O", "BE.N",
  "AMD.O", "TSM.N", "TER.O", "ONTO.N", "NET.N", "RBRK.N", "OKTA.O", "CHKP.O",
];
const stocks = {};
try {
  const t = rowsToTable(call("stock_data", "get_stock_price_indicators", {
    windcode: STOCK_CODES.join(","),
    indexes: "最新交易日,中文简称,最新成交价,前收盘价,涨跌幅,20日涨跌幅,总市值2,盘前涨跌幅,盘后涨跌幅",
  }));
  for (const r of t) {
    stocks[r["Wind代码"]] = {
      name: r["中文简称"],
      date: r["最新交易日"],
      price: num(r["最新成交价"]),
      prev: num(r["前收盘价"]),
      chg: num(r["涨跌幅"]),
      d20: num(r["20日涨跌幅"]),
      mcap: num(r["总市值2"]),
      pre: num(r["盘前涨跌幅"]),
      post: num(r["盘后涨跌幅"]),
    };
  }
} catch (e) {
  console.error("股票行情失败：", e.message);
}

/* ---------------- 2. 指数 ---------------- */
const INDEX_CODES = [
  "SPX.GI", "NDX.GI", "IXIC.GI", "DJI.GI", "SOX.GI", "VIX.GI",
  "HSI.HI", "000001.SH", "N225.GI", "KS11.GI", "GDAXI.GI", "FTSE.GI", "SX5E.DF",
];
const indices = {};
try {
  const t = rowsToTable(call("index_data", "get_index_price_indicators", {
    windcode: INDEX_CODES.join(","),
    indexes: "最新交易日,中文简称,最新成交价,前收盘价,涨跌幅,20日涨跌幅,成交额",
  }));
  for (const r of t) {
    if (!r["最新成交价"] || r["最新成交价"] === "0") continue;
    indices[r["Wind代码"]] = {
      name: r["中文简称"],
      date: r["最新交易日"],
      level: num(r["最新成交价"]),
      prev: num(r["前收盘价"]),
      chg: num(r["涨跌幅"]),
      d20: num(r["20日涨跌幅"]),
      amount: num(r["成交额"]),
    };
  }
} catch (e) {
  console.error("指数行情失败：", e.message);
}

/* ---------------- 3. 跨资产（EDB 日频序列） ---------------- */
const EDB = {
  UST10Y: "G0000891",
  DXY: "M0000271",
  GOLD: "S0031645",
  SILVER: "S0031648",
  COPPER: "S0029751",
  WTI: "S5111903",
  BRENT: "S5111905",
};
const cross = {};
try {
  const d = call("economic_data", "query_economic_indicator_data", {
    question: Object.values(EDB).join(","),
    observation: "45",
  });
  for (const mt of d.metrics) {
    const key = Object.keys(EDB).find((k) => EDB[k] === mt.meta.code);
    if (!key) continue;
    const pairs = mt.value.map((v, i) => [mt.date[i], v]).filter((p) => p[1] !== null);
    if (pairs.length < 2) continue;
    const last = pairs[pairs.length - 1];
    const prev = pairs[pairs.length - 2];
    const base = pairs.length >= 21 ? pairs[pairs.length - 21] : null;
    cross[key] = {
      name: mt.meta.name,
      unit: mt.meta.unit,
      date: last[0],
      value: Number(last[1]),
      d1: prev[1] ? ((last[1] / prev[1] - 1) * 100) : null,
      d20: base && base[1] ? ((last[1] / base[1] - 1) * 100) : null,
      // 收益率类项目额外给出 bp 变动
      dbp1: /%$/.test(mt.meta.unit || "") ? (last[1] - prev[1]) * 100 : null,
      dbp20: /%$/.test(mt.meta.unit || "") && base ? (last[1] - base[1]) * 100 : null,
    };
  }
} catch (e) {
  console.error("跨资产失败：", e.message);
}

/* ---------------- 输出 ---------------- */
const out = {
  meta: {
    syncedAt: new Date().toISOString(),
    source: "Wind (aifinmarket)",
    stockDate: Object.values(stocks)[0]?.date || null,
    indexDate: Object.values(indices)[0]?.date || null,
    crossDate: Object.values(cross)[0]?.date || null,
  },
  stocks,
  indices,
  cross,
};
writeFileSync("live-data.js", "window.WIND_LIVE = " + JSON.stringify(out, null, 1) + ";\n", "utf8");
console.log(`已写入 live-data.js｜股票 ${Object.keys(stocks).length}｜指数 ${Object.keys(indices).length}｜跨资产 ${Object.keys(cross).length}`);
