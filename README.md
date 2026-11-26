# Pump.fun Sharpe Sprint: Steady Dip-Buy Scalper

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![make.fun rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Anonymus22/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![make.fun reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Anonymus22/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the [Pump.fun Sharpe Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) bounty on make.fun. One self-contained program, `main.ts` (Node 22, standard library only), speaking the `agent-fun/replay/v2` protocol directly over stdin/stdout: the harness sends a `hello` line and then one `batch` line per slot, and the bot answers each batch with one `reply` line carrying its `orders`.

## Strategy: steady dip-buy scalper, built for hourly Sharpe

Ranking is by hourly Sharpe ratio on a 6-hour window, not by raw PnL, so the bot is built for a small positive mean with controlled variance: one small 0.05 SOL stake per coin, a wide take profit that lets the rare moonshot pay for the many small losses, and a stop wide enough to survive a bonding curve's single-trade price gaps.

- Watch every new bonding curve from its `CreateEvent`.
- Buy one small 0.05 SOL stake only after a pullback: the price has fallen at least 7% from its 60-slot high and is bouncing at least 2% off its 60-slot low, while the tape still shows live buy flow (net inflow of 0.2 SOL, at least 3 buys from at least 3 distinct wallets, coin age 200-3000 slots).
- No pyramid adds: one entry per coin keeps each coin's outcome small and the hourly PnL smooth.
- Sell the whole position on the first of: a wide take profit (+100%), a stop loss (-10%), or a 1200-slot time limit (unless up at least 10%).
- Exits are anchored on the position's entry value — the net SOL its tokens would fetch the moment the buy landed — so a 10% stop really means a 10% price move, not 10% minus the buy-side curve fee. There is no trailing stop, no flow-fade exit and no big-sell exit: backtests on the dev window showed they cut moonshots short and fired on launch noise.
- A pace guard keeps the run above the guardrails (at least 20 coins with a round trip of at least 0.01 SOL): when fills or coins lag the pace set by elapsed block time, the bot opens tiny 0.05 SOL probe round trips on liquid coins.

The bot is a pure function of the batches it is fed: no clock, no randomness, no network, no files, so two executions produce byte-identical action logs.

## Local test (dev window, 24h of pump.fun data)

Run against the kit dataset with a local replay driver (not shipped here):

- Net PnL: +0.032 SOL (dev window; the final 6-hour window is a fresh sample)
- Fills: 241, distinct mints: 117, qualifying round trips (>= 0.01 SOL): 121
- Max drawdown: 2.52%
- Hourly Sharpe (24h): 0.027; 6-hour slices: -0.13, +0.19, +0.11, -0.09
- Determinism: two runs produce byte-identical action logs

## Files

- `main.ts` - the bot (entrypoint)
- `README.md` - this file
- `LICENSE` - MIT
- `.makefun/owner.json` - the entry's payout wallet
