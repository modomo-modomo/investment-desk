/* sync-brief.mjs — 核心结论存档（brief-log.json）
 *
 * 职责：把「当日 / 本周 / 本月」的核心结论写进一份存档，页面 hero 与 02 区块都从这份文件读。
 * 明确边界：这里只做「用数据能推出来的话」+ 固定分析框架，不编故事、不预测点位。
 *           会话里可以改写覆盖（同 kind+日期整条替换），脚本只在缺失时补、不覆盖已有的人工版本。
 *
 * 运行时机：sync-core → sync-extra → **sync-brief** → sync-news
 *           （sync-news 会把 brief-log 透传进 live-news.js，喂给页面）
 *
 * 触发规则（按北京时间）：
 *   daily       每次 07:00 场：若最新收盘日还没有存档，自动补一条（会话写过就不动）
 *   weekly      周六 07:00（= 周五收盘后）：本周核心结论 + 下周策略展望
 *   month-draft 每月 25 日：本月核心结论 + 下月展望 初稿
 *   month-final 月末最后一个交易日收盘后（新月第一场）：上月终稿
 */
import fs from "node:fs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const LOG = (m) => console.log(m);

/* ---------- 基础工具 ---------- */
/* BRIEF_TEST_BJ=YYYY-MM-DD 可模拟指定北京日期，用于验证 25 日初稿 / 月末终稿逻辑 */
const TEST_BJ = process.env.BRIEF_TEST_BJ || "";
const bjNow = TEST_BJ ? new Date(TEST_BJ + "T09:00:00Z") : new Date(Date.now() + 8 * 3600 * 1000); /* 用 UTC 字段读北京时间 */
const BJ = { y: bjNow.getUTCFullYear(), m: bjNow.getUTCMonth() + 1, d: bjNow.getUTCDate(), dow: bjNow.getUTCDay(), hh: bjNow.getUTCHours() };
const pad = (n) => String(n).padStart(2, "0");
const BJ_DATE = `${BJ.y}-${pad(BJ.m)}-${pad(BJ.d)}`;
const ymd = (s) => String(s || "").replace(/-/g, "").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
const parse = (s) => new Date(ymd(s) + "T00:00:00Z");
const addDays = (s, n) => new Date(parse(s).getTime() + n * 864e5).toISOString().slice(0, 10);
const monthOf = (s) => ymd(s).slice(0, 7);
const inRange = (s, a, b) => { const t = ymd(s); return t >= a && t <= b; };
const pct = (v, d = 1) => (v == null || !Number.isFinite(+v) ? "—" : (v > 0 ? "+" : "") + (+v).toFixed(d) + "%");
const sign = (v) => (v == null || !Number.isFinite(+v) ? "" : v > 0 ? "up" : v < 0 ? "down" : "");
const b = (v, d = 1, unit = "%") => `<b class="${sign(v)}">${pct(v, d).replace("%", unit)}</b>`;
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* ---------- 读数据 ---------- */
const readJs = (file) => {
  try {
    const src = fs.readFileSync(file, "utf8");
    const s = src.indexOf("=") + 1, e = src.lastIndexOf(";");
    return JSON.parse(src.slice(s, e));
  } catch { return null; }
};
const W = readJs("live-data.js") || {};
const Y = readJs("live-extra.js") || {};
const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return dflt; } };

let LOGS = readJson("brief-log.json", []);
const HIGH = readJson("highs-log.json", []);
const BEAT = readJson("earn-beat-log.json", []);
const MOVERS = readJson("movers-log.json", []);

const IDX = W.indices || {};
const CR = W.cross || {};
const SEC = Y.sectors || {};
const BR = Y.breadth || {};
const BQ = Y.btc || {}, EQ = Y.eth || {};
const CLOSE = ymd(W.meta && W.meta.indexDate) || ymd(W.meta && W.meta.stockDate) || BJ_DATE;

