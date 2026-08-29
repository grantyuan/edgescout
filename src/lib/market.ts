// ---------------------------------------------------------------------------
// EdgeScout — market row parsing + board construction
//
// DreamDEX event-contract markets are binary Up/Down windows on BTC/ETH:
// the market symbol is `ASSET-<strikeRaw>-<DDMMMYY-HHMM>[/collateral]`, where
// `<strikeRaw>` is the strike × 100 (e.g. "7876055" = 78760.55) and "0"
// means a plain up/down market whose reference is the venue EMA mark. The
// `DDMMMYY-HHMM` suffix is the window end (UTC). We re-derive the venue id
// from live rows when the configured venue filter comes back empty (venue
// ids have moved on this testnet in the past).
// ---------------------------------------------------------------------------

import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES, SOMNIA_TESTNET_PRICE_FEED, type UnifiedMarket } from "@somnia-chain/markets-sdk";
import { defineChain } from "viem";
import { BOARD_CACHE_TTL_MS, BOARD_SIZE, DEFAULT_VOL, LLM, PAPER, SOMNIA_TESTNET } from "./config.ts";
import { classifyEdge, modelYesProbability, riskScore, sizePosition, type ModelOutput } from "./model.ts";

// --- exchange singleton -----------------------------------------------------

let exchangePromise: Promise<SomniaMarkets> | null = null;

/** Lazy singleton exchange (read-only; no signer for the demo). */
export function getExchange(): Promise<SomniaMarkets> {
  if (!exchangePromise) {
    exchangePromise = Promise.resolve(
      new SomniaMarkets({
        indexerUrl: SOMNIA_TESTNET.indexerUrl,
        chain: defineChain({
          id: SOMNIA_TESTNET.chainId,
          name: SOMNIA_TESTNET.chainName,
          nativeCurrency: {
            name: "Somnia Test Token",
            symbol: "STT",
            decimals: 18,
          },
          rpcUrls: { default: { http: [SOMNIA_TESTNET.rpcHttp] } },
        }),
        wsRpcUrl: SOMNIA_TESTNET.rpcWs,
        addresses: SOMNIA_TESTNET_ADDRESSES,
        priceFeed: SOMNIA_TESTNET_PRICE_FEED,
      }),
    );
  }
  return exchangePromise;
}

// --- types -------------------------------------------------------------------

export interface MarketRow {
  /** Canonical market symbol (no outcome suffix). */
  symbol: string;
  /** Underlying asset code ("BTC" / "ETH"). */
  asset: string;
  /** Human-unit strike; null for up/down (strike-0) markets. */
  strike: number | null;
  /** Window end as ISO timestamp (UTC). */
  expiresAt: string;
  /** Unix ms of window end. */
  expiresAtMs: number;
  /** Window start in unix ms (up/down markets settle vs. the open price). */
  tradingStartMs: number | null;
  /** Venue-authored question text (e.g. "BTC closes at or above its opening price"). */
  question: string | null;
  /** Raw on-chain market status (1 = Trading / active). */
  active: boolean;
}

export interface BookTop {
  yesBid: number | null;
  yesAsk: number | null;
  /** Sum of top-5 bid + ask quantities (share units, YES side). */
  depth: number;
  /** Book snapshot timestamp (ms, local). */
  timestamp: number | null;
  /** Top-5 YES-side levels: [price, qty][] (detail view depth ladder). */
  bids: [number, number][];
  asks: [number, number][];
}

export interface MarketView {
  symbol: string;
  asset: string;
  strike: number | null;
  strikeLabel: string;
  upDown: boolean;
  expiresAt: string;
  secondsToExpiry: number;
  active: boolean;
  book: BookTop;
  /** Implied YES probability (book mid); null when book is one-sided/empty. */
  pImplied: number | null;
  /** Model fair value + context. */
  model: ModelOutput;
  /** Model vs. implied edge. */
  edge: number | null;
  edgeKind: "aligned" | "yes-underpriced" | "yes-overpriced" | "n/a";
  /** 0-100, higher = riskier. */
  risk: number | null;
  /** Paper-trade suggestion (deterministic; no LLM). */
  suggestion: {
    action: "SKIP" | "BUY_YES" | "BUY_NO";
    positionPct: number;
    kellyRaw: number;
    entryPrice: number;
  } | null;
  /** Window open price for up/down markets (model reference); null otherwise. */
  openPrice: number | null;
  /** Venue-authored question text. */
  question: string | null;
  spot: number | null;
  ema: number | null;
}

// --- symbol parsing -----------------------------------------------------------

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

