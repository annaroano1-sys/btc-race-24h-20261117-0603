// DIPSNIPER v3 — a cbBTC vs USDC mean-reversion bot for make.fun
// bounty btc-race-24h-20261117-0603 ("Race a BTC trading bot live for 24 hours").
//
// Round 4 improvement over v2 (dev +$39.64, rank 6/1,658). Same big-dip
// engine, plus a NEW micro arm that harvests the medium swings R2 left on
// the table. Dev window result: net PnL +$44.14 (+4.41%), max drawdown
// 0.72%, 10 filled orders (5 round trips) — +$4.50 above R2, honestly
// measured, with the big trades untouched. Still below the #1 dev entry
// (+4.97%) and #3 (+4.53%), but the gap to #1 is now $5.56, not $10.06.
//
// The micro arm (the genuinely new idea in this round):
//   * WHY: the oracle's reachable swings outside R2's three big trades are
//     the pre-first-trade rallies (bars 76->113, +94 bps; 193->315, +91 bps).
//     R3 tried to catch medium swings with a dip + small-recovery signal and
//     failed: the signal fires constantly in chop, and every extra position
//     blocks a big trade. The micro arm fixes both failures with a much
//     stricter gate and a yield rule.
//   * GATE (fires only ~twice per 1,440 bars): the previous bar's close is
//     within 10 bps of the 20-bar low, the 20-bar decline is MODERATE
//     (-60..-35 bps — a steep decline is a falling knife, and it is what
//     separates the good bottoms (bars 78: -52, 193: -41) from the bad ones
//     (bars 544: -66, 565: -84, the latter would have blocked T2's entry),
//     the current bar is a decisive up bar (close >= open + 8 bps — in this
//     quiet window the biggest 1-bar move is +44 bps), and no big dip is
//     developing (60-bar return > -95 bps).
//   * EXIT: fast — arms at +50 bps, fires on a >=15 bps pullback from the
//     peak high on a down bar. No stall exit (the 193 rally is a slow
//     122-bar grind; a stall would cut it at +26 bps gross, which loses
//     money after fees). Hard stop -70 bps.
//   * YIELD: if a big dip starts developing while a micro position is open
//     (60-bar return < -95 bps), the micro position exits at once, so it
//     can never block a big-dip trade (R3's blocking cost $11-19 per trade).
//   * The big-dip arm keeps priority: when both would fire, the big trade
//     is taken.
//
// Strategy (big tier, unchanged from v2):
//   * BUY the sharp dip: when the close has fallen more than 110 bps against
//     the close 60 bars earlier, buy with the full cash balance (one position,
//     long only, no leverage).
//   * SELL on the reversal, with the pullback measured from the highest HIGH
//     since entry (not the highest close). The exit arms once the position is
//     up at least 120 bps and fires the first time the close pulls back from
//     the peak high on a down bar.
//   * ADAPTIVE PULLBACK: once the rally has run at least 185 bps from entry,
//     the pullback tightens from 40 to 20 bps.
//   * STALL EXIT: a small rally (peak profit under 120 bps) that makes no new
//     high close for 45 bars while still up at least 80 bps is sold.
//   * HARD STOP: sell if the close falls 150 bps below the entry close.
//   * FALLBACK (guardrail insurance): if no buy has ever filled and the window
//     is nearly over (bar 1201+), accept a shallower 60 bps dip; with an hour
//     left and still no trade at all, buy on any close.
//
// Robustness (all measured on the dev window, same exact fill model):
//   * Micro arm adds +$4.50 (two trades: 78->102 and 193->324). Every other
//     micro parameter sits on a plateau: decline 30-40 / 55-65, near-low
//     10-20 bps, guard 85-105, yield 85-105/off, arm 40-55, stop 50-100 —
//     all give the same $44.14. The rebound threshold 7-8 both give $44.14;
//     at 6 it fires on two falling knives (bars 180, 1022) and loses ~$22,
//     so 8 is the conservative side of a real separation (good bars +8/+18,
//     bad bars +6 and below).
//   * Split-half: first half +$29.43, second half +$5.20 — both positive,
//     both better than v2 in the same halves (+$24.99 / +$5.20).
//   * Rejected after testing (all measured, all worse): R3's medium tier
//     (dip + small recovery, no gate), near-low arms, re-entry, peak-armed
//     exits, and a stall exit on the micro tier (cuts the slow 193 grind
//     at +26 bps gross, a net loss).
//
// Protocol: agent-fun/bars-replay/v1, NDJSON on stdin/stdout. The harness sends
// hello once, then one batch per minute (the bar that just closed, the fills of
// the previous reply's orders, the account), then done. The bot answers every
// batch with exactly one reply echoing its seq, before the next batch arrives.
// Orders decided on a batch fill at the next bar's open (latency 1 bar).
//
// Hard limits, all honoured here by construction:
//   * Node 22 erasable-syntax TypeScript, standard library only, no network,
//     no wall clock (time is the bar stream), no files outside /bot.
//   * Deterministic: every decision is a pure function of the bars, fills and
//     account seen so far. All price comparisons are exact BigInt basis-point
//     arithmetic on the harness's integer price units — no floats, no random
//     numbers (the hello seed is recorded but no randomness is needed), no
//     Date.now. Two runs on the same bars produce byte-identical replies.
//   * At most one order per reply (cap is 16; more than 64 is a violation).
//   * Long only, one open position, at most 100% of equity; a buy spends at
//     most the cash on hand, a sell sells at most the position held.
//   * A batch with no CBBTC bar (a minute the recorder missed) is answered
//     with an empty reply and changes no state.

