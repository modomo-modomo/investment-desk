/* ==========================================================================
   sync-feed.mjs —— 个股「公司动态」长期档案
   用途：给「标的研究」抽屉底部的滚动信息流供数，内容只增不减（去重累积）

   信源（全部公开、无需 Key）：
     1) Yahoo Finance 个股新闻 RSS（每只 20 条）——覆盖美股 / 港股
     2) 知名播客 RSS（Acquired / Invest Like the Best / All-In / Lex Fridman /
        Odd Lots / 硅谷 101）——按公司关键词匹配标题与摘要
     3) 公告 / 券商研报：来自页面内手写档案（不在此脚本内），渲染时并入同一条流
     4) X / KOL：X 无公开免费接口，走 kol-log.json 人工/半自动录入，
        由本脚本原样并入（source=x），保证「长期滚动」与页面一致

   产物：live-feed.js  →  window.FEED_DATA = { meta, items }
   归档：feed-log.json（累积库，勿删；这是「长期积累」的实体）
   ========================================================================== */
import fs from "node:fs";

const OUT_JS = "live-feed.js";
const LOG = "feed-log.json";
const KOL = "kol-log.json";
const MAX_PER_SYM = 160;
const NEW_DAYS = 7;          /* 首次见到后 7 天内标红「新」 */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36";

console.log("读取现有档案…");
const prev = fs.existsSync(LOG) ? JSON.parse(fs.readFileSync(LOG, "utf8")) : { meta: {}, items: {} };
const kolLog = fs.existsSync(KOL) ? JSON.parse(fs.readFileSync(KOL, "utf8")) : { items: {} };
prev.items = prev.items || {};

/* ---------- 标的清单：与 sync-core.mjs 保持一致 ---------- */
const SRC = fs.readFileSync("sync-core.mjs", "utf8");
const block = SRC.slice(SRC.indexOf("const STOCKS = ["), SRC.indexOf("];", SRC.indexOf("const STOCKS = [")));
const STOCKS = [...block.matchAll(/\["([^"]+)",\s*"([^"]+)",\s*"([^"]+)"/g)].map((m) => ({ code: m[1], sym: m[2], name: m[3] }));

/* 播客匹配关键词：太泛的词（AI、chip）不用，避免噪音 */
const KW = {
  META: ["Meta", "Facebook", "Zuckerberg", "Instagram"],
  TSLA: ["Tesla", "Elon Musk", "Optimus", "Robotaxi"],
  AMD: ["AMD", "Lisa Su", "MI450", "Instinct"],
  TSM: ["TSMC", "Taiwan Semiconductor"],
  TER: ["Teradyne"], ONTO: ["Onto Innovation"], NET: ["Cloudflare"],
  RBRK: ["Rubrik"], OKTA: ["Okta"], CHKP: ["Check Point"],
  CRWV: ["CoreWeave"], NBIS: ["Nebius"], IREN: ["IREN", "Iris Energy"], BE: ["Bloom Energy"],
  SPCX: ["SpaceX", "Starship", "Starlink"],
  LLY: ["Eli Lilly", "Zepbound", "Mounjaro", "tirzepatide"],
  CMPS: ["Compass Pathways", "psilocybin"],
  MRNA: ["Moderna"], TWST: ["Twist Bioscience"], ABCL: ["AbCellera"],
  HOOD: ["Robinhood"], SOFI: ["SoFi"], LITE: ["Lumentum"], AEHR: ["Aehr"], FROG: ["JFrog"],
  "2105.HK": ["Laekna", "LAE102", "来凯"], "2359.HK": ["WuXi", "药明康德"], "0700.HK": ["Tencent", "腾讯"],
  "688825.SH": ["CXMT", "长鑫"], "002156.SZ": ["通富微电", "Tongfu"],
  "002436.SZ": ["兴森", "Fastprint"], "300604.SZ": ["长川", "Changchuan"], "688702.SH": ["盛科", "Centec"]
};

const FEEDS = [
  ["播客 · 并购风云（Acquired）", "https://feeds.transistor.fm/acquired"],
  ["播客 · 像最优秀的投资者那样思考（Invest Like the Best）", "https://feeds.megaphone.fm/investlikethebest"],
  ["播客 · All-In 四人谈", "https://allinchamathjason.libsyn.com/rss"],
  ["播客 · 莱克斯·弗里德曼（Lex Fridman）", "https://lexfridman.com/feed/podcast/"],
  ["播客 · 奇闻异事（Odd Lots）", "https://omny.fm/shows/odd-lots/playlists/podcast.rss"],
  ["播客 · 硅谷 101", "https://feeds.fireside.fm/sv101/rss"]
];

const now = Date.now();
const today = new Date(now).toISOString().slice(0, 10);
const strip = (s) =>
  String(s || "")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
const d10 = (s) => {
  const t = Date.parse(s);
  return isNaN(t) ? today : new Date(t).toISOString().slice(0, 10);
};
const idOf = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
};

