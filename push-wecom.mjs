#!/usr/bin/env node
/* 企业微信群机器人推送：把 live-data.js / live-extra.js / live-news.js 的当前快照
 * 压成一条手机可读的 markdown 摘要并推送。
 *
 * 用法：
 *   node push-wecom.mjs --webhook "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx" --dry
 *   node push-wecom.mjs --webhook "..." --site "https://xxx"        // 正式推送
 *   node push-wecom.mjs --webhook "..." --test                      // 只发一条连通性测试
 *
 * 环境变量等价：WECOM_WEBHOOK / DESK_SITE_URL
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const getArg = (k, d) => {
  const i = argv.indexOf("--" + k);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
};
const has = (k) => argv.includes("--" + k);

const WEBHOOK = getArg("webhook", process.env.WECOM_WEBHOOK || "");
const SITE = getArg("site", process.env.DESK_SITE_URL || "");
const DRY = has("dry");
const TEST = has("test");

const COVER = ["TSLA", "META", "IREN", "NBIS", "CRWV", "BE", "AMD", "TSM", "TER", "ONTO", "NET", "RBRK", "OKTA", "CHKP"];

function loadJS(file) {
  const p = path.join(DIR, file);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, "utf8");
  const body = raw.replace(/^\s*window\.[A-Za-z0-9_]+\s*=\s*/, "").replace(/;\s*$/, "");
  try {
    return JSON.parse(body);
  } catch (e) {
    console.error("  [跳过] " + file + " 解析失败：" + e.message);
    return null;
  }
}

const num = (v, d = 2) => (v == null || Number.isNaN(v) ? "—" : Number(v).toFixed(d));
const pct = (v, d = 2) => (v == null || Number.isNaN(v) ? "—" : (v >= 0 ? "+" : "") + Number(v).toFixed(d) + "%");
/* 红涨绿跌：企业微信没有红色，涨用 warning（橙红），跌用 info（绿） */
const tint = (v, d = 2) => {
  if (v == null || Number.isNaN(v)) return "—";
  return `<font color="${v >= 0 ? "warning" : "info"}">${pct(v, d)}</font>`;
};
const strong = (s) => "**" + s + "**";

const WIND = loadJS("live-data.js");
const EXTRA = loadJS("live-extra.js");
const NEWS = loadJS("live-news.js");

if (!WIND && !EXTRA) {
  console.error("live-data.js 与 live-extra.js 都不存在或不可读，先跑 sync 脚本。");
  process.exit(1);
}

const beijing = () => {
  const t = new Date(Date.now() + 8 * 3600e3);
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
};

