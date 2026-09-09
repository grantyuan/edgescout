# EdgeScout — AI Event-Contract Analytics Agent

> DreamDEX Event Contracts Hackathon (Somnia Testnet)
>
> An AI analytics agent for DreamDEX binary event contracts: live Somnia-testnet
> order books → deterministic fair value (zero-drift Brownian model with
> measured volatility) → edge vs implied probability → hallucination-free LLM
> analyst report + 1/4-Kelly paper positions, all in a live dashboard.

## Overview

**The problem.** DreamDEX event contracts are binary bets on where BTC/ETH price
sits relative to a reference (a strike, or the window *open* price) at expiry.
The order book is the market's probability; a stochastic model is the
mathematical probability. Their difference is an executable edge — if the book
is thin, mispriced, or slow. EdgeScout treats this as a **statistical-arbitrage
problem**: the book's implied probability is the market's view, the model's
fair value is the mathematical view, and the gap between them is the
tradeable edge.

```
 ┌────────────┐   ┌─────────────────┐   ┌──────────────┐   ┌─────────────────┐
 │  Order book │ → │  Deterministic  │ → │  Edge call   │ → │  LLM report     │
 │  + price    │   │  p_model vs     │   │  ±3pp thresh │   │  (narrates the  │
 │  live pull  │   │  p_implied      │   │              │   │  numbers only)  │
 └────────────┘   └─────────────────┘   └──────────────┘   └─────────────────┘
```

## What EdgeScout does

- **Live market wall** — all active BTC/ETH Up/Down and Strike markets on the
  Somnia testnet via the official `@somnia-chain/markets-sdk`: bid/ask,
  implied probability, model fair value, edge, risk score, suggested action.
  Auto-refreshes every 15s; no venue filtering (testnet venue activity
  churns — which venue is rolling changes; venue ids themselves are stable).
- **Click → full analyst report in seconds** — deterministic model
  `P(S_T ≥ K) = Φ(ln(S/ref)/(σ√τ))` under zero-drift Brownian motion, with
  volatility measured from 60 one-minute candles; Up/Down markets settle vs
  the window open price (fetched at the exact `tradingStart` candle, EMA
  fallback).
- **The LLM never produces a number.** Every price, probability, edge, and
  position size is pre-computed by deterministic, unit-tested code (40
  passing tests); the LLM only narrates, with an automatic deterministic
  mock fallback so the demo never breaks on stage. Confidence and position
  sizing are always re-derived from the deterministic inputs.
- **Paper trading** — 1/4 Kelly sizing (20% bankroll cap), mark-to-market,
  automatic settlement at expiry by spot-vs-reference (the testnet indexer
  never settles on-chain), persisted ledger with win-rate and P&L. No
  on-chain orders, no wallet needed.
- **Model scorecard** — re-evaluates the exact deterministic model one minute
  before expiry over the 100 most recently settled testnet markets (bounded
  concurrency, 60s server cache) and reports hit-rate + Brier score against
  the real on-chain outcomes: the model's predictive power, *measured, not
  claimed*.
- **Detail view** — 90-candle SVG K-line chart with the settlement reference
  line and a top-5 bid/ask depth ladder: the model's raw inputs, verifiable
  by eye (`/api/chart?symbol=`).

## Screenshots

**Live market wall** — every active BTC/ETH binary market with bid/ask,
implied probability, model fair value, edge, risk and suggested action:

![Live market wall](docs/screenshots/01-market-wall.png)

**One-click analyst report** — deterministic model fair value, edge, top-5
depth ladder, 90-candle K-line with the settlement reference line, LLM
thesis / signals / risks, and a one-click simulated fill:

![AI analyst report](docs/screenshots/02-ai-report.png)

## Architecture & data flow

1. **`fetchBoard()`** (`src/lib/market.ts`) — `loadMarkets()` → parse the
   symbol (`BTC-<strikeRaw>-<DDMMMYY-HHMM>`; `strikeRaw × 100` = human price,
   `0` = up/down) → keep only active, unexpired markets →
   `fetchOrderBook(symbol, 5)` for top-5 two-sided bid/ask and depth → sort
   by |edge| and take `BOARD_SIZE` (default 24), with a 10s server cache.
   Up/Down markets additionally fetch the 1m-candle open at `tradingStart`
   as the settlement reference.