/* ---------- 历史日线（算月内涨幅用，chart v8 不需要 crumb） ---------- */
async function hist(sym, range = "3mo") {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d`;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(u, { headers: { "User-Agent": UA } });
      const j = await r.json();
      const res = j.chart && j.chart.result && j.chart.result[0];
      if (!res) throw new Error("empty");
      const ts = res.timestamp || [];
      const cl = ((res.indicators || {}).quote || [{}])[0].close || [];
      return ts.map((t, k) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: cl[k] }))
        .filter((x) => x.close != null);
    } catch (e) { await new Promise((s) => setTimeout(s, 700 * (i + 1))); }
  }
  return [];
}

/* 月内涨幅：上月末收盘 → 指定截止日收盘 */
function monthChange(rows, month, upto) {
  if (!rows.length) return null;
  const prev = rows.filter((r) => monthOf(r.date) < month);
  const base = prev.length ? prev[prev.length - 1].close : null;
  const cur = rows.filter((r) => monthOf(r.date) === month && (!upto || r.date <= upto));
  const last = cur.length ? cur[cur.length - 1].close : null;
  if (base == null || last == null) return { chg: null, last, base };
  return { chg: (last / base - 1) * 100, last, base };
}

/* ---------- 当日：自动兜底（会话没写时才有意义） ---------- */
function dailyAuto() {
  const spx = IDX["SPX.GI"] || {}, ndx = IDX["IXIC.GI"] || {}, dji = IDX["DJI.GI"] || {};
  const rut = IDX["RUT.GI"] || {}, sox = IDX["SOX.GI"] || {}, vix = IDX["VIX.GI"] || {};
  const hsi = IDX["HSI.HI"] || {}, sh = IDX["000001.SH"] || {};
  const rel20 = BR.rel20, rel5 = BR.rel5;
  const c = spx.chg;
  const up = c > 0.25, down = c < -0.25;
  const broad = rel20 != null ? rel20 >= 0 : null;
  let stance;
  if (up && broad) stance = "普涨（权重与广度同向）";
  else if (up && broad === false) stance = "指数上涨、广度未跟上（权重股拉指数）";
  else if (down && broad === false) stance = "普跌（广度同步走弱）";
  else if (down && broad) stance = "指数下跌、个股抗跌（结构性调整）";
  else stance = "窄幅震荡（方向未选）";

  const note = `美股 标普 ${pct(c, 2)}、纳指 ${pct(ndx.chg, 2)}、道指 ${pct(dji.chg, 2)}；`
    + `中国香港 恒生 ${pct(hsi.chg, 2)}、中国内地 上证 ${pct(sh.chg, 2)}。`
    + (vix.chg != null ? `VIX ${pct(vix.chg, 1)} 至 ${vix.level != null ? vix.level.toFixed(2) : "—"}；` : "")
    + (rel20 != null ? `等权相对市值加权 20 日 ${pct(rel20, 1)}——${rel20 >= 0 ? "中位数个股强于权重，跌的是大票不是全市场" : "上涨靠权重拉动，广度在恶化"}。` : "");

  const list = [];
  list.push([
    `三大市场同日收盘：标普 ${pct(c, 1)}、恒生 ${pct(hsi.chg, 1)}、上证 ${pct(sh.chg, 1)}。`,
    `${up ? "指数收涨" : down ? "指数收跌" : "指数基本走平"}，`
    + `纳指 ${pct(ndx.chg, 1)} vs 道指 ${pct(dji.chg, 1)}——${(ndx.chg || 0) < (dji.chg || 0) ? "成长端更弱，资金偏向价值/防御" : "成长端更强，风险偏好在修复"}。`,
  ]);
  if (rel20 != null || rel5 != null) {
    list.push([
      `结构：等权 ${pct(BR.rsp5, 1)}（周） vs 市值加权 ${pct(BR.spy5, 1)}，差 ${pct(rel5, 1)}。`,
      rel5 != null && rel5 >= 0
        ? "本周个股表现好于指数，属于“权重拖累、广度改善”的组合，指数弱不代表持仓弱。"
        : "本周指数强于个股，涨幅集中在少数权重，广度没有跟上——这种结构下追高指数性价比低。",
    ]);
  }
  const us10 = CR["UST10Y"], dxy = CR["DXY"];
  list.push([
    `跨资产：10Y ${us10 && us10.value != null ? us10.value.toFixed(2) + "%" : "—"}、美元指数 ${dxy && dxy.value != null ? dxy.value.toFixed(2) : "—"}、BTC ${BQ.price != null ? "$" + Math.round(BQ.price).toLocaleString() : "—"}。`,
    `VIX ${vix.level != null ? vix.level.toFixed(2) : "—"}（${pct(vix.chg, 1)}）——`
    + `${(vix.chg || 0) > 0 ? "波动率抬升，分歧在放大" : "波动率回落，避险需求下降"}；`
    + `BTC 当日 ${pct(BQ.chg, 1)}，${(BQ.chg || 0) > 0 ? "风险偏好的边际信号偏正面" : "加密走弱，风险偏好边际收缩"}。`,
  ]);
  return { stance, stanceNote: note, conclusions: list };
}

/* ---------- 周报（周六 07:00） ---------- */
function weekStartOf(dateStr) {
  const d = parse(dateStr);
  const dow = d.getUTCDay();           /* 0=周日 */
  const back = dow === 0 ? 6 : dow - 1; /* 回退到周一 */
  return addDays(dateStr, -back);
}

function weeklyAuto(weekEnd) {
  const weekStart = weekStartOf(weekEnd);
  const g = (k) => IDX[k] || {};
  const spx = g("SPX.GI"), ndx = g("IXIC.GI"), dji = g("DJI.GI"), rut = g("RUT.GI"), sox = g("SOX.GI"), vix = g("VIX.GI");
  const hsi = g("HSI.HI"), sh = g("000001.SH"), kc50 = g("000688.SH"), cyb = g("399006.SZ");
  const secs = Object.keys(SEC).map((k) => ({ k, ...SEC[k] })).filter((x) => x.d5 != null).sort((a, c) => c.d5 - a.d5);
  const top = secs.slice(0, 3), bot = secs.slice(-2);
  const rel5 = BR.rel5, rel20 = BR.rel20;

  const weekBeats = BEAT.filter((x) => inRange(x.d, weekStart, weekEnd));
  const wkHigh = HIGH.filter((x) => inRange(x.d, weekStart, weekEnd));
  const uniqHigh = new Set(wkHigh.map((x) => x.sym));
  const athN = new Set(wkHigh.filter((x) => x.type === "ath").map((x) => x.sym)).size;
  const w52N = new Set(wkHigh.filter((x) => x.type === "52w").map((x) => x.sym)).size;
  const sessions = MOVERS.filter((x) => inRange(x.date, weekStart, weekEnd));
  const mvTop = [];
  for (const s of sessions) for (const r of (s.rows || [])) mvTop.push(r);
  mvTop.sort((a, c) => Math.abs(c.mv) - Math.abs(a.mv));
  const topMv = mvTop.slice(0, 3);

  /* 板块普涨/普跌/分化要先判，否则会出现“板块同向”却全为正的错话 */
  const allUp = secs.length > 0 && secs.every((x) => x.d5 > 0);
  const allDown = secs.length > 0 && secs.every((x) => x.d5 < 0);
  const flat5 = rel5 != null && Math.abs(rel5) < 0.5;   /* 个股与指数周差 <0.5pct 视为同步 */

  /* 主线判断：按周涨幅与广度决定基调 */
  const lead = top[0] ? top[0].cn : "—";
  const defensive = ["公用事业", "必需消费", "医疗", "房地产"].includes(lead);
  const stance = `本周主线：${lead}${secs.length ? `（${pct(top[0].d5)}）` : ""} · ${flat5 ? "个股与指数同步" : rel5 != null && rel5 >= 0 ? "个股强于指数" : "指数强于个股"}`;

  const note = `本周（${weekStart} ~ ${weekEnd}）标普 ${pct(spx.d5)}、纳指 ${pct(ndx.d5)}、道指 ${pct(dji.d5)}；`
    + `恒生 ${pct(hsi.d5)}、上证 ${pct(sh.d5)}。`
    + `等权 RSP ${pct(BR.rsp5)} vs 市值加权 SPY ${pct(BR.spy5)}，差 ${pct(rel5)}；`
    + `本周业绩超预期存档 ${weekBeats.length} 条、创新高 ${uniqHigh.size} 只。`;

  const c1 = [
    `三大市场周表现：标普 ${pct(spx.d5)}、纳指 ${pct(ndx.d5)}、道指 ${pct(dji.d5)}、罗素 2000 ${pct(rut.d5)}；恒生 ${pct(hsi.d5)}、上证 ${pct(sh.d5)}、科创 50 ${pct(kc50.d5)}、创业板 ${pct(cyb.d5)}。`,
    `${(spx.d5 || 0) >= 0 ? "美股本周收涨" : "美股本周收跌"}，`
    + `${(rut.d5 || 0) < (spx.d5 || 0) ? "小盘继续跑输，风险偏好没有向广度扩散" : "小盘跑赢，市场广度在改善"}；`
    + `费半 ${pct(sox.d5)}——${(sox.d5 || 0) < (spx.d5 || 0) ? "AI/半导体链本周是拖累项" : "AI/半导体链本周是主要拉动"}。`
    + `中国资产：恒生 ${pct(hsi.d5)} vs 上证 ${pct(sh.d5)}，${(hsi.d5 || 0) > (sh.d5 || 0) ? "港股相对强于 A 股" : "A 股相对强于港股"}。`,
  ];
  const c2 = [
    `广度：等权 RSP ${pct(BR.rsp5)} vs 市值加权 SPY ${pct(BR.spy5)}，周差 ${pct(rel5)}；20 日口径差 ${pct(rel20)}。`,
    flat5
      ? "本周个股与指数<b>基本同步</b>——涨跌由系统性因素（宏观/利率）主导，选股的边际贡献有限，仓位比结构更重要。"
      : rel5 > 0
        ? "本周个股中位数好于指数——<b>跌的是权重，不是全市场</b>，这种结构下“指数难看、持仓不难看”是常态，不必按系统性风险处理。"
        : "本周指数强于个股——<b>上涨靠少数权重拉动</b>，广度没跟上，指数的强势对持仓的指示意义有限。",
  ];
  const c3 = [
    `板块周轮动：领涨 ${top.map((x) => `${x.cn} ${pct(x.d5)}`).join("、")}；最弱 ${bot.slice().reverse().map((x) => `${x.cn} ${pct(x.d5)}`).join("、")}。`,
    allUp
      ? "11 个板块<b>全线上涨</b>，是普涨周——领涨方向说明资金在哪里加仓最猛，但普涨周里选股的重要性下降、<b>仓位更重要</b>。"
      : allDown
        ? "11 个板块<b>全线下跌</b>，属于系统性回撤，这种周里减仓优于换股。"
        : `${defensive ? "领涨的是<b>防御方向</b>（公用/必需消费/医疗/地产），说明资金在做防守，不是全面 risk-on" : "领涨的是<b>进攻方向</b>，风险偏好有修复"}；`
          + `板块首尾差 ${pct((top[0].d5 || 0) - (bot[bot.length - 1].d5 || 0))}，是<b>结构性行情</b>而非普涨普跌，选方向比选指数重要。`,
  ];
  const beatTop = weekBeats.filter((x) => x.chg != null).sort((a, c) => Math.abs(c.chg) - Math.abs(a.chg)).slice(0, 4);
  const c4 = [
    `财报驱动：本周业绩超预期存档 <b>${weekBeats.length}</b> 条（盘前 ${weekBeats.filter((x) => x.sess === "pre").length} / 盘后 ${weekBeats.filter((x) => x.sess === "post").length}），`
    + `其中大市值 ${weekBeats.filter((x) => x.size === "大市值").length} 条。`,
    weekBeats.length
      ? (beatTop.length ? `代表个股：${beatTop.map((x) => `${x.sym} ${pct(x.chg)}（${x.sess === "pre" ? "盘前" : "盘后"}）`).join("、")}——` : "")
        + `业绩超预期能否延续到下周，看的是<b>指引有没有上修</b>，不是单季 beat。`
      : "本周没有达到门槛的业绩超预期样本，说明本周行情主要由<b>非财报因素</b>（宏观/资金/主题）驱动。",
  ];
  const c5 = [
    `新高与异动：本周创新高 <b>${uniqHigh.size}</b> 只（历史新高 ${athN} 只 / 52 周新高 ${w52N} 只）；`
    + `盘前盘后异动留档 ${sessions.length} 场。`,
    topMv.length
      ? `周内波动最大：${topMv.map((r) => `${r.sym} ${pct(r.mv)}`).join("、")}。`
        + `${uniqHigh.size >= 10 ? "新高家数维持，说明结构性做多意愿还在" : "新高家数偏少，赚钱效应在收缩"}。`
      : "本周异动样本不足，滚动留档刚开始积累。",
  ];

  /* 下周展望 */
  const nextMon = addDays(weekEnd, 3 - ((parse(weekEnd).getUTCDay() + 6) % 7)); /* 周五 +3 天 = 下周一 */
  const nextFri = addDays(nextMon, 4);
  const nextEarn = [];
  for (const [sym, arr] of Object.entries(Y.nextEarn || {})) {
    for (const d of (arr || [])) if (inRange(d, nextMon, nextFri)) nextEarn.push({ sym, d });
  }
  nextEarn.sort((a, c) => a.d.localeCompare(c.d));

  const o1 = [
    `下周财报（覆盖池已知日历 ${nextEarn.length} 家）：${nextEarn.length ? nextEarn.slice(0, 6).map((x) => `${x.sym}（${x.d.slice(5)}）`).join("、") : "池内暂无已确认的披露日"}。`,
    nextEarn.length
      ? "重点看<b>指引</b>与电话会表述：本周超预期的方向如果下周被同行验证，主线才成立；反之只是一次性事件。"
      : "没有大票财报，行情更依赖<b>宏观数据与资金面</b>，指数波动会放大；这种周里消息面（政策/地缘/联储官员讲话）的权重高于基本面。",
  ];
  const weakest = bot.length ? bot[bot.length - 1] : null;
  const o2 = [
    `延续性：本周最强 ${top[0] ? `${top[0].cn}（周 ${pct(top[0].d5)}，20 日 ${pct(top[0].d20)}）` : "—"}；最弱 ${weakest ? `${weakest.cn}（周 ${pct(weakest.d5)}，20 日 ${pct(weakest.d20)}）` : "—"}。`,
    !top[0] || !weakest ? ""
      : allUp
        ? "本周<b>最弱的板块也是正收益</b>——普涨周里“最弱”只是涨得少，不代表基本面走坏；下周看的是<b>谁能把涨幅留住</b>（回调幅度小于板块平均的才是真强）。"
        : `${(top[0].d5 || 0) > 0 && (top[0].d20 || 0) > 0 ? "强势板块周与月同向，动量还在，回调可跟" : "强势板块只是周内反弹、20 日仍弱，属超跌修复，不宜当趋势"}；`
          + `${(weakest.d20 || 0) < 0 ? "弱势板块 20 日仍向下，反弹以减仓为主" : "弱势板块中期并未走坏，跌下来是机会而非风险"}。`,
  ];
  const vixW = vix.d5;   /* 周变化，比当日更能说明方向 */
  const o3 = [
    `风险位：VIX ${vix.level != null ? vix.level.toFixed(2) : "—"}（周 ${pct(vixW)}）、10Y ${CR["UST10Y"] && CR["UST10Y"].value != null ? CR["UST10Y"].value.toFixed(2) + "%" : "—"}（周 ${CR["UST10Y"] && CR["UST10Y"].dbp5 != null ? (CR["UST10Y"].dbp5 > 0 ? "+" : "") + CR["UST10Y"].dbp5.toFixed(0) + "bp" : "—"}）、标普距 20 日 ${pct(spx.d20)}。`,
    (vixW != null && vixW > 5
      ? "波动率本周明显抬升——<b>反弹要减仓、别追高</b>，除非 VIX 回落且指数收复 20 日线。"
      : vixW != null && vixW < -5
        ? "波动率本周明显回落——<b>情绪在修复</b>，趋势可延续；但低波动意味着对坏消息的缓冲变薄，别把宽松当无风险。"
        : "波动率基本走平——<b>方向没选</b>，等波动率选方向再决定加减仓。")
    + `${CR["UST10Y"] && CR["UST10Y"].value != null && CR["UST10Y"].value >= 5 ? "10Y 在 5% 上方，<b>估值端有硬约束</b>，高 multiple 的成长股对利率更敏感。" : ""}`,
  ];
  const o4 = [
    `下周操作框架：${flat5 ? "个股与指数同步 → 涨跌由系统性因素决定，重点放在<b>仓位与事件应对</b>，不必在选股上过度用力"
      : rel5 > 0 ? "广度改善 → 指数弱时不必恐慌，重点在个股与板块选择"
        : "广度恶化 → 只做最强主线，不摊平、不逆势加仓"}；`
    + `仓位按 VIX 反向调节，事件（财报/数据）前不满仓。`,
    `纪律：<b>不预测点位，只做准备</b>——把“如果…就…”写清楚，比猜方向有用。`,
  ];

  return { stance, stanceNote: note, conclusions: [c1, c2, c3, c4, c5], outlook: [o1, o2, o3, o4], period: `${weekStart}~${weekEnd}` };
}

/* ---------- 月报（25 日初稿 / 月末终稿） ---------- */
async function monthlyAuto(month, upto, isFinal) {
  const syms = [["^GSPC", "标普"], ["^IXIC", "纳指"], ["^HSI", "恒生"], ["000001.SS", "上证"], ["BTC-USD", "BTC"]];
  const out = {};
  for (const [sym, cn] of syms) {
    const rows = await hist(sym, "3mo");
    const m = monthChange(rows, month, isFinal ? null : upto);
    out[cn] = m && m.chg != null ? m.chg : null;
    await new Promise((s) => setTimeout(s, 150));
  }
  const beats = BEAT.filter((x) => monthOf(x.d) === month);
  const highsM = HIGH.filter((x) => monthOf(x.d) === month);
  const uniqH = new Set(highsM.map((x) => x.sym));
  const sessions = MOVERS.filter((x) => monthOf(x.date) === month);
  const secs = Object.keys(SEC).map((k) => ({ k, ...SEC[k] })).filter((x) => x.d20 != null).sort((a, c) => c.d20 - a.d20);
  const [mm, mon] = month.split("-");
  const label = `${mm} 年 ${+mon} 月`;
  const tag = isFinal ? "终稿" : "初稿";

  const stance = `${label}${tag}：${out["标普"] != null ? `标普月内 ${pct(out["标普"])}` : "数据待补"}${out["恒生"] != null ? ` · 恒生 ${pct(out["恒生"])}` : ""}`;
  const note = `${label}${tag}（${isFinal ? "数据截至月末收盘" : "数据截至 " + upto}）：`
    + `标普 ${pct(out["标普"])}、纳指 ${pct(out["纳指"])}、恒生 ${pct(out["恒生"])}、上证 ${pct(out["上证"])}、BTC ${pct(out["BTC"])}。`
    + `月内业绩超预期存档 ${beats.length} 条、创新高 ${uniqH.size} 只。`;

  const c1 = [
    `月度表现：标普 ${pct(out["标普"])}、纳指 ${pct(out["纳指"])}；恒生 ${pct(out["恒生"])}、上证 ${pct(out["上证"])}；BTC ${pct(out["BTC"])}。`,
    `${(out["标普"] || 0) >= 0 ? "美股月内收涨" : "美股月内收跌"}，`
    + `${(out["纳指"] || 0) < (out["标普"] || 0) ? "成长端弱于大盘，估值在压缩" : "成长端强于大盘，风险偏好在扩张"}；`
    + `${(out["恒生"] || 0) > (out["上证"] || 0) ? "中国香港强于中国内地，外资/南向更积极" : "中国内地强于中国香港，内资主导"}。`,
  ];
  const c2 = [
    `板块（近 20 个交易日）：最强 ${secs.slice(0, 3).map((x) => `${x.cn} ${pct(x.d20)}`).join("、") || "—"}；最弱 ${secs.slice(-2).map((x) => `${x.cn} ${pct(x.d20)}`).join("、") || "—"}。`,
    secs.length
      ? `${["公用事业", "必需消费", "医疗", "房地产"].includes(secs[0].cn) ? "领涨的是防御方向——资金在防守，是<b>估值收缩月</b>而非扩张月" : "领涨的是进攻方向——<b>风险偏好扩张</b>，主题与成长更容易走出趋势"}；`
        + `板块首尾差 ${pct((secs[0].d20 || 0) - (secs[secs.length - 1].d20 || 0))}，${Math.abs((secs[0].d20 || 0) - (secs[secs.length - 1].d20 || 0)) > 10 ? "<b>分化极大，选股 > 择时</b>" : "分化温和，指数化配置也够用"}。`
      : "",
  ];
  const mBeatTop = beats.filter((x) => x.chg != null).sort((a, c) => Math.abs(c.chg) - Math.abs(a.chg)).slice(0, 5);
  const c3 = [
    `财报与个股：月内业绩超预期 <b>${beats.length}</b> 条（盘前 ${beats.filter((x) => x.sess === "pre").length} / 盘后 ${beats.filter((x) => x.sess === "post").length}），创新高 <b>${uniqH.size}</b> 只，异动留档 ${sessions.length} 场。`,
    beats.length
      ? (mBeatTop.length ? `代表：${mBeatTop.map((x) => `${x.sym} ${pct(x.chg)}`).join("、")}——` : "")
        + `<b>月内的超额主要来自“业绩 + 指引”双超</b>，单季 beat 但指引平淡的，涨幅通常一周内回吐。`
      : "月内缺少达到门槛的业绩超预期样本，行情由宏观与主题驱动。",
  ];
  const c4 = [
    `资金与波动：10Y ${CR["UST10Y"] && CR["UST10Y"].value != null ? CR["UST10Y"].value.toFixed(2) + "%" : "—"}、美元指数 ${CR["DXY"] && CR["DXY"].value != null ? CR["DXY"].value.toFixed(2) : "—"}、VIX ${IDX["VIX.GI"] && IDX["VIX.GI"].level != null ? IDX["VIX.GI"].level.toFixed(2) : "—"}。`,
    `${CR["UST10Y"] && CR["UST10Y"].value != null && CR["UST10Y"].value >= 5 ? "利率在 5% 上方——<b>估值扩张空间被压住</b>，行情更可能来自盈利而非 multiple" : "利率压力不大，估值端有腾挪空间"}；`
    + `${IDX["VIX.GI"] && IDX["VIX.GI"].level != null && IDX["VIX.GI"].level > 20 ? "VIX 在 20 上方，波动是常态，仓位要留余地" : IDX["VIX.GI"] && IDX["VIX.GI"].level != null && IDX["VIX.GI"].level > 15 ? "VIX 在 15–20 的中性区间，方向未定，等波动率选方向" : "VIX 低位，趋势环境相对友好"}。`,
  ];

  const nLabel = month.split("-")[1] === "12" ? `${+month.slice(0, 4) + 1} 年 1 月` : `${mm} 年 ${+mon + 1} 月`;
  const o1 = [
    `下月（${nLabel}）主线判断：${secs.length ? `延续 ${secs[0].cn} 的强势，同时观察 ${secs[secs.length - 1].cn} 的超跌修复机会` : "待数据补齐"}。`,
    isFinal
      ? "终稿口径：以本月最后一周的<b>广度与量能</b>为准——广度改善则下月偏进攻，广度恶化则偏防守。"
      : "初稿口径：距月末还有若干交易日，<b>方向可能在最后一周被改写</b>，此处只作准备不作定论。",
  ];
  const o2 = [
    `下月日历：财报季节奏（关注大市值披露窗口）、宏观数据与议息会议。`,
    "不预测具体数据，只提前写好“如果通胀超预期/如果就业转弱”的两套应对，避免临场情绪化。",
  ];
  const o3 = [
    `风险清单：利率（10Y ${CR["UST10Y"] && CR["UST10Y"].value != null ? CR["UST10Y"].value.toFixed(2) + "%" : "—"}）、波动率（VIX ${IDX["VIX.GI"] && IDX["VIX.GI"].level != null ? IDX["VIX.GI"].level.toFixed(2) : "—"}）、以及本月最强板块的拥挤度。`,
    "纪律：<b>月初定框架、月中只做验证</b>；框架被数据推翻就改框架，不硬扛观点。",
  ];

  return { stance, stanceNote: note, conclusions: [c1, c2, c3, c4], outlook: [o1, o2, o3], period: isFinal ? `${month}-01~月末` : `${month}-01~${upto}` };
}

/* ---------- 写入与去重 ---------- */
function upsert(entry, { keepManual = true } = {}) {
  const i = LOGS.findIndex((x) => x.kind === entry.kind && x.d === entry.d);
  if (i >= 0) {
    const old = LOGS[i];
    if (keepManual && old.source === "manual") { LOG("  已有会话版本，保留不动：" + entry.kind + " " + entry.d); return false; }
    LOGS[i] = { ...old, ...entry, t: new Date().toISOString() };
  } else LOGS.push(entry);
  return true;
}

const snap = {
  spx: IDX["SPX.GI"] ? IDX["SPX.GI"].chg : null,
  ndx: IDX["IXIC.GI"] ? IDX["IXIC.GI"].chg : null,
  hsi: IDX["HSI.HI"] ? IDX["HSI.HI"].chg : null,
  sh: IDX["000001.SH"] ? IDX["000001.SH"].chg : null,
  vix: IDX["VIX.GI"] ? IDX["VIX.GI"].level : null,
  btc: BQ.price != null ? Math.round(BQ.price) : null,
  us10y: CR["UST10Y"] ? CR["UST10Y"].value : null,
};

let changed = 0;

/* 1) 当日兜底：会话写过（manual）就不动，否则每次用最新数据重算 */
{
  const cur = LOGS.find((x) => x.kind === "daily" && x.d === CLOSE);
  if (!cur || cur.source !== "manual") {
    const d = dailyAuto();
    if (upsert({ d: CLOSE, kind: "daily", source: "auto", ...d, snapshot: snap })) { changed++; LOG("  写当日结论（脚本）：daily " + CLOSE); }
  } else LOG("  当日已有会话定稿：daily " + CLOSE);
}

/* 2) 周报：周六 07:00（北京时间），归档到本周最后一个交易日 */
if (BJ.dow === 6 && BJ.hh <= 10) {
  const cur = LOGS.find((x) => x.kind === "weekly" && x.d === CLOSE);
  if (!cur || cur.source !== "manual") {
    const w = weeklyAuto(CLOSE);
    if (upsert({ d: CLOSE, kind: "weekly", source: "auto", ...w, snapshot: snap })) { changed++; LOG("  生成周报：weekly " + CLOSE + "（" + w.period + "）"); }
  } else LOG("  本周周报已是会话定稿：weekly " + CLOSE);
} else LOG("  非周六上午，跳过周报");

/* 3) 月度初稿：每月 25 日 */
if (BJ.d === 25) {
  const m = `${BJ.y}-${pad(BJ.m)}`;
  const exists = LOGS.some((x) => x.kind === "month-draft" && x.d === CLOSE);
  if (!exists) {
    const r = await monthlyAuto(m, BJ_DATE, false);
    if (upsert({ d: CLOSE, kind: "month-draft", source: "auto", ...r, snapshot: snap })) { changed++; LOG("  生成月度初稿：month-draft " + m); }
  } else LOG("  本月初稿已存在");
} else LOG("  非 25 日，跳过月度初稿");

/* 4) 月度终稿：最新收盘日已进入新月份 → 给上个月出终稿（用“上一个交易日所属月份”判断，不依赖自然日） */
{
  const prevDaily = LOGS.filter((x) => x.kind === "daily" && ymd(x.d) < CLOSE)
    .sort((a, c) => String(c.d).localeCompare(String(a.d)))[0];
  const prevM = prevDaily ? monthOf(prevDaily.d) : null;
  const hasFinal = prevM && LOGS.some((x) => x.kind === "month-final" && (String(x.period || "").startsWith(prevM) || monthOf(x.d) === prevM));
  if (prevM && prevM !== monthOf(CLOSE) && !hasFinal) {
    const r = await monthlyAuto(prevM, CLOSE, true);
    if (upsert({ d: CLOSE, kind: "month-final", source: "auto", ...r, snapshot: snap })) { changed++; LOG("  生成月度终稿：month-final " + prevM); }
  } else LOG("  月度终稿：" + (prevM ? (hasFinal ? "已有" : "同月，跳过") : "无上一交易日记录，跳过"));
}

/* ---------- 排序 + 滚动清理 ---------- */
const keepAfter = addDays(BJ_DATE, -200);
LOGS = LOGS.filter((x) => ymd(x.d) >= keepAfter || x.kind !== "daily"); /* 日存档留 200 天；周/月长期保留 */
const KIND_ORDER = { weekly: 0, "month-final": 1, "month-draft": 2, daily: 3 };
LOGS.sort((a, c) => String(c.d).localeCompare(String(a.d)) || (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[c.kind] ?? 9));

fs.writeFileSync("brief-log.json", JSON.stringify(LOGS, null, 1), "utf8");
LOG("brief-log.json｜共 " + LOGS.length + " 条（本轮新增/更新 " + changed + "）｜最新收盘 " + CLOSE + "｜日 " +
  LOGS.filter((x) => x.kind === "daily").length + " / 周 " + LOGS.filter((x) => x.kind === "weekly").length +
  " / 月 " + LOGS.filter((x) => String(x.kind).startsWith("month")).length);