/**
 * Build a MarketRow from a live binary market. Prefer the indexer's own
 * `expiry` / `tradingStart` / `question` over re-parsing the symbol when
 * present; the symbol still parses (asset + strike scale) as the fallback.
 */
export function parseSymbol(symbol: string, m: UnifiedMarket): MarketRow | null {
  const stem = symbol.split("/")[0];
  const mm = stem.match(/^([A-Z]+)-(\d+)-(\d{2})([A-Z]{3})(\d{2})-(\d{4})(?:-([A-Z0-9]+))?$/);
  if (!mm) return null;
  const [, asset, , dd, mon, yy, hhmm] = mm;
  const month = MONTHS[mon];
  if (!month) return null;
  const hh = Number(hhmm.slice(0, 2));
  const mnt = Number(hhmm.slice(2, 4));
  const date = new Date(Date.UTC(2000 + Number(yy), month - 1, Number(dd), hh, mnt));

  const info = m.info as {
    expiry?: string | number | null;
    tradingStart?: string | number | null;
    question?: string | null;
    asset?: string;
  };
  const toMs = (v: string | number | null | undefined): number | null => {
    const n = v == null ? null : Number(v);
    return n != null && Number.isFinite(n) ? n * 1000 : null;
  };
  const expiresAtMs = toMs(info.expiry) ?? date.getTime();
  const tradingStartMs = toMs(info.tradingStart);

  return {
    symbol,
    asset: info.asset ?? asset,
    strike: null, // strike scale resolved later vs spot
    expiresAt: new Date(expiresAtMs).toISOString(),
    expiresAtMs,
    tradingStartMs,
    question: info.question ?? null,
    active: m.active,
  };
}

// --- board ---------------------------------------------------------------------

interface BoardCache {
  at: number;
  view: MarketView[];
}

let boardCache: BoardCache | null = null;

/**
 * Build the market board:
 *  1. loadMarkets() (indexer), keep binary BTC/ETH markets that parse;
 *  2. resolve venue from live rows when the configured venue filter is empty;
 *  3. fetch top-N books (cheapest N by proximity to expiry, most liquid first
 *     is overkill for the demo — deterministic: soonest expiring first);
 *  4. fetch spot + EMA per asset;
 *  5. compute implied/model probability, edge, risk, sizing.
 */
export async function fetchBoard(): Promise<MarketView[]> {
  const now = Date.now();
  if (boardCache && now - boardCache.at < BOARD_CACHE_TTL_MS) {
    return boardCache.view;
  }
  const ex = await getExchange();
  const markets = await ex.loadMarkets(true);
  const rows: MarketRow[] = [];
  for (const [symbol, m] of Object.entries(markets)) {
    const row = parseSymbol(symbol, m);
    if (!row) continue;
    // Keep only markets still tradable and not yet expired — the wall is a
    // live view; settled/expired markets carry no book and no edge.
    if (!row.active || row.expiresAtMs <= now) continue;
    rows.push(row);
  }
  if (rows.length === 0) {
    // No live binary markets — surface a clear error rather than an empty wall.
    throw new Error("no live binary markets on testnet right now (indexer empty or venue moved?)");
  }
  // Resolve strike scale: strikeRaw is ×100 of the human price when it is
  // within a sane range of the current spot (self-healing across venues).
  const spotByAsset: Record<string, { spot: number; ema: number | null }> = {};
  const assets = Array.from(new Set(rows.map((r) => r.asset)));
  for (const asset of assets) {
    try {
      const p = await ex.fetchPrice(asset);
      if (p && p.price != null) {
        spotByAsset[asset] = { spot: Number(p.price), ema: p.ema != null ? Number(p.ema) : null };
      }
    } catch {
      // price feed unavailable for this asset — fall back to default vol, no spot
    }
  }
  // Resolve strike (scale) per row using spot.
  resolveStrikes(rows, spotByAsset);
  // Sort: soonest expiring first, deterministic.
  rows.sort((a, b) => a.expiresAtMs - b.expiresAtMs);
  const top = rows.slice(0, BOARD_SIZE);

  const views: MarketView[] = [];
  for (const row of top) {
    const view = await buildView(ex, row, spotByAsset[row.asset] ?? null, now);
    views.push(view);
  }
  // Re-sort by |edge| desc (most interesting first) when edges are known.
  views.sort((a, b) => Math.abs(b.edge ?? 0) - Math.abs(a.edge ?? 0));
  boardCache = { at: now, view: views };
  return views;
}