async function get(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/rss+xml,application/xml,text/xml,*/*" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.text();
}

function parseRss(xml) {
  const out = [];
  const blocks = xml.split(/<item[\s>]/).slice(1);
  for (const b of blocks) {
    const t = strip((b.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
    const l = strip((b.match(/<link>([\s\S]*?)<\/link>/) || [])[1]) || strip((b.match(/<guid[^>]*>([\s\S]*?)<\/guid>/) || [])[1]);
    const p = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || b.match(/<pubdate>([\s\S]*?)<\/pubdate>/) || [])[1];
    const d = strip((b.match(/<description>([\s\S]*?)<\/description>/) || [])[1]).slice(0, 600);
    if (t) out.push({ title: t, url: l, date: d10(p), desc: d });
  }
  return out;
}

/* ---------- 1. Yahoo 个股新闻 ---------- */
console.log(`抓取 Yahoo 个股新闻（${STOCKS.length} 只）…`);
let newsN = 0;
for (const s of STOCKS) {
  try {
    const xml = await get(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(s.sym)}&region=US&lang=en-US`);
    const items = parseRss(xml).slice(0, 12);
    prev.items[s.code] = prev.items[s.code] || [];
    for (const it of items) {
      const id = idOf("yh:" + it.title);
      if (prev.items[s.code].some((x) => x.id === id)) continue;
      prev.items[s.code].push({ id, d: it.date, type: "news", src: "雅虎财经", title: it.title, url: it.url, first: today });
      newsN++;
    }
  } catch (e) {
    console.warn(`  跳过 ${s.code}: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 120));
}

/* ---------- 2. 播客 ---------- */
console.log("抓取知名播客…");
let podN = 0;
for (const [label, url] of FEEDS) {
  try {
    const items = parseRss(await get(url)).slice(0, 120);
    for (const s of STOCKS) {
      const kws = KW[s.code] || [];
      if (!kws.length) continue;
      for (const it of items) {
        if (it.date < "2024-01-01") continue;                       /* 播客档案只留近两年，避免 2021 年老集占位 */
        const inTitle = kws.some((k) => it.title.toLowerCase().includes(k.toLowerCase()));
        const inDesc = it.date >= "2025-01-01" && kws.some((k) => it.desc.toLowerCase().includes(k.toLowerCase()));
        if (!inTitle && !inDesc) continue;
        const id = idOf("pod:" + it.url + it.title);
        prev.items[s.code] = prev.items[s.code] || [];
        if (prev.items[s.code].some((x) => x.id === id)) continue;
        prev.items[s.code].push({ id, d: it.date, type: "pod", src: label, title: it.title, url: it.url, first: today, strong: inTitle });
        podN++;
      }
    }
    console.log(`  ${label}：${items.length} 集`);
  } catch (e) {
    console.warn(`  ${label} 失败：${e.message}`);
  }
}

