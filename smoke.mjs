import fs from "node:fs";
const html = fs.readFileSync("index.html", "utf8");
const body = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const rd = (f) => { const s = fs.readFileSync(f, "utf8"); return JSON.parse(s.slice(s.indexOf("=") + 1, s.lastIndexOf(";"))); };
const W = rd("live-data.js"), Y = rd("live-extra.js"), ND = rd("live-news.js");
const FD = fs.existsSync("live-feed.js") ? rd("live-feed.js") : { items: {} };
const TN = fs.existsSync("track-news.js") ? rd("track-news.js") : { items: [] };
const PN = fs.existsSync("pf-nav.js") ? rd("pf-nav.js") : { series: [], bench: {}, trades: [] };
const mkFake = () => {
  const fn = function(){};
  return new Proxy(fn, {
    get: (t, k) => {
      if (k === "classList") return { add(){}, remove(){}, toggle(){}, contains: () => false };
      if (k === "style") return {};
      if (k === "dataset") return {};
      if (k === "children") return [];
      if (k === "appendChild" || k === "addEventListener" || k === "remove") return () => {};
      if (k === "querySelectorAll") return () => [];
      if (k === "length") return 0;
      return mkFake();
    },
    set: () => true,
    apply: () => mkFake(),
  });
};
globalThis.window = { WIND_LIVE: W, YF_DATA: Y, NEWS_DATA: ND, FEED_DATA: FD, TRACK_NEWS: TN, PF_NAV: PN, addEventListener(){}, scrollTo(){} };
globalThis.document = { querySelector: () => mkFake(), querySelectorAll: () => [], getElementById: () => mkFake(), addEventListener(){}, createElement: () => mkFake(), body: mkFake() };
globalThis.localStorage = { getItem: () => null, setItem(){}, removeItem(){} };
globalThis.location = { hash: "", origin: "file://" };
try { Object.defineProperty(globalThis, "navigator", { value: { userAgent: "node" }, configurable: true }); } catch {}

try {
  new Function("window","document","localStorage","location","navigator", body)(window, document, localStorage, location, navigator);
  console.log("脚本加载+启动：OK");
} catch (e) { console.log("启动错误:", e.stack.split("\n").slice(0,4).join("\n")); process.exit(1); }

try {
  const test = new Function("window","document","localStorage","location","navigator", body + `
    const views=["brief","tracks","events","movers","stocks","strategy","portfolio","risk"];
    for(const v of views){ const h=VIEWS[v](); if(!h||h.length<200) throw new Error(v+" 渲染过短"); console.log("view",v,"OK",h.length,"chars"); }
    const pf=pfCalc();
    console.log("模拟组合:", "净值", pf.nav.toFixed(4), "累计", (pf.ret*100).toFixed(2)+"%", "当日", pf.day.toFixed(2)+"pct",
      "· 持仓", pf.rows.map(x=>x.t+" "+(x.ret*100).toFixed(1)+"%").join(" / "));
    const prr=pfRiskRules();
    console.log("组合风险:", prr.rules.map(r=>r.n+"="+r.status+"("+r.read.slice(0,26)+")").join(" | "));
    /* (13) 饼图 / 净值走势 / 调仓记录 */
    const pie=pfPie(pf), ch=pfChart(pf);
    console.log("饼图:", pie.length, "字符 · 扇区", (pie.match(/<path /g)||[]).length, "个 · 含净值中心", /组合净值/.test(pie));
    console.log("走势图:", ch.length, "字符 · 折线", (ch.match(/<path /g)||[]).length, "条 · 区间按钮", (ch.match(/data-prng/g)||[]).length, "· 基准开关", (ch.match(/data-pbench/g)||[]).length,
      "· 默认不叠基准", !(pfChart(pf).match(/stroke-dasharray="5 4"/)));
    console.log("调仓记录:", (window.PF_NAV.trades||[]).length, "条 · 首条:", JSON.stringify((window.PF_NAV.trades||[])[0]||{}).slice(0,90));
    console.log("净值序列:", (window.PF_NAV.series||[]).length, "点 · 末点", JSON.stringify((window.PF_NAV.series||[]).slice(-1)[0]||{}));
    const meta=DATA.stocks.find(z=>z.t==="META");
    const fl=feedList(meta);
    const byType={}; fl.forEach(x=>byType[x.type]=(byType[x.type]||0)+1);
    console.log("公司动态(META):", fl.length, "条", JSON.stringify(byType), "| 首条:", fl[0]&&(fl[0].d+" "+fl[0].type+" "+fl[0].text.slice(0,40)));
    openStock(1); console.log("openStock OK");
    trackSel="fin"; const fin=DATA.tracks.find(x=>x.id==="fin");
    console.log("fin 标的池:", (fin.symsLive||[]).length, "只 · 样例:", JSON.stringify((fin.symsLive||[])[0]));
    console.log("创新高日志:", (DATA.highs&&DATA.highs.log||[]).length, "条 · 当日:", (DATA.highs&&DATA.highs.today||[]).length);
    console.log("客观观测:", (DATA.strategy.observing||[]).length, "条 · 第一条:", (DATA.strategy.observing||[])[0]||"—");
    console.log("非财报异动: 盘前", (DATA.moversPre||[]).length, "· 盘后", (DATA.moversPost||[]).length);
    console.log("川普动态条目:", ((window.NEWS_DATA.trump||{}).items||[]).length);
  `)(window, document, localStorage, location, navigator);
} catch (e) { console.log("视图错误:", e.stack.split("\n").slice(0,6).join("\n")); process.exit(1); }