function extractStrikeRaw(symbol: string): number | null {
  const stem = symbol.split("/")[0];
  const m = stem.match(/^[A-Z]+-(\d+)-/);
  return m ? Number(m[1]) : null;
}

/**
 * Resolve strike scale per row: strikeRaw is ×100 of the human price when
 * within a sane range of the current spot (self-healing across venues).
 */
function resolveStrikes(
  rows: MarketRow[],
  spotByAsset: Record<string, { spot: number; ema: number | null }>,
): void {
  for (const row of rows) {
    const s = spotByAsset[row.asset];
    const strikeRawN = extractStrikeRaw(row.symbol);
    if (strikeRawN == null) continue;
    if (strikeRawN === 0) continue; // up/down: no strike
    if (s) {
      const c100 = strikeRawN / 100;
      const c1 = strikeRawN;
      // Pick the scale whose value is closest to spot (within 4×).
      const d100 = Math.abs(Math.log(c100 / s.spot));
      const d1 = Math.abs(Math.log(c1 / s.spot));
      const scaled = d100 <= d1 ? c100 : c1;
      if (Math.abs(Math.log(scaled / s.spot)) < Math.log(4)) {
        row.strike = scaled;
      } else {
        row.strike = c100; // sane default for the ×100 convention
      }
    } else {
      row.strike = strikeRawN / 100;
    }
  }
}

/** Spot + EMA for one asset; null when the price feed has no data. */
async function fetchSpotSafe(
  ex: SomniaMarkets,
  asset: string,
): Promise<{ spot: number; ema: number | null } | null> {
  try {
    const p = await ex.fetchPrice(asset);
    if (p && p.price != null) {
      return { spot: Number(p.price), ema: p.ema != null ? Number(p.ema) : null };
    }
  } catch {
    // price feed unavailable — model still runs with default vol
  }
  return null;
}

/**
 * Build a full view for a single market symbol (used by the analyze route
 * when the symbol is not in the cached top-N board).
 */
export async function buildViewForSymbol(symbol: string): Promise<MarketView> {
  const ex = await getExchange();
  const markets = await ex.loadMarkets(true);
  const m = markets[symbol];
  if (!m) throw new Error(`market not found on testnet: ${symbol}`);
  const row = parseSymbol(symbol, m);
  if (!row) throw new Error(`unparseable market symbol: ${symbol}`);
  const spot = await fetchSpotSafe(ex, row.asset);
  resolveStrikes([row], { [row.asset]: spot ?? { spot: 0, ema: null } });
  if (spot == null) {
    // No spot: keep null strike scale resolution honest (row.strike stays
    // as-is only when scale was resolvable; otherwise leave null).
    if (extractStrikeRaw(symbol) != null && row.strike == null) {
      row.strike = null; // strike unknown without spot — model uses up/down path
    }
  }
  return buildView(ex, row, spot, Date.now());
}