function build() {
  const L = [];
  const preDate = EXTRA?.meta?.preDate || "";
  const postDate = EXTRA?.meta?.postDate || "";
  const idxDate = WIND?.meta?.indexDate || "";
  const isoIdx = idxDate && idxDate.length === 8 ? `${idxDate.slice(0, 4)}-${idxDate.slice(4, 6)}-${idxDate.slice(6)}` : idxDate;

  L.push(`# 投资工作台 · ${beijing()}`);

  const cc = EXTRA?.crosscheck?.rows || [];
  const okN = cc.filter((r) => r.ok).length;
  const srcLine = [
    WIND ? "Wind 已接入" : "Wind 缺失",
    EXTRA ? `Yahoo+Nasy 已接入` : "Yahoo 缺失",
    cc.length ? `双源校验 ${okN}/${cc.length}` : "",
  ].filter(Boolean).join(" · ");
  L.push(`> ${srcLine}`);

  /* ① 市场色彩 */
  const I = WIND?.indices || {};
  const g = (k) => I[k];
  if (g("SPX.GI") || g("IXIC.GI")) {
    L.push(`**① 市场色彩（${isoIdx} 收盘）**`);
    const row1 = [["SPX.GI", "标普"], ["IXIC.GI", "纳指"], ["DJI.GI", "道指"]]
      .map(([k, n]) => (g(k) ? `${n} ${num(g(k).level)} ${tint(g(k).chg)}` : null)).filter(Boolean);
    if (row1.length) L.push(row1.join(" · "));
    const row2 = [];
    if (g("SOX.GI")) row2.push(`费半 ${num(g("SOX.GI").level)} ${tint(g("SOX.GI").chg)}`);
    if (g("VIX.GI")) row2.push(`VIX ${num(g("VIX.GI").level)} ${tint(g("VIX.GI").chg)}`);
    if (row2.length) L.push(row2.join(" · "));
    if (EXTRA?.spxVol?.ratio) {
      const r = EXTRA.spxVol.ratio;
      L.push(`量能 ${num(r)}× 20日均值 ${r >= 1 ? "（放量）" : "（缩量）"}`);
    }
    const asia = [["HSI.HI", "恒指"], ["000001.SH", "上证"], ["N225.GI", "日经"], ["KS11.GI", "韩综"]]
      .map(([k, n]) => (g(k) ? `${n} ${tint(g(k).chg, 2)}` : null)).filter(Boolean);
    if (asia.length) L.push(`亚太（最新收盘）${asia.join(" · ")}`);
  }

  /* ② 跨资产 */
  const C = WIND?.cross || {};
  if (Object.keys(C).length) {
    L.push("");
    L.push("**② 跨资产**");
    const a = [];
    if (C.UST10Y) a.push(`10Y ${num(C.UST10Y.value)}% ${C.UST10Y.dbp1 != null ? (C.UST10Y.dbp1 >= 0 ? "+" : "") + Math.round(C.UST10Y.dbp1) + "bp" : tint(C.UST10Y.d1)}`);
    if (C.DXY) a.push(`DXY ${num(C.DXY.value)} ${tint(C.DXY.d1)}`);
    if (a.length) L.push(a.join(" · "));
    const b = [];
    if (C.GOLD) b.push(`金 ${num(C.GOLD.value, 1)} ${tint(C.GOLD.d1)}`);
    if (C.COPPER) b.push(`铜 ${num(C.COPPER.value, 0)} ${tint(C.COPPER.d1)}`);
    if (C.WTI) b.push(`WTI ${num(C.WTI.value)} ${tint(C.WTI.d1)}`);
    if (b.length) L.push(b.join(" · "));
  }

  /* ③ 风格与分化 */
  if (EXTRA?.breadth) {
    const b = EXTRA.breadth;
    L.push("");
    L.push("**③ 风格与分化**");
    L.push(`等权 RSP 20日 ${tint(b.rsp20)} vs SPY ${tint(b.spy20)}，差 ${num(Math.abs(b.rel20))}pct`);
    L.push(b.rel20 > 0 ? `→ 指数弱、等权强，钱在防御里，不是普涨` : `→ 权重强于等权，集中度还在升`);
  }

  /* ④ 板块 */
  const S = EXTRA?.sectors || {};
  const sarr = Object.entries(S).filter(([, v]) => v && v.chg != null);
  if (sarr.length) {
    sarr.sort((x, y) => y[1].chg - x[1].chg);
    const line = (arr) => arr.map(([, v]) => `${v.cn} ${tint(v.chg)}`).join(" · ");
    L.push("");
    L.push("**④ 板块**");
    L.push(`领涨 ${line(sarr.slice(0, 3))}`);
    L.push(`领跌 ${line(sarr.slice(-3).reverse())}`);
  }

  /* ⑤⑥ 业绩
   * 注意 1：live-extra 里的 surprise 字段单位不统一（有的 0.35 表示 0.35%，有的 18.2 表示 18.2%），
   *         一律用 (actual - est) / |est| 自算，不用原字段。
   * 注意 2：营收只对覆盖池（美股、美元计价）展示，避免 EC 这类 COP/BRL 计价的数字被误读。
   * 注意 3：postChg 在数据里恒为 null，盘后披露的公司改看“次日盘前”preChg。
   */
  const mkEarn = (rows, label, when, mode) => {
    if (!rows || !rows.length) return;
    const scored = rows.map((r) => ({
      r,
      self: r.actual != null && r.est != null && r.est !== 0 ? ((r.actual - r.est) / Math.abs(r.est)) * 100 : null,
    }));
    const picked = scored
      .filter(({ r, self }) => COVER.includes(r.symbol) || (self != null && Math.abs(self) >= (r.threshold || 3)))
      .sort((a, b) => Math.abs(b.self ?? 0) - Math.abs(a.self ?? 0))
      .slice(0, 5);
    if (!picked.length) return;

    L.push("");
    L.push(`**${label}（${when}，共 ${rows.length} 家）**`);
    for (const { r, self } of picked) {
      const bits = [];
      if (self != null) {
        bits.push(`EPS ${num(r.actual)} / 预期 ${num(r.est)}`);
        bits.push(`${self >= 0 ? "超" : "低"} ${Math.abs(self) >= 200 ? "200%+" : Math.abs(self).toFixed(1) + "%"}`);
      } else if (r.est != null) {
        bits.push(`预期 ${num(r.est)}，未出数`);
      }
      const rev = r.fund?.rev;
      if (COVER.includes(r.symbol) && rev >= 1e8 && rev <= 3e11) bits.push(`营收 ${(rev / 1e8).toFixed(1)}亿`);
      const px = r.preChg;
      if (px != null) bits.push(`${mode === "post" ? "次日盘前" : "盘前"} ${tint(px)}`);
      if (mode === "pre" && r.dayChg != null) bits.push(`收盘 ${tint(r.dayChg)}`);
      L.push(`${strong(r.symbol)} ${bits.join(" · ")}`);
      const nw = NEWS?.items?.[r.symbol];
      if (nw?.ok && nw.headline) L.push(`　${String(nw.headline).slice(0, 46)}`);
    }
    if (rows.length > picked.length) L.push(`　另 ${rows.length - picked.length} 家未披露或未达阈值`);
  };
  const E = EXTRA?.earnings;
  if (E) {
    mkEarn(E.post, "⑤ 盘后业绩", postDate, "post");
    mkEarn(E.pre, "⑥ 盘前业绩", preDate, "pre");
  }

  /* ⑦ 覆盖池异动 */
  const Q = EXTRA?.quotes || {};
  const mv = Object.entries(Q)
    .filter(([, q]) => q && Math.abs(q.chg || 0) >= 3)
    .sort((a, b) => Math.abs(b[1].chg) - Math.abs(a[1].chg));
  if (mv.length) {
    L.push("");
    L.push("**⑦ 覆盖池异动（|涨跌|≥3%）**");
    L.push(mv.slice(0, 6).map(([s, q]) => `${s} ${num(q.price)} ${tint(q.chg)}`).join(" · "));
  }

  /* ⑧ 下一财报 */
  const NE = EXTRA?.nextEarn || {};
  const soon = Object.entries(NE)
    .map(([s, d]) => [s, Array.isArray(d) ? d[0] : d])
    .filter(([, d]) => d && d >= new Date().toISOString().slice(0, 10))
    .sort((a, b) => (a[1] < b[1] ? -1 : 1))
    .slice(0, 4);
  if (soon.length) {
    L.push("");
    L.push("**⑧ 接下来披露**");
    L.push(soon.map(([s, d]) => `${s} ${d.slice(5)}`).join(" · "));
  }

  if (SITE) {
    L.push("");
    L.push(`[打开完整工作台](${SITE})`);
  }
  L.push(`_${beijing()} 自动生成 · 数据源 Wind/Yahoo 双源校验_`);

  return L.join("\n");
}

