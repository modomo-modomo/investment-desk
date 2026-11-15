#!/usr/bin/env node
/**
 * 赛道资讯抓取：多信源、按赛道归集、按天滚动积累
 *
 * 信源（都会记录抓取状态，任一失败不影响其余）：
 *   1) 富途个股资讯   futunn.com/stock/{SYM}-US/news（中文页）内嵌 __INITIAL_STATE__.stock_news
 *                      —— 富途聚合的中文财经媒体（格隆汇/智通/华尔街见闻/腾讯科技…）最全
 *   2) 播客           All-In、Stratechery、Sharp Tech、No Priors、Acquired、硅谷101
 *   3) 财经媒体       CNBC Tech、Seeking Alpha、Yahoo Finance、Reuters（经 Google News）
 *   4) 赛道检索       Google News 按赛道关键词检索近 3 天（覆盖彭博/路透/WSJ/Barron's 等）
 *   5) KOL 观点       Dan Ives / Cathie Wood / Chamfer 等被财经媒体转述的观点
 *   6) X 直连（可选）  仅在配置 X_BEARER_TOKEN 时启用（X 无 token 时对服务器 IP 全部 429/451）
 *
 * 输出：track-news-log.json（滚动留档，21 天 / 600 条）+ track-news.js（window.TRACK_NEWS）
 * 用法：node sync-tracks.mjs [--only=infra,cpu] [--dry]
 */
import { readFileSync, writeFileSync } from "node:fs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const BJ = (d) => new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " ");

const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const ONLY = onlyArg ? onlyArg.split("=")[1].split(",").map((s) => s.trim()) : null;
const DRY = process.argv.includes("--dry");