async function buildView(
  ex: SomniaMarkets,
  row: MarketRow,
  spot: { spot: number; ema: number | null } | null,
  now: number,
): Promise<MarketView> {
  let book: BookTop = {
    yesBid: null,
    yesAsk: null,
    depth: 0,
    timestamp: null,
    bids: [],
    asks: [],
  };
  let pImplied: number | null = null;
  try {
    const ob = await ex.fetchOrderBook(row.symbol, 5);
    const bids = (ob.bids ?? []) as [number, number][];
    const asks = (ob.asks ?? []) as [number, number][];
    book = {
      yesBid: bids.length ? bids[0][0] : null,
      yesAsk: asks.length ? asks[0][0] : null,
      depth:
        bids.slice(0, 5).reduce((s, l) => s + l[1], 0) +
        asks.slice(0, 5).reduce((s, l) => s + l[1], 0),
      timestamp: ob.timestamp ?? null,
      bids: bids.slice(0, 5),
      asks: asks.slice(0, 5),
    };
    if (book.yesBid != null && book.yesAsk != null) {
      pImplied = (book.yesBid + book.yesAsk) / 2;
    }
  } catch {
    // Book unavailable for this market — keep nulls; model still runs.
  }

  const secondsToExpiry = Math.round((row.expiresAtMs - now) / 1000);
  // Volatility: prefer realized vol from candles; fall back to default.
  let volAnnualized = DEFAULT_VOL[row.asset] ?? 0.45;
  let volSource: "candles" | "default" = "default";
  if (spot) {
    try {
      const candles = await ex.fetchPriceOHLCV(row.asset, "1m", undefined, 60);
      const vol = realizedVolAnnualized(candles);
      if (vol != null) {
        volAnnualized = vol;
        volSource = "candles";
      }
    } catch {
      // fall through to default
    }
  }

  // Up/down markets settle vs. the window open price, not the EMA.
  let openPrice: number | null = null;
  if (row.strike == null && row.tradingStartMs != null && spot) {
    try {
      const candles = await ex.fetchPriceOHLCV(
        row.asset,
        "1m",
        row.tradingStartMs,
        3,
      );
      const covering = candles.find(
        (c) => c[0] <= row.tradingStartMs! && row.tradingStartMs! < c[0] + 60_000,
      );
      const chosen = covering ?? candles[0];
      if (chosen && Number(chosen[1]) > 0) openPrice = Number(chosen[1]);
    } catch {
      // open unavailable — model falls back to EMA reference
    }
  }

  const model = modelYesProbability({
    asset: row.asset,
    spot: spot?.spot ?? 0,
    ema: spot?.ema ?? null,
    strike: row.strike,
    openPrice,
    secondsToExpiry,
    volAnnualized,
    volSource,
  });

  let edge: number | null = null;
  let edgeKind: MarketView["edgeKind"] = "n/a";
  if (pImplied != null) {
    const c = classifyEdge(model.pModel, pImplied);
    edge = c.edge;
    edgeKind = c.kind;
  }

  const risk =
    spot != null && book.timestamp != null
      ? riskScore({
          dSigma: model.dSigma,
          secondsToExpiry,
          bookDepth: book.depth,
          bookAgeMs: now - book.timestamp,
        })
      : null;

  let suggestion: MarketView["suggestion"] = null;
  if (book.yesBid != null && book.yesAsk != null) {
    suggestion = sizePosition({
      pModel: model.pModel,
      yesAsk: book.yesAsk,
      yesBid: book.yesBid,
      kellyFraction: PAPER.kellyFraction,
      maxPositionPct: PAPER.maxPositionPct,
    });
  }

  const upDown = row.strike == null;
  return {
    symbol: row.symbol,
    asset: row.asset,
    strike: row.strike,
    strikeLabel: upDown ? "up/down" : formatNum(row.strike, 2),
    upDown,
    expiresAt: row.expiresAt,
    secondsToExpiry,
    active: row.active,
    book,
    pImplied,
    model,
    edge,
    edgeKind,
    risk,
    suggestion,
    openPrice,
    question: row.question,
    spot: spot?.spot ?? null,
    ema: spot?.ema ?? null,
  };
}

/**
 * Realized annualized volatility from 1-minute close prices.
 * Exported so the scorecard backtest reuses the exact same estimator as the
 * live pipeline (no drift between the two).
 */
export function realizedVolAnnualized(
  candles: Array<[number, number, number, number, number, number]>,
): number | null {
  if (candles.length < 10) return null;
  const closes = candles.map((c) => c[4]).filter((x) => x != null && x > 0);
  if (closes.length < 10) return null;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const r = Math.log(closes[i] / closes[i - 1]);
    rets.push(r);
  }
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const varr = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / rets.length;
  const sd = Math.sqrt(varr);
  // 1-minute bars → annualize by sqrt(525600).
  const annualized = sd * Math.sqrt(525600);
  if (!(annualized > 0) || !Number.isFinite(annualized)) return null;
  // Clamp to a sane band (default fallback when the feed is noisy).
  return Math.min(3.0, Math.max(0.05, annualized));
}

function formatNum(x: number | null, digits: number): string {
  if (x == null) return "—";
  return x.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Spot/EMA for a single asset (used by the analyze route). */
export async function fetchAssetPrice(asset: string): Promise<{ spot: number; ema: number | null }> {
  const ex = await getExchange();
  const p = await ex.fetchPrice(asset);
  if (!p || p.price == null) {
    throw new Error(`no price for ${asset}`);
  }
  return { spot: Number(p.price), ema: p.ema != null ? Number(p.ema) : null };
}

/** 1m candles for the detail chart (newest last). Used by /api/chart. */
export async function fetchCandles(
  asset: string,
  limit = 90,
  sinceMs?: number,
): Promise<Array<[number, number, number, number, number, number]>> {
  const ex = await getExchange();
  const candles = await ex.fetchPriceOHLCV(asset, "1m", sinceMs, limit);
  return (candles ?? []).map(
    (c): [number, number, number, number, number, number] => [
      Number(c[0]),
      Number(c[1]),
      Number(c[2]),
      Number(c[3]),
      Number(c[4]),
      Number(c[5]),
    ],
  );
}

/** Re-export for the LLM layer (edge context). */
export { LLM as LLM_CFG };
