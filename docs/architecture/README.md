# EdgeScout 架构说明

> 面向 DreamDEX Event Contracts Hackathon(Somnia Testnet)的 AI 事件合约分析智能体。
> 本文档描述代码仓库的实际结构与数据流,与 `src/` 一一对应。

## 1. 产品定义

**一句话**:对 Somnia 测试网上 DreamDEX 的二元事件合约(BTC/ETH Up/Down 与
Strike 盘口),实时计算模型公允价值 vs 盘口隐含概率,输出「边缘」(edge)、风险分、
1/4-Kelly 模拟仓位建议,并由 LLM 生成结构化中文分析报告。

**Wow 时刻**(demo 主轴):打开看板 → 看到 550+ live 市场的实时盘口/模型概率/边缘
排序墙 → 点任一市场 → ~10s 内右侧生成完整 AI 报告(论点、信号、风险、仓位建议、置信度)。

**核心差异化(对评审)**:
1. **LLM 零幻觉**:所有数字由确定性模块(`model.ts`)预计算,LLM 只做叙述;
   置信度与仓位在 LLM 返回后仍从确定性输入重推。
2. **确定性模型可审计**:零漂移 Brownian 运动 + A&S 7.1.26 正态 CDF + 实测波动率,
   无黑盒、无第三方依赖,评审可逐行验证。
3. **不依赖钱包**:官方 SDK 只读用法,无需私钥即可完整运行(降低部署与评审门槛)。

## 2. 技术栈与理由

| 层 | 选择 | 理由 |
|---|---|---|
| 全栈 | Next.js 16(App Router)+ React 19 + Tailwind | 单仓交付;路由处理器(Node runtime)天然承载数据管线 |
| 数据 | `@somnia-chain/markets-sdk@0.28.1` + viem | 官方 SDK:indexer GraphQL + RPC;`loadMarkets`/`fetchOrderBook`/`fetchPrice`/`fetchPriceOHLCV` 只读即可用 |
| 模型 | 纯 TS 手写 | Φ 分布 CDF + 波动率 + Kelly,共 ~200 行,零依赖、可审计 |
| LLM | 任意 OpenAI 兼容端点(`.env`) | 用户侧 key 即可;缺失/失败自动 mock 模板(同数字、无叙述),演示不翻车 |

## 3. 组件清单(文件 ↔ 职责)

```
src/lib/config.ts   配置:测试网端点、BOARD_SIZE、10s 缓存 TTL、Kelly/paper 参数、LLM 配置
src/lib/model.ts    确定性层:
                    · normCdf (A&S 7.1.26, |err|<1.5e-7)
                    · modelYesProbability: ref = strike > 窗口开盘价(up/down) > EMA
                      p = Φ( ln(S/ref) / (σ√τ) ); 到期时按 S≥ref 取 0/1
                    · classifyEdge: edge = pModel − pImplied, ±3pp 阈值
                    · riskScore: 0.35·|d|贴近度 + 0.25·二元性 + 0.25·(1−流动性) + 0.15·盘口新鲜度
                    · sizePosition: f*=(p−c)/(c(1−c)), 1/4 Kelly, 上限 20% 资金
src/lib/market.ts   数据层:
                    · getExchange(): SomniaMarkets 惰性单例(只读,无 signer)
                    · parseSymbol(): 解析 `BTC-<strikeRaw>-<DDMMMYY-HHMM>[/tUSDC]`,
                      优先取 indexer 的 expiry/tradingStart/question;过滤 active 且未到期
                    · resolveStrikes(): strikeRaw ×100 = 人类价格,按与现货距离自愈换算
                    · fetchBoard(): loadMarkets → 解析/过滤 → 逐市场 fetchOrderBook(top5)
                      → 1m K线×60 实测波动率 → up/down 抓 tradingStart 的 1m open
                      → 模型/边缘/风险/仓位 → 按 |edge| 排序取 24 → 10s 模块级缓存
                    · buildViewForSymbol(): 单市场视图(支持不在榜上的 live 市场)
src/lib/llm.ts      报告层:buildPromptPayload(view) → 调用 LLM(30s 超时,JSON-only 提示词,
                    明确禁止编造数字);失败/无 key → mockReport(view) 确定性中文模板;
                    confidence/position 永远由 confidenceFromModel(view) 重推
src/lib/agent.ts    编排:findView(榜内命中 / indexer 校验后单市场构建) + generateReport
src/app/api/markets/route.ts    GET → fetchBoard()
src/app/api/analyze/route.ts    GET ?symbol= → analyze()
src/app/api/health/route.ts     GET → LLM 模式(live/mock)+ 网络
src/app/page.tsx    仪表盘(客户端组件):暗色终端风市场墙(15s 轮询)+ 右侧报告面板
```

## 4. Agent 数据流

```
            indexer (GraphQL)          RPC / price feed
                  │                          │
        loadMarkets(550+ 市场)      fetchPrice / OHLCV(1m×60)
                  │                          │
        parseSymbol + active/expiry 过滤      │
                  │                          │
        fetchOrderBook(symbol,5) 逐市场 ─────┤
                  │                          │
        strike 自愈(×100 vs spot)      波动率 sd(1m)·√525600
        up/down 取窗口开盘价(open@tradingStart,失败回退 EMA)
                  │                          │
        ┌─────────┴──────────┐               │
        │ modelYesProbability │◄──────────────┘
        │  p_model=Φ(ln S/ref / σ√τ)
        └─────────┬──────────┘
        edge = p_model − p_implied(±3pp 阈值)
        riskScore + sizePosition(1/4 Kelly, ≤20%)
                  │
        llm.ts: LLM 叙述(数字零幻觉) / mock 模板降级
                  │
        仪表盘市场墙(按 |edge| 排序) + 单市场报告面板
```

