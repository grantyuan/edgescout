# SDK & Documentation Feedback — `@somnia-chain/markets-sdk` 0.28.1

All findings below were observed while building **EdgeScout** (live market wall,
deterministic pricing model, LLM analyst, paper-trading ledger) against the
Somnia testnet and are reproducible.

---

## 1. Venue activity is undocumented — document the standard venue and how to tell which one is rolling

**Observation (corrected per Somnia team review).** Venue ids do *not*
drift: they are derived from an operator index and are stable. What
changes over time is *which venue is actively rolling markets*. EdgeScout's
original draft claimed id drift; the empty boards we saw were
active-venue churn, not id mutation. The standard DreamDEX testnet venue
is `0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c`,
and pinning it (EdgeScout's `TESTNET_VENUE_ID` default) is the right call
rather than avoiding the venue filter.

**Impact.** An integrator who discovers venue ids by sampling
`loadMarkets()` cannot distinguish "wrong venue id" from "that venue is
not rolling markets right now" — both present as an empty board, and
neither behavior is documented.

**Suggestion.**
- Document the standard DreamDEX testnet venue id (and that venue ids are
  stable, derived from the operator index) so integrators can pin it.
- Document how to tell which venue is actively rolling markets (e.g. an
  `active` flag on the venue listing), so an empty venue-filtered result
  is diagnosable instead of looking like id drift.

## 2. `strike` is a raw integer — ×100 gives the human price

**Observation.** For Strike markets, the `strike` value on the parsed
symbol / market info is a raw integer. The human-readable strike price is
`strikeRaw × 100` (e.g. `BTC-7943166-…` = strike $79,431.66). The scaling
factor is not documented anywhere in the SDK, the indexer response, or the
venue spec.

**Impact.** A naive `spot >= strike` settlement check is off by 100× and
silently settles the wrong side every time. This is a correctness trap,
not a convenience issue.

**Suggestion.**
- Document the scaling rule in the type definition of the market info
  (e.g. `/// Strike is a raw integer; divide by 100 to get the display
  price for BTC/ETH markets.`).
- Or expose a pre-scaled `strikePrice` field next to the raw value.
- EdgeScout self-heals by comparing the order of magnitude of `spot` vs
  `strike` and applying the factor, which is fragile — the SDK should make
  this unnecessary.

## 3. Up/Down markets settle vs the window OPEN price, not EMA

**Observation.** For Up/Down markets (strike = 0 / sentinel), the
settlement reference is the underlying price **at `tradingStart`** (the
window open). This is *not* the EMA mark, *not* the last price, and *not*
exposed by any SDK method. EdgeScout reconstructs it by fetching the 1m
candle at the `tradingStart` timestamp via `fetchPriceOHLCV` and taking
its open; on fetch failure it falls back to the EMA with a visible label.

**Impact.** Any analytics or settlement simulation built on the SDK
misprices Up/Down markets if it assumes EMA or last-price semantics. The
reference price is the single most important number for settlement and is
the least directly available.

**Suggestion.**
- Expose `windowOpenPrice` (or `settlementReference`) directly on the
  market info object — it is deterministic and known the instant the
  market is created.
- Document the settlement semantics of each market kind (Strike vs
  Up/Down) in the SDK README / type docs.

## 4. The testnet indexer never settles markets; settled markets vanish from the active list

**Observation.** Two compounding behaviors on testnet:
1. `status` stays `"Trading"` forever — `winningOutcome` is never filled.
   Settlement (spot vs strike/open) is not observable from the indexer.
2. After a market's window expires, the market **disappears from
   `loadMarkets(true)`** entirely (not just from the active-filtered
   views). A client that caches a market view and re-fetches it after
   expiry gets nothing.

**Impact.**
- Any application that tracks positions across expiry cannot read the
  official outcome from the API — it must compute settlement itself from
  the price feed (as EdgeScout does, keeping a `refPrice`/`refKind`
  captured at entry time).
- "Watch a market to settlement" UX is impossible with the current API
  surface on testnet.

**Suggestion.**
- Settle testnet markets on-chain (or at least in the indexer) so
  `winningOutcome` is populated — this is the canonical behavior users
  expect and makes integration testing meaningful.
- Keep settled markets queryable for N days after expiry (with
  `status = "Settled"`) instead of removing them from `loadMarkets(true)`.
- If the current behavior is intentional for testnet, document it
  explicitly so integrators do not assume mainnet semantics.

## 5. `fetchPriceOHLCV` timestamps are milliseconds; market info uses seconds

**Observation.** `UnifiedMarket.info.expiry` and `info.tradingStart` are
unix-seconds **strings**; `fetchPriceOHLCV` expects/returns
**milliseconds**. Mixing the two (very easy, both are "unix time") shifts
the candle window by 1000× and silently returns an empty or wrong slice.

**Suggestion.** Unify units across the SDK (milliseconds everywhere, or
seconds everywhere) and/or make the types distinguishable (a
`UnixMillis` wrapper) so the compiler catches the mix-up.

## 6. `fetchOrderBook(symbol, depth)` — depth semantics

**Observation.** `depth` = number of levels per side (verified: `depth = 5`
returns up to 5 bids and up to 5 asks). The parameter is documented as
"levels" in some places and "size" in others. Minor, but ambiguous for
newcomers.

**Suggestion.** Clarify in the type docs that `depth` is the number of
price levels per side.

## 7. No built-in "is this market settled?" helper

**Observation.** There is no one-call "settlement status + outcome" helper;
the client has to combine `loadMarkets` (to find the market), check
`status`/`winningOutcome` (which see findings #4), and fall back to
price-based inference. For event-contract applications this is the most
frequently needed query.

**Suggestion.** Provide `getMarketSettlement(symbol) -> {settled, outcome,
settledAt}` (with a documented price-feed fallback contract for testnet),
so every integration does not re-implement the same inference logic.

## 8. Things that work well

- **Indexer GraphQL + WS** are clean, fast, and stable across the
  integration period; the 10-second server-side cache pattern works well
  with `loadMarkets(true)`.
- **Symbol parsing** (`<ASSET>-<STRIKE>-<DDMMMYY-HHMM>`) is consistent and
  machine-parseable; the optional `/<token>` suffix is handled cleanly.
- **`fetchPrice`** (spot + EMA) is the single most useful call for
  settlement-reference reconstruction.
- **Read-only usage needs no wallet** — the SDK is pleasant to use for
  analytics apps (no key configuration beyond endpoints).

---

*Compiled by the EdgeScout team. Reproduction
details and the corresponding EdgeScout workarounds are kept in the
project's internal notes (not distributed).*