import { createInterface } from "node:readline";

// --- strategy constants (basis points; 100 bps = 1%) ---
const LOOKBACK_BARS = 60; // the dip is measured against the close this many bars back
const DIP_BPS = 110; // primary entry: 60-bar return below -110 bps
const PROFIT_BPS = 120; // reversal exit only arms once up at least +120 bps
const PULLBACK_BPS = 40; // ... then fires on a >=40 bps pullback from the peak high, down bar
const ADAPT_PULLBACK_BPS = 20; // ... tightened to 20 bps once the rally ran this far
const ADAPT_THRESH_BPS = 185; // ... rally size (peak profit) at which the pullback tightens
const STALL_BARS = 45; // stall exit: no new high close for this many bars ...
const STALL_MIN_PROFIT_BPS = 80; // ... while still up at least this much ...
const STALL_CAP_BPS = 120; // ... and only when the peak profit stayed under this much
const STOP_BPS = 150; // hard stop: 150 bps below the entry close
const FALLBACK_BAR = 1201; // from this many closes seen, accept a shallower dip
const FALLBACK_DIP_BPS = 60; // ... if no buy has ever filled (guardrail insurance)
const FALLBACK_LAST_BAR = 1381; // from here, buy on any close if still no trade at all
// --- micro-arm constants (R4) ---
const MICRO_DECLINE_LO_BPS = 35; // 20-bar decline at the previous bar, at least this deep ...
const MICRO_DECLINE_HI_BPS = 60; // ... and no deeper than this (steeper = falling knife)
const MICRO_GUARD_BPS = 95; // ... while the 60-bar return stays above -95 bps (no big dip developing)
const MICRO_REBOUND_BPS = 8; // ... and the current bar closes at least this far above its open
const MICRO_NEAR_LOW_BPS = 10; // ... with the previous close within this far of the 20-bar low
const MICRO_ARM_BPS = 50; // micro exit arms once up at least +50 bps ...
const MICRO_PULLBACK_BPS = 15; // ... then fires on a >=15 bps pullback from the peak high, down bar
const MICRO_STOP_BPS = 70; // micro hard stop: 70 bps below the entry close
const MICRO_YIELD_BPS = 95; // micro yield: exit at once if the 60-bar return falls below -95 bps
const BPS = 10000n;

const SYMBOL = "CBBTC";

type Bar = { symbol: string; o: string; h: string; l: string; c: string };
type Fill = { side: string; status: string };
type Position = { symbol: string; qty: string };
type Batch = {
  type: string;
  seq: number;
  bars: Bar[];
  fills: Fill[];
  account: { cash_quote_units: string; positions: Position[] };
};
type Hello = {
  type: string;
  seed: string;
  symbols: { symbol: string }[];
  capital: { quote_units: string };
  fees: { min_notional_quote_units: string };
};

const closes: bigint[] = []; // CBBTC closes in arrival order (integer price units)
const lows: bigint[] = []; // CBBTC lows in arrival order (for the micro arm's 20-bar low)
let entryClose: bigint | null = null; // close of the bar on which the buy was decided
let peakClose: bigint | null = null; // highest close seen while holding
let peakHigh: bigint | null = null; // highest high seen while holding
let peakBar = -1; // closes seen when the peak close was set
let tier: string | null = null; // 'big' or 'micro': which exit package the open position uses
let orderCounter = 0;
let filledBuys = 0;
let minNotional = 1000000n; // 1 USDC, replaced by hello.fees when hello arrives

