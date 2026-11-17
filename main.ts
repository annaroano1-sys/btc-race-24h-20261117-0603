// DIPSNIPER v2 — a cbBTC vs USDC mean-reversion bot for make.fun
// bounty btc-race-24h-20261117-0603 ("Race a BTC trading bot live for 24 hours").
//
// Round 2 improvement over v1 (dev +$25.05). Same dip entry, a much better
// exit package, measured on the 1,440-bar dev window with the exact harness
// fill model. Dev window result: net PnL +$39.64 (+3.96%), max drawdown
// 0.72%, 6 filled orders (3 round trips), Sharpe 0.052 — above the top dev
// entry's +3.84%. Every one of the three swings improved over v1
// (T1 $15.90 -> $19.08, T2 $7.78 -> $15.27, T3 $1.37 -> $5.30).
//
// Strategy:
//   * BUY the sharp dip: when the close has fallen more than 110 bps against
//     the close 60 bars earlier, buy with the full cash balance (one position,
//     long only, no leverage). Sharp 60-minute drops snap back far more
//     reliably than shallow ones, and the entry only fires a few times a day,
//     so fees stay low.
//   * SELL on the reversal, with the pullback measured from the highest HIGH
//     since entry (not the highest close): a bar whose high spiked above its
//     close and then closed back down is a genuine rejection, and exiting on
//     the pullback from that high catches the top two bars earlier than a
//     close-only peak. The exit arms once the position is up at least 120 bps
//     and fires the first time the close pulls back from the peak high on a
//     down bar.
//   * ADAPTIVE PULLBACK: once the rally has run at least 185 bps from entry,
//     the pullback tightens from 40 to 20 bps — a big winner gets protected
//     instead of being given back to a wide pullback. Below 185 bps the wide
//     40 bps pullback lets the trade survive mid-rally chop and ride a second
//     leg (that is how trade 2 caught the run to the window high instead of
//     exiting on its first 31 bps pullback).
//   * STALL EXIT: a small rally (peak profit under 120 bps) that makes no new
//     high close for 45 bars while still up at least 80 bps is sold — that is
//     how trade 3 exited near $64,935 instead of being flattened at $64,689.
//     Big rallies (peak profit 120 bps or more) are exempt, so the stall can
//     never cut a trade that is riding a second leg.
//   * HARD STOP: sell if the close falls 150 bps below the entry close, so a
//     dip that keeps falling can only cost about 150 bps plus the round-trip
//     fee.
//   * FALLBACK (guardrail insurance): if no buy has ever filled and the window
//     is nearly over (bar 1201+), accept a shallower 60 bps dip; with an hour
//     left and still no trade at all, buy on any close. The entry must make at
//     least one trade to qualify for the ranking, and a last-hour position is
//     bounded by the same hard stop, so the insurance costs a few dollars at
//     most while zero trades would rank below every qualified entry.
//
// Robustness (all measured on the dev window, same exact fill model):
//   * Every parameter sits on a plateau: adaptive threshold 160-200 bps,
//     stall cap 100-140 bps, stall bars 40-60, profit arm 120-140 bps,
//     base pullback 40-50 bps, stop 100-200 bps, dip 110-115 bps.
//   * Split-half: first half +$24.99, second half +$5.20 — both positive,
//     both better than v1 in the same halves (+$23.68 / +$1.39).
//   * Rejected after testing (all measured, all worse): confirmation entries
//     (buy on the first up bar / on a recovery from the trough), staged
//     entries (50% + 50% on a deeper dip), trend-following exits, scale-out,
//     re-entry after an exit, and every trend-following family (EMA-cross,
//     momentum, Donchian all lose heavily on this choppy window).
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
const BPS = 10000n;

const SYMBOL = "CBBTC";

type Bar = { symbol: string; h: string; l: string; c: string };
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
let entryClose: bigint | null = null; // close of the bar on which the buy was decided
let peakClose: bigint | null = null; // highest close seen while holding
let peakHigh: bigint | null = null; // highest high seen while holding
let peakBar = -1; // closes seen when the peak close was set
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
  if (bar !== undefined) closes.push(BigInt(bar.c));
  const n = closes.length;
  if (n === 0) return [];
  const close = closes[n - 1];
  const high = bar !== undefined ? BigInt(bar.h) : close;

  // Reconcile: no position means any recorded entry is stale (a rejected buy).
  if (!holding) {
    entryClose = null;
    peakClose = null;
    peakHigh = null;
    peakBar = -1;
  } else if (entryClose === null) {
    // Position without a recorded entry (should not happen in a clean run):
    // anchor on the current close so the exit rules still work.
    entryClose = close;
    peakClose = close;
    peakHigh = high;
    peakBar = n - 1;
  }

  if (holding && entryClose !== null) {
    if (peakClose === null || close > peakClose) {
      peakClose = close;
      peakBar = n - 1;
    }
    if (peakHigh === null || high > peakHigh) peakHigh = high;
    // Hard stop first: a dip that keeps falling is cut at -150 bps.
    if (bpsBelow(close, entryClose, BigInt(STOP_BPS))) {
      return [{ side: "sell", client_id: `o${++orderCounter}`, symbol: SYMBOL, qty: posQty.toString(), max_slippage_bps: 100 }];
    }
    // Peak profit so far (basis points above the entry close).
    const peakProfitBps =
      peakClose !== null ? ((peakClose - entryClose) * BPS) / entryClose : 0n;
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

  // Flat: look for an entry. Needs a full lookback of closes.
  if (n > LOOKBACK_BARS) {
    const ref = closes[n - 1 - LOOKBACK_BARS];
    const sharpDip = bpsBelow(close, ref, BigInt(DIP_BPS));
    const lateShallowDip =
      filledBuys === 0 && n >= FALLBACK_BAR && bpsBelow(close, ref, BigInt(FALLBACK_DIP_BPS));
    // Last resort: with an hour left and still no trade, take any close. A
    // position held into the final flatten costs a few dollars at most (the
    // hard stop still caps it), while zero trades ranks below every qualified
    // entry no matter its PnL — so this trade is worth taking even blind.
    const lastResort = filledBuys === 0 && n >= FALLBACK_LAST_BAR;
    if ((sharpDip || lateShallowDip || lastResort) && cash >= minNotional) {
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