2. **`modelYesProbability()`** (`src/lib/model.ts`) — reference = the strike
   (strike markets) or the window open price (up/down, EMA fallback);
   `d = ln(S/ref)/(σ√τ)` → `Φ(d)` (Abramowitz & Stegun 7.1.26 normal CDF).
3. **Edge & sizing** — `edge = p_model − p_implied`; a direction is given
   only when |edge| ≥ 3pp, with the entry price taken from the matching side's
   best quote; `f* = (p−c)/(c(1−c))`, take 1/4 Kelly, capped at 20% of
   bankroll.
4. **`/api/analyze?symbol=`** — runs the full pipeline (view + report) for a
   single market; works for any live market, not just ones on the board
   (validated against the indexer first).
5. **`/api/chart?symbol=`** — the last 90 1m candles + settlement reference
   (the detail-view data plane).
6. **`/api/paper` / `/api/paper/open`** — read the paper account / open a
   simulated position (POST `{symbol}`, filled at 1/4 Kelly at the current
   suggestion).

## Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend / full-stack | Next.js 16 (App Router) + React 19 + Tailwind | Single repo, dark terminal-style dashboard |
| Data source | `@somnia-chain/markets-sdk@0.28.1` | Official SDK, indexer GraphQL + RPC, read-only (no wallet) |
| Model | TypeScript (zero third-party deps) | A&S 7.1.26 normal CDF, volatility from 1m candles |
| LLM | Any OpenAI-compatible endpoint (`.env`) | Auto mock fallback when absent |

## Run

```bash
npm install
cp .env.example .env   # optional: LLM_API_KEY (falls back to mock mode)
npm test               # 40 deterministic tests, zero framework
npm run build && npm start
# → http://localhost:3000
```

Works with no LLM key and no testnet wallet (read-only + simulated). Real
order placement would require `@dreamdex-bot-kit/ec-core` (out of scope for
this demo).

## Directory

```
src/lib/config.ts   # config (testnet endpoints, caches, Kelly params, LLM)
src/lib/model.ts    # deterministic probability / edge / risk / sizing (+ model.test.ts)
src/lib/market.ts   # market parsing + book + candles + board building + chart data
src/lib/llm.ts      # report generation (LLM + mock fallback)
src/lib/agent.ts    # analysis pipeline orchestration
src/lib/paper.ts    # paper-trading ledger (simulated fill / mark-to-market / auto-settle, file persistence)
src/components/     # CandleChart (SVG K-line + settlement reference line)
src/app/            # Next.js dashboard + /api/markets /api/analyze /api/chart
                    #             + /api/health /api/paper /api/paper/open /api/scorecard
docs/               # architecture + demo video + demo script
research/           # event & data-plane research
```

## Deterministic unit tests

`npm test` runs 40 cases (Node built-in `node:test`, zero framework):
17 model cases (CDF, reference priority, expiry settlement semantics, Kelly
formula & 20% cap) + 14 paper-ledger settlement cases (binary payout,
dual-side mirroring, expiry gate, stale entries, spot cache, no-op does not
write; hermetic temp cwd, zero network) + 9 scorecard cases (hit-rate / Brier
aggregation, 0.5 boundary direction, ×100 strike-conversion self-healing).

## Known limitations

- Testnet books are thin and noisy; an "edge" may be a counterparty's
  mispricing rather than a real opportunity (the model itself does not
  generate alpha).
- 1m-candle volatility is a coarse approximation for short windows (≤5min).
- Pure simulation: no fees/slippage; real trading needs `ec-core` integer
  price conversion (venue 18 decimals).
- The paper ledger persists to `data/paper-ledger.json`; on a read-only
  filesystem (e.g. Vercel serverless) it degrades to an in-memory ledger
  (valid for the instance lifetime); local/self-hosted keeps it across
  restarts.

---
*testnet data is for demonstration only and is not investment advice.*