/* ================= 赛道：关键词 + 检索式 + 代表标的 ================= */
const TRACKS = [
  {
    id: "app", name: "AI 应用",
    kw: [/ai agent/i, /agentic/i, /\bcopilot\b/i, /\bsaas\b/i, /enterprise software/i, /salesforce/i, /servicenow/i,
      /palantir/i, /adobe/i, /workday/i, / \bcrm\b/i, /ai application/i, /软件.*AI|AI.*软件/, /ai应用|智能体|大模型应用|软件股/],
    gn: '("AI agent" OR "agentic AI" OR "enterprise software" OR Salesforce OR ServiceNow OR Palantir) earnings when:5d',
    tickers: ["CRM", "NOW", "PLTR", "RBRK", "MSFT"],
  },
  {
    id: "infra", name: "AI 基础设施 & 数据中心",
    kw: [/data ?cent(er|re)/i, /gpu cloud/i, /neocloud/i, /coreweave/i, /nebius/i, /\biren\b/i, /power purchase/i,
      /\bppa\b/i, /electric grid|grid operator|interconnection/i, /liquid cooling/i, /vertiv/i, /bloom energy/i,
      /hyperscaler capex|capital expenditure/i, /gigawatt/i, /发电|并网|电价|数据中心/, /数据中心|算力|液冷|电力供应|并网|电价|吉瓦|超大规模/],
    gn: '("data center" OR "AI power" OR "gigawatt") (nvidia OR grid OR "power purchase" OR capex) when:5d',
    tickers: ["NVDA", "AVGO", "CRWV", "IREN", "VRT", "GEV", "BE", "NBIS"],
  },
  {
    id: "pkg", name: "先进封测",
    kw: [/cowos/i, /advanced packaging/i, /hbm\d?/i, /soic/i, /panel[- , /先进封装|封装|晶圆|台积电|载板|存储芯片/]level/i, /tsmc|台积电/i, /\bamkor\b|\base\b/i,
      /onto innovation/i, /chip test|test equipment/i, /封装|封测|晶圆/],
    gn: '(CoWoS OR "advanced packaging" OR HBM4 OR SoIC OR TSMC) when:5d',
    tickers: ["TSM", "AMKR", "ONTO", "TER"],
  },
  {
    id: "cpu", name: "CPU",
    kw: [/\barm\b.*(server|chip|architecture)/i, /server cpu/i, /\bx86\b/i, /custom (silicon|asic)/i,
      /\bamd\b/i, /\bintel\b/i, /marvell/i, /\bcpu\b/, /服务器芯片|服务器cpu|国产cpu|指令集|x86|芯片架构/],
    gn: '("server CPU" OR "data center CPU" OR (ARM AND (server OR datacenter)) OR (AMD AND (EPYC OR MI400 OR "data center")) OR "custom silicon") when:5d',
    tickers: ["ARM", "AMD", "INTC", "MRVL"],
  },
  {
    id: "phy", name: "物理 AI / 机器人",
    kw: [/humanoid/i, /\brobot(ics|s)?\b/i, /optimus/i, /figure ai/i, /embodied ai/i, /vision.language.action|\bvla\b/i,
      /actuator|harmonic reducer|减速器|丝杠/i, /人形机器人|具身智能|机器人/, /人形机器人|具身智能|机器人|减速器|灵巧手/],
    gn: '(humanoid OR robotics OR Optimus OR "embodied AI") when:5d',
    tickers: ["TSLA", "NVDA"],
  },
  {
    id: "edge", name: "端侧 AI",
    kw: [/edge ai|on.device ai/i, /ai pc/i, /smart glasses/i, /ai (phone|handset)/i, /wearable/i, /qualcomm/i,
      /mediatek|联发科/i, /端侧|ai 手机|ai手机|ai 眼镜/, /端侧|ai手机|ai眼镜|边缘计算|可穿戴/],
    gn: '("edge AI" OR "AI PC" OR "smart glasses" OR "on-device AI") when:7d',
    tickers: ["QCOM", "AAPL"],
  },
  {
    id: "sec", name: "网安",
    kw: [/cybersecurity|cyber security/i, /crowdstrike/i, /palo alto networks/i, /rubrik/i, /\bokta\b/i,
      /ransomware|zero trust|\bsase\b/i, /网络安全|勒索软件/, /网络安全|勒索|数据泄露|零信任/],
    gn: '(cybersecurity OR CrowdStrike OR "Palo Alto Networks" OR ransomware) when:7d',
    tickers: ["CRWD", "PANW", "ZS", "OKTA"],
  },
  {
    id: "fin", name: "金融科技",
    kw: [/fintech/i, /stablecoin/i, /digital (payment|wallet)/i, /visa|mastercard/i, /\bsofi\b/i, /coinbase/i,
      /\bbnpl\b/i, /crypto (exchange|regulation)/i, /稳定币|支付|加密货币/, /稳定币|支付|数字钱包|加密货币|券商股|消费信贷/],
    gn: '(fintech OR stablecoin OR Coinbase OR SoFi OR "digital payments") when:7d',
    tickers: ["V", "MA", "COIN", "SOFI", "HOOD"],
  },
  {
    id: "bio", name: "生物医药",
    kw: [/glp-1|semaglutide|tirzepatide/i, /obesity drug/i, /biotech/i, /\bfda\b.*(approv|panel)/i,
      /phase (3|iii)|clinical trial/i, /eli lilly|novo nordisk/i, /oncology/i, /生物医药|创新药|减重药/, /创新药|减重药|glp-1|临床试验|获批上市|生物医药/],
    gn: '(GLP-1 OR biotech OR "obesity drug" OR "FDA approval") when:7d',
    tickers: ["LLY", "MRK", "ISRG", "VRTX"],
  },
];
if (ONLY) TRACKS.splice(0, TRACKS.length, ...TRACKS.filter((t) => ONLY.includes(t.id)));

const TICKER_NAME = {
  CRM: "Salesforce", NOW: "ServiceNow", PLTR: "Palantir", RBRK: "Rubrik", MSFT: "Microsoft",
  CRWV: "CoreWeave", IREN: "IREN", VRT: "Vertiv", GEV: "GE Vernova", BE: "Bloom Energy", NBIS: "Nebius",
  TSM: "TSMC|Taiwan Semiconductor|台积电", AMKR: "Amkor", ONTO: "Onto Innovation", TER: "Teradyne",
  ARM: "Arm Holdings|\\bARM\\b", AMD: "Advanced Micro|\\bAMD\\b", INTC: "Intel", MRVL: "Marvell",
  TSLA: "Tesla", NVDA: "Nvidia",
  QCOM: "Qualcomm", AAPL: "Apple",
  CRWD: "CrowdStrike", PANW: "Palo Alto", ZS: "Zscaler", OKTA: "Okta",
  V: "Visa", MA: "Mastercard", COIN: "Coinbase", SOFI: "SoFi", HOOD: "Robinhood",
  LLY: "Eli Lilly|Lilly", MRK: "Merck", ISRG: "Intuitive Surgical", VRTX: "Vertex",
};