/* ---------- 3. X / KOL（人工或半自动录入，原样并入） ---------- */
let xn = 0;
for (const [code, arr] of Object.entries(kolLog.items || {})) {
  prev.items[code] = prev.items[code] || [];
  for (const k of arr) {
    const id = idOf("x:" + (k.url || k.handle + k.d + k.view));
    if (prev.items[code].some((x) => x.id === id)) continue;
    prev.items[code].push({ id, d: k.d, type: "x", src: "X · " + (k.handle || ""), title: k.title || "", text: k.view || "", url: k.url || "", key: !!k.key, first: today });
    xn++;
  }
}

/* ---------- 3.5 英译中：标题逐条翻译，结果缓存在 zh 字段（同一条只翻一次） ---------- */
const HAS_CJK = /[\u4e00-\u9fa5]/;
async function zhText(text){
  const u = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=" +
    encodeURIComponent(String(text).slice(0, 900));
  const r = await fetch(u, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  return ((j && j[0]) || []).map((x) => x[0]).join("").trim();
}
console.log("翻译英文标题…");
let trN = 0, trFail = 0;
for (const code of Object.keys(prev.items)) {
  for (const it of prev.items[code]) {
    const raw = it.title || "";
    if (!raw || it.zh || HAS_CJK.test(raw)) continue;
    try { const z = await zhText(raw); if (z) { it.zh = z; trN++; } }
    catch (e) { trFail++; }
    await new Promise((r) => setTimeout(r, 110));
  }
}
console.log(`  新翻译 ${trN} 条` + (trFail ? ` · 失败 ${trFail}` : ""));

/* 赛道资讯（track-news.js）里的英文标题也要中文化：译文按标题存进 tr 映射，
   页面渲染时按标题查表，避免同一句被翻两次。 */
prev.tr = prev.tr || {};
if (fs.existsSync("track-news.js")) {
  try {
    const tj = JSON.parse(fs.readFileSync("track-news.js", "utf8").replace(/^window\.TRACK_NEWS\s*=\s*/, "").replace(/;\s*$/, ""));
    const need = (tj.items || []).filter((x) => x.title && !HAS_CJK.test(x.title) && !prev.tr[x.title]).slice(0, 220);
    console.log(`赛道资讯英译中（${need.length} 条）…`);
    let ok = 0;
    for (const it of need) {
      try { const z = await zhText(it.title); if (z) { prev.tr[it.title] = z; ok++; } } catch (e) {}
      await new Promise((r) => setTimeout(r, 110));
    }
    console.log(`  赛道资讯翻译 ${ok} 条`);
  } catch (e) { console.warn("  赛道资讯翻译跳过：" + e.message); }
}

/* ---------- 4. 归档：标红窗口 + 截断 ---------- */
const nd = NEW_DAYS * 864e5;
let total = 0;
for (const code of Object.keys(prev.items)) {
  let arr = prev.items[code];
  arr.forEach((x) => {
    x.new = (Date.parse(today) - Date.parse(x.first || x.d)) < nd;
  });
  arr.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0));
  prev.items[code] = arr.slice(0, MAX_PER_SYM);
  total += prev.items[code].length;
}
prev.meta = { updated: today, generated: new Date(now).toISOString(), newWindowDays: NEW_DAYS, symbols: Object.keys(prev.items).length, items: total };

fs.writeFileSync(LOG, JSON.stringify(prev, null, 1));
fs.writeFileSync(OUT_JS, "window.FEED_DATA = " + JSON.stringify(prev) + ";\n");

console.log(`完成 → ${OUT_JS}`);
console.log(`  新增 新闻 ${newsN} · 播客 ${podN} · X ${xn}`);
console.log(`  档案 ${prev.meta.symbols} 只 / ${total} 条（每只上限 ${MAX_PER_SYM}）`);
