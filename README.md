# 投资工作台 · 云端自动更新

单文件投资看板（`index.html`）+ 三个数据抓取脚本，由 GitHub Actions 在每个交易日
北京时间 07:00 和 20:30 自动更新，并发布到 GitHub Pages。

**电脑不需要开机。** 定时任务跑在 GitHub 的服务器上。

---

## 一次性部署（约 10 分钟）

### 1. 建一个空仓库

打开 https://github.com/new

- Repository name 填 `investment-desk`
- 可见性选 **Public**（原因见下方「为什么必须用公开仓库」）
- **不要**勾选 Add a README / .gitignore / license，保持完全空白
- 点 Create repository

### 2. 把本目录推上去

在本目录执行（把 `<你的用户名>` 换成你的 GitHub 用户名）：

```bash
git init
git add .
git commit -m "投资工作台：初始版本"
git branch -M main
git remote add origin https://github.com/<你的用户名>/investment-desk.git
git push -u origin main
```

第一次 push 会要求登录。GitHub 不再接受账号密码，需要用 **Personal Access Token**：
GitHub 右上角头像 → Settings → Developer settings → Personal access tokens →
Tokens (classic) → Generate new token → 勾选 `repo` 权限 → 复制生成的 token 当作密码粘贴。

### 3. 打开 Pages

仓库页面 → **Settings** → 左侧 **Pages** → Source 选 **GitHub Actions**。

（不要选 "Deploy from a branch"，本仓库用的是自定义 workflow。）

### 4. 手动跑一次验证

仓库页面 → **Actions** → 左侧「投资工作台 · 每交易日更新」→ 右侧 **Run workflow** → 绿色按钮。

等 1–2 分钟，两个 job 都变绿就成功了。

### 5. 拿到你的地址

格式固定为：

```
https://<你的用户名>.github.io/investment-desk/
```

手机浏览器打开这个地址 → 分享 → **添加到主屏幕**。之后点图标就是全屏，跟 App 一样。

---

## 之后会自动发生什么

| 北京time | 做什么 |
|---|---|
| 每周一至周五 07:00 | 抓昨日美股收盘 + 盘后业绩，回填盘前跳空的收盘表现 |
| 每周一至周五 20:30 | 抓当日盘前披露名单 + 昨晚盘后业绩 |

每次跑完会：

1. 重新生成 `live-data.js`、`live-extra.js`、`live-news.js`
2. 把这三个文件 commit 回仓库（Actions 页面能看到提交记录）
3. 用新的数据重建 GitHub Pages

所以手机上的地址**永远不变**，刷新就是最新数据。

节假日不会跳过（脚本照跑，只是抓不到新披露，数据保持不变）。

---

## 数据从哪来

| 文件 | 内容 | 来源 |
|---|---|---|
| `live-data.js` | 14 只标的、13 个指数、7 项跨资产 | Yahoo Finance |
| `live-extra.js` | 11 个板块 ETF、BTC/ETH、标普量能、等权 RSP、财报日历、双端点校验 | Yahoo + Nasdaq |
| `live-news.js` | 业绩要点与指引原文 | 东方财富 7×24 快讯 → Yahoo 标题 |

**全部数据源已统一到 Yahoo，不再依赖 Wind。**

原版 `sync.mjs`（走本机 Wind CLI）已移除。现在 `sync-core.mjs` 直接生成 `live-data.js`，
字段结构保持不变，页面无需改动。

校验方式：`live-data.js` 的昨收价来自 chart v8，`live-extra.js` 的昨收来自 quote v7，
两条链路相互独立，**14/14 一致**（容差 0.05%）。
铜价由 COMEX 美分/磅按 1 磅 = 2204.6226 换算成美元/吨。

---

## 本地怎么跑

```bash
node sync-core.mjs      # 核心行情 → live-data.js
node sync-extra.mjs     # 辅助数据 → live-extra.js
node sync-news.mjs      # 业绩内容 → live-news.js
node daily.mjs          # 依次跑完上面三步
```

本地跑完直接刷新 `index.html` 就能看到新数据，不需要部署。

三个脚本都是零第三方依赖，只用 Node 内置模块，不需要 `npm install`。

---

## 为什么必须用公开仓库

GitHub Pages 对**私有仓库**需要付费账户（Pro 及以上）。**公开仓库完全免费**，
Actions 也不限时长。

本仓库里没有任何密钥：抓取全部走公开接口，Wind key 不在代码里。
唯一公开的信息是你的投资看板本身。

如果确实要用私有仓库，两条路：

1. 升级 GitHub Pro（约 4 美元/月），私有仓库即可开 Pages
2. 把 Pages 换成 Cloudflare Pages（免费支持私有仓库），workflow 里的 deploy job 需要改成
   Cloudflare 的部署 action，并配置 API Token

---

## 改东西要动哪里

| 想改什么 | 改哪个文件 |
|---|---|
| 页面布局、文案、模块 | `index.html` |
| 覆盖的标的池（14 只） | `sync-core.mjs` 的 `STOCKS` 数组 + `sync-extra.mjs` 的标的列表 |
| 指数、跨资产清单 | `sync-core.mjs` 的 `INDICES`、`CROSS` 数组 |
| 抓取时间 | `.github/workflows/daily.yml` 的 `cron` 表达式（注意是 UTC） |
| 财报阈值、披露家数 | `sync-extra.mjs` 里 `build(日期, 场次, 8)` 的最后一个参数 |

改完 push，下一次定时任务就生效；也可以去 Actions 页面手动 Run workflow 立即验证。

---

## 已知限制

- **静态文案会过时**。页面里"核心结论""市场色彩解读"这些是人工写的判断，不会随数据自动改写。
  数据每天新，解读需要人工更新。
- **GitHub 定时任务会延迟**，通常 5–15 分钟，属正常现象，不是故障。
- **公开仓库的定时任务在连续 60 天无提交活动后会被自动停用**。每天都有数据提交就不会触发；
  若长期停更，去 Actions 页面点一次 Run workflow 即可恢复。
- **Wind 已完全移除**，行情/指数/跨资产/财报全部走 Yahoo，业绩正文走东方财富。
  如果哪天 Yahoo 接口变了，`sync-core.mjs` 与 `sync-extra.mjs` 需要跟着调整。
- 小市值公司的业绩正文东方财富未必覆盖，此时退到 Yahoo 新闻标题（只有标题、没有正文），
  少数极冷门标的可能连标题都没有，`live-news.js` 里该条为 `ok:false`。
