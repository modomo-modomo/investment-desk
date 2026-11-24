window.FED_DATA = {
 "meta": {
  "syncedAt": "2026-11-24T13:54:12.189Z",
  "board": [
   {
    "zh": "沃什",
    "en": "Kevin Warsh",
    "title": "主席"
   },
   {
    "zh": "杰斐逊",
    "en": "Philip N. Jefferson",
    "title": "副主席"
   },
   {
    "zh": "鲍曼",
    "en": "Michelle W. Bowman",
    "title": "监管副主席"
   },
   {
    "zh": "巴尔",
    "en": "Michael S. Barr",
    "title": "理事"
   },
   {
    "zh": "库克",
    "en": "Lisa D. Cook",
    "title": "理事"
   },
   {
    "zh": "鲍威尔",
    "en": "Jerome H. Powell",
    "title": "理事"
   },
   {
    "zh": "沃勒",
    "en": "Christopher J. Waller",
    "title": "理事"
   }
  ],
  "probsSrc": "自算：EFFR 3.88%（纽约联储 2026-11-20）+ 30 天联邦基金期货 ZQZ26.CBT 及后续月份（Yahoo 行情）。算法同 CME FedWatch；CME 官网已封禁脚本抓取，故不引用其数字",
  "note": "讲话摘要与解读为规则生成（关键句抽取 + 鹰鸽计数），非人工判断；原话以联储官网为准。含议息会议记者会（只取主席发言）。"
 },
 "probs": {
  "meeting": "2026 年 12 月 8-9 日",
  "decision": "12-10 03:00（北京时间，决议公布）",
  "nextDate": "2026-12-09",
  "probs": [
   {
    "label": "维持不变",
    "p": 0.8,
    "color": "#7a8798"
   },
   {
    "label": "加息 25bp",
    "p": 99.2,
    "color": "#d2373a"
   }
  ],
  "impliedAfter": 4.128,
  "impliedMoveBp": 24.8,
  "effr": 3.88,
  "target": "3.75–4%",
  "effrDate": "2026-11-20",
  "futPx": 4.064999999999998,
  "futSym": "ZQZ26.CBT",
  "futAt": "2026-11-24 21:40",
  "path": [
   {
    "d": "2027-01-27",
    "implied": 4.295
   },
   {
    "d": "2027-03-17",
    "implied": 4.426
   },
   {
    "d": "2027-04-28",
    "implied": 4.47
   }
  ],
  "src": "自算：EFFR 3.88%（纽约联储 2026-11-20）+ 30 天联邦基金期货 ZQZ26.CBT 及后续月份（Yahoo 行情）。算法同 CME FedWatch；CME 官网已封禁脚本抓取，故不引用其数字"
 },
 "predict": {
  "tone": "继续收紧",
  "hawk": 4,
  "dove": 0,
  "neutral": 1,
  "total": 5,
  "topics": {
   "市场": 3,
   "通胀": 3,
   "就业": 3,
   "利率": 3
  },
  "agree": false,
  "text": "最近一次记者会（2026-10-28）已维持不变 → 3.75–4.00%，近 200 天主席表态 偏鹰 4 / 中性 1 / 偏鸽 0 → 方向指向<b>继续收紧</b>；期货自算 2026 年 12 月 8-9 日最可能为<b>维持不变 0.8%</b>，<b>与表态不同向</b>（市场定价走得更远或更近，注意会后修正风险）。"
 },
 "speeches": [
  {
   "date": "2026-11-16",
   "url": "https://www.federalreserve.gov/newsevents/speech/warsh20261116a.htm",
   "title": "Opening Remarks",
   "cnTitle": "开幕致辞",
   "speaker": "沃什",
   "en": "Kevin Warsh",
   "role": "主席",
   "venue": "At the Productivity and Jobs Task Force Conference, hosted by the Federal Reserve Board and the Federal Reserve Bank of San Francisco, San Francisco, California",
   "snip": "我还要感谢 Marc、Chad 和 Asha 领导我们的生产力和<b>就业</b>工作组。这些团体是拓宽我们思维的一种方式。 。 。邀请激烈的讨论，让我们比转瞬即逝的数据点或日常市场波动走得更远、更深入。然而，正如尼克·布鲁姆、查德·琼斯及其合著者所指出的那样，“研究生产力的下降幅度更大。” 2 结果：生产力...",
   "snipEn": "I also want to thank Marc, Chad, and Asha for leading our Productivity and Jobs Task Force. These groups are a way of broadening our thinking . . . of inviting robust discussions that take us further and deeper than fleeting data points or daily market moves. Yet, as Nick Bloom, Chad Jones, and their coauthors have pointed out, \"Research productivity has fallen by an even larger amount.\" 2 The result: Productivi…",
   "tone": "中性",
   "read": "中性：强调 AI/生产率是供给端变量，属结构性而非周期信号；强调 AI/生产率是供给端变量，属结构性而非周期信号。",
   "impact": "对定价影响有限，市场更看重随后公布的数据（CPI / 非农）而非表态本身",
   "isNew": false
  },
  {
   "date": "2026-10-28",
   "url": "https://www.federalreserve.gov/mediacenter/files/FOMCpresconf20261028.pdf",
   "kind": "presser",
   "title": "Chairman Warsh's Press Conference (2026-10-28)",
   "cnTitle": "10 月议息会议记者会 · 维持不变 → 3.75–4.00%",
   "speaker": "沃什",
   "en": "Kevin Warsh",
   "role": "主席",
   "venue": "维持不变 → 3.75–4.00%",
   "decision": {
    "act": "维持不变",
    "bp": 0,
    "range": "3.75–4.00%",
    "label": "维持不变 → 3.75–4.00%"
   },
   "topics": [
    "市场",
    "通胀",
    "就业",
    "利率"
   ],
   "snip": "任务是：在金融稳定的背景下实现稳定的价格和充分<b>就业</b>；我在之前的新闻发布会上提到过，如果你试图对我们当中最不富裕的人造成最大的伤害……",
   "snipEn": "The mandate was: D eliver stable prices and deliver full employment, all in the context of financial stability. ／ I mentioned, I think at a prior press conference, if you were trying to do the most harm to the least well - off among us…",
   "tone": "偏鹰",
   "read": "偏鹰：明确通胀仍高于目标，政策需要保持限制性；提到资产负债表，缩表节奏影响准备金与流动性。",
   "impact": "短端利率与美元有上行压力，2Y 最敏感；成长股与长久期资产估值受压制，AI 基建 / Neocloud 的融资成本抬升",
   "isNew": false
  },
  {
   "date": "2026-09-16",
   "url": "https://www.federalreserve.gov/mediacenter/files/FOMCpresconf20260916.pdf",
   "kind": "presser",
   "title": "Chairman Warsh's Press Conference (2026-09-16)",
   "cnTitle": "9 月议息会议记者会 · 加息 25bp → 3.75–4.00%",
   "speaker": "沃什",
   "en": "Kevin Warsh",
   "role": "主席",
   "venue": "加息 25bp → 3.75–4.00%",
   "decision": {
    "act": "加息",
    "bp": 25,
    "range": "3.75–4.00%",
    "label": "加息 25bp → 3.75–4.00%"
   },
   "topics": [
    "市场",
    "通胀",
    "就业",
    "利率"
   ],
   "snip": "而且，正如我在杰克逊霍尔政策研讨会上所说，我很难将广泛的金融状况描述为<b>限制性</b>的；此外，我想说，由于经济的潜在实力，因为正如我所提到的，我们的行为基本上与充分<b>就业</b>一致，所以我们可以专注于稳定的价格",
   "snipEn": "And, a s I said at the policy symposium in Jackson Hole, I would be hard pressed to describe broad financial conditions as restrictive. ／ Moreover, I would say, because of the underlying strength of the economy, because we are, as I mentioned, largely acting consistent with full employment, we can be focused on stable prices.",
   "tone": "偏鹰",
   "read": "偏鹰：明确通胀仍高于目标，政策需要保持限制性；把关税纳入通胀评估，供给端冲击可能延长紧缩时间。",
   "impact": "短端利率与美元有上行压力，2Y 最敏感；成长股与长久期资产估值受压制，AI 基建 / Neocloud 的融资成本抬升",
   "isNew": false
  },
  {
   "date": "2026-08-28",
   "url": "https://www.federalreserve.gov/newsevents/speech/warsh20260828a.htm",
   "title": "In Our Time",
   "cnTitle": "在我们的时代",
   "speaker": "沃什",
   "en": "Kevin Warsh",
   "role": "主席",
   "venue": "At “Financial Innovation: Implications for Payments and Policy,” an economic policy symposium sponsored by the Federal Reserve Bank of Kansas City, Jackson Hole, Wyoming",
   "snip": "创新是会议的主题，我相信公众和市场以他们的集体智慧理解，美联储政策实施的创新将有助于实现价格稳定和充分<b>就业</b>。接下来，我将提出一些我认为应该指导货币政策实施的关键原则。我并不是唯一一个注意到 2021 年前瞻性指引的人，举一个例子……",
   "snipEn": "Innovation is the conference theme, and I believe that the public and the markets—in their collective wisdom—understand that innovations in the conduct of policy at the Fed will help deliver price stability alongside full employment. Next, I'll present some of the key principles that I believe should guide the conduct of monetary policy. I'm not alone in noticing that forward guidance in 2021, to cite one exampl…",
   "tone": "偏鹰",
   "read": "偏鹰：明确通胀仍高于目标，政策需要保持限制性；强调 AI/生产率是供给端变量，属结构性而非周期信号。",
   "impact": "短端利率与美元有上行压力，2Y 最敏感；成长股与长久期资产估值受压制，AI 基建 / Neocloud 的融资成本抬升",
   "isNew": false
  },
  {
   "date": "2026-07-29",
   "url": "https://www.federalreserve.gov/mediacenter/files/FOMCpresconf20260729.pdf",
   "kind": "presser",
   "title": "Chairman Warsh's Press Conference (2026-07-29)",
   "cnTitle": "7 月议息会议记者会 · 维持不变 → 3.50–3.75%",
   "speaker": "沃什",
   "en": "Kevin Warsh",
   "role": "主席",
   "venue": "维持不变 → 3.50–3.75%",
   "decision": {
    "act": "维持不变",
    "bp": 0,
    "range": "3.50–3.75%",
    "label": "维持不变 → 3.50–3.75%"
   },
   "topics": [
    "市场",
    "通胀",
    "就业",
    "利率"
   ],
   "snip": "我认为，金融市场上的一些人、一些家庭和企业有一种错误的印象，认为中央银行家喜欢我，我们设定了 2% 的<b>通胀</b>目标……；我倾向于认为，在接下来的几个月里，我们将完善这一观点并做出更好的判断，并且我们也将让市场价格试图帮助提供信息",
   "snipEn": "I think there was a misimpression  by some in financial markets, by some households and businesses  that central bankers like me  we set a 2 percent inflation target… ／ I tend to think, in the coming months, we’re going to refine that view and have a better judgment, and we’re going to have market prices trying to help inform it, too.",
   "tone": "偏鹰",
   "read": "偏鹰：明确通胀仍高于目标，政策需要保持限制性；把关税纳入通胀评估，供给端冲击可能延长紧缩时间。",
   "impact": "短端利率与美元有上行压力，2Y 最敏感；成长股与长久期资产估值受压制，AI 基建 / Neocloud 的融资成本抬升",
   "isNew": false
  }
 ]
};