/* 企业微信 markdown 上限 4096 字节，留 80 字节余量 */
function clip(s, max = 4000) {
  if (Buffer.byteLength(s, "utf8") <= max) return s;
  const lines = s.split("\n");
  let out = "";
  for (const ln of lines) {
    if (Buffer.byteLength(out + ln + "\n", "utf8") > max - 160) break;
    out += ln + "\n";
  }
  return out + "\n…内容过长已截断，完整版见工作台页面。";
}

async function send(content) {
  if (!WEBHOOK || WEBHOOK === true) {
    console.error("缺少 --webhook，或设置环境变量 WECOM_WEBHOOK。");
    console.error("企业微信群 → 右上角 … → 群机器人 → 添加 → 复制 Webhook 地址。");
    process.exit(2);
  }
  const body = { msgtype: "markdown", markdown: { content: clip(content) } };
  if (DRY) {
    console.log("---- DRY RUN，不发送 ----");
    console.log(clip(content));
    console.log("---- 字节数：" + Buffer.byteLength(clip(content), "utf8") + " / 4096 ----");
    return;
  }
  const res = await fetch(WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (j.errcode === 0) {
    console.log("✓ 已推送到企业微信（" + Buffer.byteLength(clip(content), "utf8") + " 字节）");
  } else {
    console.error("✗ 推送失败 errcode=" + j.errcode + " errmsg=" + j.errmsg);
    if (j.errcode === 93000) console.error("  → webhook key 无效或机器人已被移除");
    if (j.errcode === 45009) console.error("  → 触发频率限制（每机器人每分钟 20 条）");
    process.exit(3);
  }
}

const content = TEST
  ? `# 投资工作台 · 推送连通测试\n${beijing()}\n\n如果你看到这条，机器人已经通了。`
  : build();
await send(content);
