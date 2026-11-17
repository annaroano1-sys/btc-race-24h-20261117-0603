# DIPSNIPER — cbBTC vs USDC trading bot

[![make.fun](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/competitions/btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/annaroano1-sys/btc-race-24h-20261117-0603/rank.svg)](https://make.fun/competitions/btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/annaroano1-sys/btc-race-24h-20261117-0603/reward.svg)](https://make.fun/competitions/btc-race-24h-20261117-0603)

A mean-reversion bot for the [make.fun bounty "Race a BTC trading bot live for 24 hours"](https://make.fun/competitions/btc-race-24h-20261117-0603): it trades Coinbase Wrapped BTC (cbBTC) against USDC, minute by minute, starting from 1,000 USDC of paper money, long only, no leverage.

## Strategy

1. **Buy the sharp dip.** When the close has fallen more than 110 bps against the close 60 bars earlier, buy with the full cash balance. Sharp one-hour drops snap back far more reliably than shallow ones, and the signal only fires a few times a day, so fees stay low.
2. **Sell on the reversal.** Once the position is up at least 100 bps from the entry close, sell everything the first time the close pulls back at least 30 bps from the highest close since entry on a down bar. That exits near the top of the snap-back instead of giving the move back to a trailing stop.
3. **Hard stop.** Sell if the close falls 150 bps below the entry close, so a dip that keeps falling can only cost about 150 bps plus the round-trip fee.
4. **Fallback (guardrail insurance).** If no buy has ever filled and the window is nearly over, accept a shallower 60 bps dip (from bar 1201); with an hour left and still no trade at all, buy on any close. An entry needs at least one trade to qualify for the ranking.

## Dev window result (1,440 one-minute bars, exact harness fill model)

| Metric | Value |
|---|---|
| Net PnL | **+$25.05 (+2.51%)** |
| Max drawdown | 0.85% |
| Trades (filled orders) | 5 |
| Fees paid | $2.44 |
| Sharpe (per-bar) | 0.037 |
| Dev gate (net PnL > 0) | PASS |
| Guardrails (≥1 trade, DD ≤ 25%) | PASS |

The bot was picked from ~100 candidate strategies tested on the dev window (EMA-cross, momentum, Donchian, Bollinger/RSI, trailing-stop and scale-out variants all lost money or earned less in this choppy window). The winning family is deliberately simple and robust: few trades, big moves only, tiny drawdown. It does not chase the top dev entry (+3.84%), which sits at 92% of the perfect-foresight oracle for 4 orders — reaching it causally would need near-perfect timing on both big swings, i.e. overfitting. On a live day with bigger swings this same setup scales with the size of the moves.

## How it works

`main.ts` speaks the `agent-fun/bars-replay/v1` protocol: newline-delimited JSON on stdin/stdout. The harness sends `hello` once, then one `batch` per minute (the bar that just closed, the fills of the previous reply's orders, the account), then `done`. The bot answers every batch with exactly one reply echoing its `seq`, before the next batch arrives. Orders decided on a batch fill at the next bar's open.

- Node 22 erasable-syntax TypeScript, standard library only, no network, no wall clock (time is the bar stream), no files outside `/bot`.
- Deterministic: every decision is a pure function of the bars, fills and account seen so far. All price comparisons are exact BigInt basis-point arithmetic on the harness's integer price units — no floats, no random numbers. Two runs on the same bars produce byte-identical replies (verified: identical SHA-256 over all 1,440 replies).
- At most one order per reply (cap is 16). Long only, one open position, at most 100% of equity. A batch with no CBBTC bar is answered with an empty reply and changes no state.

## Run it

```sh
node main.ts
```

Feed it the protocol on stdin (see `protocol.schema.json` in the bounty kit); it writes one `reply` per `batch` to stdout and exits cleanly on `done`.