/* 公司中文名：富途中文页标题用中文写，必须一并匹配 */
const TICKER_ZH = {
  CRM: "赛富时", NOW: "ServiceNow", PLTR: "Palantir", RBRK: "Rubrik", MSFT: "微软",
  CRWV: "CoreWeave", IREN: "IREN", VRT: "维谛|Vertiv", GEV: "GE Vernova|通用电气", BE: "Bloom Energy|布鲁姆",
  NBIS: "Nebius", TSM: "台积电", AMKR: "安靠", ONTO: "Onto", TER: "泰瑞达",
  ARM: "安谋|Arm", AMD: "超威|AMD", INTC: "英特尔", MRVL: "美满|Marvell",
  TSLA: "特斯拉", NVDA: "英伟达", QCOM: "高通", AAPL: "苹果",
  CRWD: "CrowdStrike|众击", PANW: "派拓|Palo Alto", ZS: "Zscaler", OKTA: "Okta",
  V: "维萨|Visa", MA: "万事达", COIN: "Coinbase", SOFI: "SoFi", HOOD: "罗宾汉",
  LLY: "礼来", MRK: "默沙东", ISRG: "直觉外科", VRTX: "福泰",
};

/* ================= 播客 / 媒体 信源 ================= */
const POD_FEEDS = [
  { src: "All-In", url: "https://allinchamathjason.libsyn.com/rss" },
  { src: "Stratechery", url: "https://stratechery.com/feed/" },
  { src: "Sharp Tech", url: "https://sharptech.fm/feed/podcast" },
  { src: "No Priors", url: "https://feeds.megaphone.fm/nopriors" },
  { src: "Acquired", url: "https://www.acquired.fm/episodes?format=rss" },
  { src: "硅谷101", url: "https://feeds.fireside.fm/sv101/rss" },
];
const MEDIA_FEEDS = [
  { src: "CNBC 科技", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=19854910" },
  { src: "Seeking Alpha", url: "https://seekingalpha.com/market_currents.xml" },
  { src: "Reuters", url: "https://news.google.com/rss/search?q=site:reuters.com+(AI+OR+chips+OR+Nvidia+OR+semiconductor)+when:2d&hl=en-US&gl=US&ceid=US:en" },
];
const KOL_NAMES = ["Dan Ives", "Cathie Wood", "Brad Gerstner", "Chamath Palihapitiya", "Gavin Baker",
  "Dylan Patel", "Gene Munster", "Jason Calacanis", "Bill Gurley"];
const KOL_QUERY = '(' + KOL_NAMES.map((n) => '"' + n + '"').join(" OR ") + ') (AI OR Nvidia OR chips OR datacenter OR Tesla OR biotech) when:3d';

/* ================= 工具 ================= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, tries = 2) {
  let last;
  for (let i = 0; i < tries; i++) {
    const c = new AbortController();
    const to = setTimeout(() => c.abort(), 30000);
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" }, signal: c.signal, redirect: "follow" });
      if (!r.ok && r.status >= 500) throw new Error("HTTP " + r.status);
      return { ok: r.ok, status: r.status, text: await r.text() };
    } catch (e) {
      last = e;
      await sleep(600 + i * 900);
    } finally {
      clearTimeout(to);
    }
  }
  throw last;
}
const decode = (s) => String(s || "")
  .replace(/<!\[CDATA\[|\]\]>/g, "")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, " ")
  .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const tagOf = (s, k) => {
  const m = String(s).match(new RegExp("<" + k + "[^>]*>([\\s\\S]*?)</" + k + ">", "i"));
  return m ? decode(m[1]) : "";
};
const normTitle = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "").slice(0, 80);

const TICKER_TRACK = {};
for (const t of TRACKS) for (const s of t.tickers) (TICKER_TRACK[s] = TICKER_TRACK[s] || []).push(t.id);
function mentionTicker(title, sym) {
  const pat = [TICKER_NAME[sym], TICKER_ZH[sym]].filter(Boolean).join("|");
  if (!pat) return false;
  try { return new RegExp(pat, "i").test(title); } catch { return false; }
}
/** 判定赛道：关键词命中数最多的赛道；无关键词命中时退回「代表标的名称」（via=ticker，记 0.5 分） */
function trackWords(text) {
  const hit = [];
  for (const t of TRACKS) {
    let n = 0;
    for (const re of t.kw) if (re.test(text)) n++;
    if (n) hit.push([t.id, n, "kw"]);
  }
  if (hit.length) { hit.sort((a, b) => b[1] - a[1]); return { id: hit[0][0], n: hit[0][1], via: "kw" }; }
  for (const sym of Object.keys(TICKER_NAME)) {
    if (mentionTicker(text, sym)) {
      const id = (TICKER_TRACK[sym] || [])[0];
      if (id) return { id, n: 0.5, via: "ticker" };
    }
  }
  return null;
}

/* 高质量信源白名单：非白名单来源需 ≥2 个关键词命中，否则视为长尾噪音丢弃 */
const PREFERRED = /bloomberg|reuters|wall street journal|wsj|barron|cnbc|financial times|ft\.com|yahoo finance|seeking alpha|marketwatch|the information|nikkei|business insider|fortune|forbes|benzinga|investopedia|the verge|techcrunch|ars technica|semianalysis|stratechery|彭博|路透|华尔街日报|财新|财联社|格隆汇|智通财经|华尔街见闻|东方财富|第一财经|富途/i;
const isPreferred = (src) => PREFERRED.test(String(src || ""));

const raw = [];   /* {t, track, kind, src, title, url, snip} */
const status = {};
const addRaw = (o) => { if (o.title && o.title.length > 8) raw.push(o); };

/* ================= 1) 富途个股资讯 ================= */
async function fetchFutu() {
  const syms = [];
  for (const t of TRACKS) for (const s of t.tickers) if (!syms.includes(s)) syms.push(s);
  let ok = 0, fail = 0, n = 0;
  for (const sym of syms) {
    let txt;
    try {
      const r = await get("https://www.futunn.com/stock/" + sym + "-US/news", 1);
      if (!r.ok) throw new Error("HTTP " + r.status);
      txt = r.text;
    } catch { fail++; continue; }
    const i = txt.indexOf("__INITIAL_STATE__=");
    if (i < 0) { fail++; continue; }
    const start = i + "__INITIAL_STATE__=".length;
    let d = 0, end = start;
    for (let p = start; p < txt.length; p++) {
      const c = txt[p];
      if (c === "{") d++;
      else if (c === "}") { d--; if (!d) { end = p + 1; break; } }
    }
    let list = [];
    try { list = (JSON.parse(txt.slice(start, end)).stock_news || {}).list || []; } catch { fail++; continue; }
    ok++;
    for (const it of list) {
      const title = decode(it.title);
      if (!title) continue;
      const ts = Number(it.time) * 1000;
      if (!ts || Date.now() - ts > 6 * 864e5) continue;
      const m = trackWords(title + " " + decode(it.abstract));
      let trk = m && m.id;
      if (!trk && mentionTicker(title, sym)) trk = (TICKER_TRACK[sym] || [])[0];
      if (!trk) continue;
      /* 富途页本身按标的聚合，但混有宏观快讯：标题既不提该标的、关键词也只命中 1 个的丢掉 */
      if (m && m.via === "ticker" && !mentionTicker(title, sym)) continue;
      n++;
      addRaw({
        t: BJ(new Date(ts)), track: trk, kind: "futu",
        src: "富途·" + (decode(it.source) || "资讯"),
        title, url: it.url || "", snip: decode(it.abstract).slice(0, 160),
      });
    }
    await sleep(120);
  }
  status.futu = { ok, fail, n, label: "富途个股资讯" };
  console.log("富途：" + ok + "/" + (ok + fail) + " 只抓到，入池 " + n + " 条");
}

/* ================= 2) 播客 ================= */
async function fetchPods() {
  let ok = 0, n = 0;
  for (const f of POD_FEEDS) {
    let txt;
    try { const r = await get(f.url, 1); if (!r.ok) throw 0; txt = r.text; } catch { continue; }
    const items = txt.split(/<item[\s>]/).slice(1);
    if (!items.length) continue;
    ok++;
    for (const it of items.slice(0, 60)) {
      const title = tagOf(it, "title");
      if (!title) continue;
      const pd = Date.parse(tagOf(it, "pubDate") || it.match(/<published>([^<]+)</)?.[1] || "");
      if (!pd || Date.now() - pd > 30 * 864e5) continue;
      const desc = tagOf(it, "description") || tagOf(it, "content:encoded") || "";
      const m = trackWords(title + " " + desc.slice(0, 600));
      if (!m) continue;
      const trk = m.id;
      n++;
      addRaw({
        t: BJ(new Date(pd)), track: trk, kind: "pod", src: f.src,
        title, url: tagOf(it, "link") || "", snip: desc.slice(0, 170),
      });
    }
    await sleep(150);
  }
  status.pod = { ok, fail: POD_FEEDS.length - ok, n, label: "播客" };
  console.log("播客：" + ok + "/" + POD_FEEDS.length + " 源可用，入池 " + n + " 条");
}

/* ================= 3) 财经媒体 + 4) 赛道检索 + 5) KOL ================= */
async function fetchRss(src, kind, url, days = 7) {
  let txt;
  try { const r = await get(url, 1); if (!r.ok) throw 0; txt = r.text; } catch { return 0; }
  const items = txt.split(/<item[\s>]/).slice(1);
  let n = 0;
  for (const it of items.slice(0, 80)) {
    const title = tagOf(it, "title");
    if (!title) continue;
    const pd = Date.parse(tagOf(it, "pubDate") || "");
    if (!pd || Date.now() - pd > days * 864e5) continue;
    const desc = tagOf(it, "description");
    const m = trackWords(title + " " + desc.slice(0, 400));
    if (!m) continue;
    if (!isPreferred(src) && m.n < 2) continue;
    n++;
    addRaw({ t: BJ(new Date(pd)), track: m.id, kind, src, title, url: tagOf(it, "link"), snip: desc.slice(0, 170) });
  }
  return n;
}

async function fetchMedia() {
  let n = 0, ok = 0;
  for (const f of MEDIA_FEEDS) {
    const c = await fetchRss(f.src, "media", f.url, 5);
    if (c) ok++;
    n += c;
  }
  status.media = { ok, fail: MEDIA_FEEDS.length - ok, n, label: "财经媒体" };
  console.log("财经媒体：入池 " + n + " 条（" + ok + "/" + MEDIA_FEEDS.length + " 源可用）");
}

async function fetchTrackSearch() {
  let n = 0, ok = 0;
  for (const t of TRACKS) {
    const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(t.gn) + "&hl=en-US&gl=US&ceid=US:en";
    let txt;
    try { const r = await get(url, 1); if (!r.ok) throw 0; txt = r.text; } catch { continue; }
    const items = txt.split(/<item[\s>]/).slice(1);
    if (!items.length) continue;
    ok++;
    for (const it of items.slice(0, 25)) {
      const title = tagOf(it, "title");
      const pd = Date.parse(tagOf(it, "pubDate") || "");
      if (!title || !pd || Date.now() - pd > 7 * 864e5) continue;
      const srcName = (tagOf(it, "source") || "Google News").slice(0, 24);
      const m = trackWords(title);
      if (!isPreferred(srcName) && (!m || m.n < 2)) continue;   /* 长尾小站只放行强相关 */
      n++;
      addRaw({
        t: BJ(new Date(pd)), track: t.id, kind: "media", src: srcName,
        title: title.replace(/\s+-\s+[^-]{2,30}$/, ""), url: tagOf(it, "link"), snip: "",
      });
    }
    await sleep(200);
  }
  status.search = { ok, fail: TRACKS.length - ok, n, label: "赛道检索" };
  console.log("赛道检索：入池 " + n + " 条（" + ok + "/" + TRACKS.length + " 个赛道可用）");
}

async function fetchKol() {
  const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(KOL_QUERY) + "&hl=en-US&gl=US&ceid=US:en";
  let txt;
  try { const r = await get(url, 1); if (!r.ok) throw 0; txt = r.text; } catch {
    status.kol = { ok: 0, fail: 1, n: 0, label: "KOL 观点" };
    return;
  }
  const items = txt.split(/<item[\s>]/).slice(1);
  let n = 0;
  for (const it of items.slice(0, 60)) {
    const title = tagOf(it, "title");
    const pd = Date.parse(tagOf(it, "pubDate") || "");
    if (!title || !pd || Date.now() - pd > 5 * 864e5) continue;
    const who = KOL_NAMES.find((k) => title.toLowerCase().includes(k.toLowerCase()));
    if (!who) continue;
    const m = trackWords(title);
    if (!m) continue;
    n++;
    addRaw({
      t: BJ(new Date(pd)), track: m.id, kind: "kol", src: who + "（媒体转述）",
      title: title.replace(/\s+-\s+[^-]{2,30}$/, ""), url: tagOf(it, "link"), snip: "",
    });
  }
  status.kol = { ok: n ? 1 : 0, fail: 0, n, label: "KOL 观点" };
  console.log("KOL 观点：入池 " + n + " 条");
}

/** X 直连：仅在配置 X_BEARER_TOKEN 时启用（无 token 时 X 对服务器 IP 一律 429/451/人机验证） */
async function fetchX() {
  const tk = process.env.X_BEARER_TOKEN;
  status.x = { ok: 0, fail: 0, n: 0, label: "X 直连" };
  if (!tk) { status.x.note = "未配置 X_BEARER_TOKEN，已跳过"; return; }
  const accts = ["EMostaque", "dylan522p", "GavinSBaker", "chamath", "Jason", "BradGerstner", "DanIves"];
  const q = "(" + accts.map((a) => "from:" + a).join(" OR ") + ") -is:retweet";
  try {
    const r = await fetch("https://api.x.com/2/tweets/search/recent?max_results=50&tweet.fields=created_at&query=" + encodeURIComponent(q), {
      headers: { Authorization: "Bearer " + tk },
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    let n = 0;
    for (const tw of j.data || []) {
      const m = trackWords(tw.text || "");
      if (!m) continue;
      n++;
      addRaw({
        t: BJ(new Date(tw.created_at)), track: m.id, kind: "x", src: "X · @" + (tw.author_id || ""),
        title: (tw.text || "").slice(0, 120).replace(/\s+/g, " "), url: "https://x.com/i/status/" + tw.id, snip: "",
      });
    }
    status.x = { ok: 1, fail: 0, n, label: "X 直连" };
  } catch (e) {
    status.x = { ok: 0, fail: 1, n: 0, label: "X 直连", note: e.message };
  }
}

/* ================= 主流程 ================= */
await fetchFutu();
await fetchPods();
await fetchMedia();
await fetchTrackSearch();
await fetchKol();
await fetchX();

/* ---- 配额：每个「信源 × 赛道」只留最新 N 条，避免单源刷屏 ---- */
const CAP = { futu: 6, pod: 4, media: 6, kol: 4, x: 6 };
const bucket = new Map();
for (const x of raw) {
  const k = x.kind + "|" + x.track;
  if (!bucket.has(k)) bucket.set(k, []);
  bucket.get(k).push(x);
}
const capped = [];
for (const arr of bucket.values()) {
  arr.sort((a, b) => b.t.localeCompare(a.t));
  capped.push(...arr.slice(0, CAP[arr[0].kind] || 6));
}
console.log("配额后入池 " + capped.length + " 条（配额前 " + raw.length + "）");

/* ---- 去重 + 滚动留档 ---- */
let log = [];
try { log = JSON.parse(readFileSync("track-news-log.json", "utf8")); } catch { }
if (!Array.isArray(log)) log = [];
const seen = new Set(log.map((x) => normTitle(x.title)));
const fresh = [];
capped.sort((a, b) => b.t.localeCompare(a.t));
for (const x of capped) {
  const k = normTitle(x.title);
  if (!k || seen.has(k)) continue;
  seen.add(k);
  fresh.push({
    t: x.t, d: x.t.slice(0, 10), track: x.track, kind: x.kind, src: x.src,
    title: x.title.slice(0, 180), url: x.url || "", snip: (x.snip || "").slice(0, 200), isNew: true,
  });
}
const merged = fresh.concat(log.map((x) => ({ ...x, isNew: false })));
const cutoff = BJ(new Date(Date.now() - 21 * 864e5)).slice(0, 10);
const keep = merged.filter((x) => (x.d || "") >= cutoff)
  .sort((a, b) => String(b.t).localeCompare(String(a.t)))
  .slice(0, 600);
if (!DRY) writeFileSync("track-news-log.json", JSON.stringify(keep, null, 1), "utf8");

const byKind = {};
for (const x of keep) byKind[x.kind] = (byKind[x.kind] || 0) + 1;
const byTrack = {};
for (const x of keep) byTrack[x.track] = (byTrack[x.track] || 0) + 1;
console.log("---\n本轮新增 " + fresh.length + " 条，留档 " + keep.length + " 条（21 天窗口）");
console.log("按信源：" + JSON.stringify(byKind));
console.log("按赛道：" + JSON.stringify(byTrack));

if (!DRY) {
  writeFileSync("track-news.js", "window.TRACK_NEWS = " + JSON.stringify({
    meta: {
      syncedAt: new Date().toISOString(),
      total: keep.length,
      fresh: fresh.length,
      window: 21,
      sources: status,
      byKind,
      byTrack,
      note: "富途个股资讯（聚合中文财经媒体）+ 播客（All-In/Stratechery/Sharp Tech/No Priors/Acquired/硅谷101）+ 财经媒体（CNBC/Seeking Alpha/Reuters）+ 赛道关键词检索 + KOL 观点（媒体转述）",
    },
    items: keep,
  }, null, 1) + ";\n", "utf8");
  console.log("已写入 track-news.js / track-news-log.json");
}