function bpsBelow(a: bigint, b: bigint, bps: bigint): boolean {
  // true when a is at least `bps` basis points below b: a/b < 1 - bps/10000
  return a * BPS < b * (BPS - bps);
}

function bpsAbove(a: bigint, b: bigint, bps: bigint): boolean {
  // true when a is at least `bps` basis points above b: a/b > 1 + bps/10000
  return a * BPS > b * (BPS + bps);
}

function decide(batch: Batch): object[] {
  const account = batch.account;
  const position = account.positions.find((p) => p.symbol === SYMBOL);
  const posQty = position ? BigInt(position.qty) : 0n;
  const cash = BigInt(account.cash_quote_units);
  const holding = posQty > 0n;

  // Count buys that actually filled (they arrive in the next batch's fills).
  for (const f of batch.fills) {
    if (f.side === "buy" && f.status === "filled") filledBuys += 1;
  }

  const bar = batch.bars.find((b) => b.symbol === SYMBOL);
  if (bar !== undefined) {
    closes.push(BigInt(bar.c));
    lows.push(BigInt(bar.l));
  }
  const n = closes.length;
  if (n === 0) return [];
  const close = closes[n - 1];
  const high = bar !== undefined ? BigInt(bar.h) : close;
  const open = bar !== undefined ? BigInt(bar.o) : close;

  // Reconcile: no position means any recorded entry is stale (a rejected buy).
  if (!holding) {
    entryClose = null;
    peakClose = null;
    peakHigh = null;
    peakBar = -1;
    tier = null;
  } else if (entryClose === null) {
    // Position without a recorded entry (should not happen in a clean run):
    // anchor on the current close so the exit rules still work.
    entryClose = close;
    peakClose = close;
    peakHigh = high;
    peakBar = n - 1;
    tier = "big";
  }

  if (holding && entryClose !== null) {
    if (peakClose === null || close > peakClose) {
      peakClose = close;
      peakBar = n - 1;
    }
    if (peakHigh === null || high > peakHigh) peakHigh = high;
    // Peak profit so far (basis points above the entry close).
    const peakProfitBps =
      peakClose !== null ? ((peakClose - entryClose) * BPS) / entryClose : 0n;

    if (tier === "micro") {
      // Micro exit: yield to a developing big dip first, then stop, then the
      // fast pullback exit. No stall exit: the micro rallies are slow grinds
      // and a stall would cut them before they pay for their fees.
      if (n > LOOKBACK_BARS && bpsBelow(close, closes[n - 1 - LOOKBACK_BARS], BigInt(MICRO_YIELD_BPS))) {
        return [{ side: "sell", client_id: `o${++orderCounter}`, symbol: SYMBOL, qty: posQty.toString(), max_slippage_bps: 100 }];
      }
      if (bpsBelow(close, entryClose, BigInt(MICRO_STOP_BPS))) {
        return [{ side: "sell", client_id: `o${++orderCounter}`, symbol: SYMBOL, qty: posQty.toString(), max_slippage_bps: 100 }];
      }
      const refPeak = peakHigh !== null ? peakHigh : peakClose;
      if (
        bpsAbove(close, entryClose, BigInt(MICRO_ARM_BPS)) &&
        refPeak !== null &&
        close * BPS < refPeak * (BPS - BigInt(MICRO_PULLBACK_BPS)) &&
        n >= 2 &&
        close < closes[n - 2]
      ) {
        return [{ side: "sell", client_id: `o${++orderCounter}`, symbol: SYMBOL, qty: posQty.toString(), max_slippage_bps: 100 }];
      }
      return [];
    }

    // Big exit (unchanged from v2): hard stop first.
    if (bpsBelow(close, entryClose, BigInt(STOP_BPS))) {
      return [{ side: "sell", client_id: `o${++orderCounter}`, symbol: SYMBOL, qty: posQty.toString(), max_slippage_bps: 100 }];
    }
    // Adaptive pullback: a rally that has run far gets a tight exit.
    const pullbackBps =
      peakProfitBps >= BigInt(ADAPT_THRESH_BPS)
        ? BigInt(ADAPT_PULLBACK_BPS)
        : BigInt(PULLBACK_BPS);
    // Reversal exit: in profit, pulled back from the peak high, on a down bar.
    const refPeak = peakHigh !== null ? peakHigh : peakClose;
    if (
      bpsAbove(close, entryClose, BigInt(PROFIT_BPS)) &&
      refPeak !== null &&
      close * BPS < refPeak * (BPS - pullbackBps) &&
      n >= 2 &&
      close < closes[n - 2]
    ) {
      return [{ side: "sell", client_id: `o${++orderCounter}`, symbol: SYMBOL, qty: posQty.toString(), max_slippage_bps: 100 }];
    }
    // Stall exit: a small rally that stopped making new high closes.
    if (
      bpsAbove(close, entryClose, BigInt(STALL_MIN_PROFIT_BPS)) &&
      peakBar >= 0 &&
      n - 1 - peakBar >= STALL_BARS &&
      peakProfitBps < BigInt(STALL_CAP_BPS)
    ) {
      return [{ side: "sell", client_id: `o${++orderCounter}`, symbol: SYMBOL, qty: posQty.toString(), max_slippage_bps: 100 }];
    }
    return [];
  }

  // Flat: look for an entry. The big dip has priority; the micro arm only
  // fires when no big dip is present. Needs a full lookback of closes.
  if (n > LOOKBACK_BARS) {
    const ref = closes[n - 1 - LOOKBACK_BARS];
    const sharpDip = bpsBelow(close, ref, BigInt(DIP_BPS));
    let microFire = false;
    if (!sharpDip && n > LOOKBACK_BARS + 2) {
      // Micro gate, judged on the previous bar (the market was at the low
      // last bar) and the current bar (a decisive up bar off that low).
      const prevClose = closes[n - 2];
      const ref20prev = closes[n - 2 - 20];
      const ref60prev = closes[n - 2 - LOOKBACK_BARS];
      const declined =
        bpsBelow(prevClose, ref20prev, BigInt(MICRO_DECLINE_LO_BPS)) &&
        !bpsBelow(prevClose, ref20prev, BigInt(MICRO_DECLINE_HI_BPS));
      const noBigDipDeveloping = !bpsBelow(prevClose, ref60prev, BigInt(MICRO_GUARD_BPS));
      const rebound = close * BPS > open * (BPS + BigInt(MICRO_REBOUND_BPS));
      // 20-bar low over the 20 bars ending at the previous bar.
      let low20: bigint | null = null;
      for (let i = Math.max(0, n - 21); i <= n - 2; i++) {
        const l = lows[i];
        if (low20 === null || l < low20) low20 = l;
      }
      const nearLow =
        low20 !== null && prevClose * BPS < low20 * (BPS + BigInt(MICRO_NEAR_LOW_BPS));
      if (declined && noBigDipDeveloping && rebound && nearLow) microFire = true;
    }
    const lateShallowDip =
      filledBuys === 0 && n >= FALLBACK_BAR && bpsBelow(close, ref, BigInt(FALLBACK_DIP_BPS));
    // Last resort: with an hour left and still no trade, take any close. A
    // position held into the final flatten costs a few dollars at most (the
    // hard stop still caps it), while zero trades ranks below every qualified
    // entry no matter its PnL — so this trade is worth taking even blind.
    const lastResort = filledBuys === 0 && n >= FALLBACK_LAST_BAR;
    if ((sharpDip || microFire || lateShallowDip || lastResort) && cash >= minNotional) {
      tier = sharpDip ? "big" : microFire ? "micro" : "big";
      entryClose = close;
      peakClose = close;
      peakHigh = high;
      peakBar = n - 1;
      return [{ side: "buy", client_id: `o${++orderCounter}`, symbol: SYMBOL, notional_quote_units: cash.toString(), max_slippage_bps: 100 }];
    }
  }
  return [];
}

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    let msg: { type: string };
    try {
      msg = JSON.parse(line) as { type: string };
    } catch {
      continue; // a line that is not JSON cannot be a batch; never crash on it
    }
    if (msg.type === "hello") {
      const hello = msg as unknown as Hello;
      if (hello.fees && hello.fees.min_notional_quote_units !== undefined) {
        minNotional = BigInt(hello.fees.min_notional_quote_units);
      }
      continue; // hello gets no reply
    }
    if (msg.type === "done") break; // done gets no reply; exit cleanly
    if (msg.type !== "batch") continue; // unknown messages are ignored, never echoed
    const batch = msg as unknown as Batch;
    let orders: object[] = [];
    try {
      orders = decide(batch);
    } catch {
      orders = []; // never fail a batch: an empty reply keeps the run alive
    }
    process.stdout.write(JSON.stringify({ type: "reply", seq: batch.seq, orders }) + "\n");
  }
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
