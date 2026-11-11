#!/usr/bin/env node
/* 每交易日两次（20:30 / 次日 07:00）的编排入口：拉数据 → 生成 → 推送。
 *
 *   node daily.mjs --webhook "https://qyapi.weixin.qq.com/..." --site "https://..."
 *   node daily.mjs --dry        只预览不推送
 *   node daily.mjs --skip-wind  跳过 Wind（积分不足时用）
 *
 * 任一步失败都不中断后续步骤，最后汇总；任一步全挂则退出码非 0，便于定时任务报警。
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const has = (k) => argv.includes("--" + k);

const SKIP_WIND = has("--skip-wind");
const extra = [];
const w = argv.indexOf("--webhook");
const s = argv.indexOf("--site");
if (w >= 0 && argv[w + 1]) extra.push("--webhook", argv[w + 1]);
if (s >= 0 && argv[s + 1]) extra.push("--site", argv[s + 1]);
if (has("--dry")) extra.push("--dry");

const steps = [];
if (!SKIP_WIND) steps.push({ file: "sync.mjs", name: "Wind 主源", args: [] });
steps.push({ file: "sync-extra.mjs", name: "Yahoo / Nasdaq / 财报", args: [] });
steps.push({ file: "sync-news.mjs", name: "业绩内容", args: [] });
steps.push({ file: "push-wecom.mjs", name: "企业微信推送", args: extra });

const stamp = () => new Date(Date.now() + 8 * 3600e3).toISOString().replace("T", " ").slice(0, 19);
console.log(`\n===== 投资工作台 · 定时更新 ${stamp()} (UTC+8) =====`);

const results = [];
for (const step of steps) {
  if (!fs.existsSync(path.join(DIR, step.file))) {
    results.push({ name: step.name, ok: false, note: "脚本不存在" });
    console.log(`\n[跳过] ${step.name}：${step.file} 不存在`);
    continue;
  }
  console.log(`\n[开始] ${step.name} · node ${step.file}`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [step.file, ...step.args], { cwd: DIR, stdio: "inherit" });
  const ms = Date.now() - t0;
  const ok = r.status === 0;
  results.push({ name: step.name, ok, note: ok ? `${(ms / 1000).toFixed(1)}s` : `退出码 ${r.status}` });
  console.log(`[${ok ? "完成" : "失败"}] ${step.name} · ${(ms / 1000).toFixed(1)}s`);
}

console.log("\n===== 汇总 =====");
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}  ${r.note}`);

const failed = results.filter((r) => !r.ok);
if (failed.length === results.length) {
  console.error("\n全部步骤失败，检查网络与 Wind 积分。");
  process.exit(1);
}
if (failed.some((r) => r.name === "企业微信推送")) {
  console.error("\n推送失败：数据已更新，但没发出去。检查 webhook key。");
  process.exit(2);
}
