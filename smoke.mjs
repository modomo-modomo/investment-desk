import fs from "node:fs";
const html = fs.readFileSync("index.html", "utf8");
const body = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const rd = (f) => { const s = fs.readFileSync(f, "utf8"); return JSON.parse(s.slice(s.indexOf("=") + 1, s.lastIndexOf(";"))); };
const W = rd("live-data.js"), Y = rd("live-extra.js"), ND = rd("live-news.js");
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
globalThis.window = { WIND_LIVE: W, YF_DATA: Y, NEWS_DATA: ND, addEventListener(){}, scrollTo(){} };
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
    const views=["brief","tracks","events","movers","stocks","strategy"];
    for(const v of views){ const h=VIEWS[v](); if(!h||h.length<200) throw new Error(v+" 渲染过短"); console.log("view",v,"OK",h.length,"chars"); }
    openStock(1); console.log("openStock OK");
    trackSel="fin"; const fin=DATA.tracks.find(x=>x.id==="fin");
    console.log("fin 标的池:", (fin.symsLive||[]).length, "只 · 样例:", JSON.stringify((fin.symsLive||[])[0]));
    console.log("创新高日志:", (DATA.highs&&DATA.highs.log||[]).length, "条 · 当日:", (DATA.highs&&DATA.highs.today||[]).length);
    console.log("客观观测:", (DATA.strategy.observing||[]).length, "条 · 第一条:", (DATA.strategy.observing||[])[0]||"—");
    console.log("非财报异动: 盘前", (DATA.moversPre||[]).length, "· 盘后", (DATA.moversPost||[]).length);
    console.log("川普动态条目:", ((window.NEWS_DATA.trump||{}).items||[]).length);
  `)(window, document, localStorage, location, navigator);
} catch (e) { console.log("视图错误:", e.stack.split("\n").slice(0,6).join("\n")); process.exit(1); }
