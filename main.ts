// Pump.fun Sharpe Sprint: steady dip-buy scalper for agent-fun/replay/v2.
//
// Ranking is by HOURLY Sharpe ratio on a 6-hour window, not by raw PnL, so this bot
// is built for a small positive mean with controlled variance: one small 0.05 SOL
// stake per coin, a wide take profit that lets the rare moonshot pay for the many
// small losses, and a stop that is wide enough to survive the bonding curve's
// single-trade price gaps. A prize still needs net PnL above 0, so every trade
// must clear its fees first.
//
// Strategy, in one paragraph: watch every new bonding curve from its CreateEvent and
// buy one small 0.05 SOL stake only after a pullback — the price has fallen at least
// 7% from its 60-slot high and is bouncing at least 2% off its 60-slot low — while
// the tape still shows live buy flow (net inflow of 0.2 SOL, at least 3 buys from at
// least 3 distinct wallets). No pyramid adds: one entry per coin keeps each coin's
// outcome small and the hourly PnL smooth. Every position is sold whole on the first
// of a wide take profit (+100%), a stop loss (-10%), or a time limit (1200 slots
// unless up at least 10%). Exits are anchored on the position's entry value — the
// net SOL its tokens would fetch the moment the buy landed — so a 10% stop really
// means a 10% price move, not 10% minus the buy-side curve fee. There is no trailing
// stop, no flow-fade exit and no big-sell exit: backtests on the dev window showed
// they cut moonshots short and fired on launch noise. A pace guard keeps the run
// above the guardrails (at least 20 coins with a round trip of at least 0.01 SOL):
// when fills or coins lag the pace set by elapsed block time, the bot opens tiny
// probe round trips on liquid coins.
//
// The bot is a pure function of the batches it is fed: no clock, no randomness, no
// I/O beyond the replay protocol on stdin/stdout, so two executions produce
// byte-identical action logs. It speaks the protocol directly: the harness sends a
// hello line, then one batch line per slot (each with a seq, a slot, events, marks,
// fills and the account), and the bot answers each batch with exactly one reply line
// carrying its orders for that slot. Orders decided on the batch for slot s fill at
// slot s + latency_slots, so every decision is priced off the reserves the batch
// reports, with slippage room for the two slots of drift in between.

// ---------------------------------------------------------------- constants

const LAMPORTS_PER_SOL = 1000000000n;
const BPS = 10000n;

// Curve fee on every trade: protocol 95 bps + creator 30 bps = 125 bps, from hello.fees.
const CURVE_FEE_BPS = 125n;

// Entry: a young coin pulling back, then bouncing, with live buy flow.
const ENTRY_WINDOW = 60; // slots of tape the entry signal reads
const MIN_AGE = 200; // slots since CreateEvent before a first buy
const MAX_AGE = 3000; // slots since CreateEvent after which no first buy
const MIN_REAL_SOL = 1; // real SOL reserve at entry, lower bound
const MAX_REAL_SOL = 80; // real SOL reserve at entry, upper bound
const PULLBACK = 0.07; // price must be at least this far below the window high
const BOUNCE = 0.02; // price must be at least this far above the window low
const MIN_NET_SOL = 0.2; // net buy SOL (buys minus sells) over the entry window
const MIN_BUYS = 3; // buy trades in the entry window
const MIN_BUYERS = 3; // distinct buying wallets in the entry window
const MAX_TOP_SHARE = 0.7; // largest single buyer's share of window buy SOL
const FRESH_SLOTS = 10; // a trade must have landed within this many slots

// Sizing: one small buy per coin, no adds.
const FIRST_BUY_SOL = 0.05;
const MIN_BUY_SOL = 0.01; // never send a buy below the guardrail round-trip size

// Exits: wide take profit, stop loss wide enough to survive single-trade gaps.
const STOP_LOSS = 0.1; // sell when close value falls this far below entry value
const TAKE_PROFIT = 1.0; // sell when close value rises this far above entry value
const MAX_HOLD = 1200; // slots held before the time exit, unless well up
const HOLD_IF_UP = 0.1; // the time exit does not apply while up at least this much
const COOLDOWN = 300; // slots to wait after an exit before re-entering the same coin
const MAX_ENTRIES = 1; // most first buys per coin over the run

// Guardrail pacing: tiny probe round trips when fills or coins lag the pace.
const TARGET_COINS = 30;
const TARGET_FILLS = 60;
const PACE_SECS = 21600; // 6 hours, the scored window length
const PROBE_SOL = 0.05;
const MAX_PROBES = 1;
const PROBE_MIN_REAL_SOL = 2; // probe only coins holding at least this much real SOL

const BUY_SLIP_BPS = 2000; // slippage room on buys for the latency drift
const SELL_SLIP_BPS = 10000; // sells always go out wide open: an exit must land

// ---------------------------------------------------------------- wire types

type Pubkey = string;

interface HelloMsg {
  type: 'hello';
  protocol: string;
  seed: string;
  capital: { lamports: string };
  caps: {
    max_open_positions: number;
    max_order_bps_of_real_reserve: number;
    max_orders_per_batch: number;
    shorts: boolean;
    leverage: boolean;
  };
  latency_slots: number;
  fees: {
    protocol_bps_fallback: number;
    creator_bps_fallback: number;
    base_fee_lamports: string;
    priority_fee_lamports: string;
    failed_tx_bps: number;
  };
}

interface TradeEv {
  event: 'TradeEvent';
  mint: Pubkey;
  sol_amount: string;
  token_amount: string;
  is_buy: boolean;
  user: Pubkey;
  virtual_sol_reserves: string;
  virtual_token_reserves: string;
  real_sol_reserves: string;
  real_token_reserves: string;
  slot: number;
  block_time: number | null;
}

interface CreateEv {
  event: 'CreateEvent';
  mint: Pubkey;
  virtual_token_reserves: string;
  virtual_sol_reserves: string;
  real_token_reserves: string;
  slot: number;
  block_time: number | null;
}

interface CompleteEv {
  event: 'CompleteEvent';
  mint: Pubkey;
  slot: number;
  block_time: number | null;
}

type ChainEv = TradeEv | CreateEv | CompleteEv;

interface MarkMsg {
  mint: Pubkey;
  slot: number;
  virtual_token_reserves: string;
  virtual_quote_reserves: string;
  real_token_reserves: string;
  real_quote_reserves: string;
}

interface FillMsg {
  client_id: string;
  mint: Pubkey;
  side: 'buy' | 'sell';
  status: 'filled' | 'rejected' | 'failed';
  reason: string | null;
  decided_slot: number;
  slot: number;
  quote_lamports: string;
  token_amount: string;
}

interface PositionMsg {
  mint: Pubkey;
  token_amount: string;
  cost_lamports: string;
}

interface BatchMsg {
  type: 'batch';
  seq: number;
  slot: number;
  events: ChainEv[];
  marks: MarkMsg[];
  fills: FillMsg[];
  account: { cash_lamports: string; positions: PositionMsg[] };
}

interface DoneMsg {
  type: 'done';
  seq: number;
  reason: string;
  account: { cash_lamports: string; positions: PositionMsg[] };
}

interface BuyOrder {
  side: 'buy';
  client_id: string;
  mint: Pubkey;
  quote_lamports: string;
  max_slippage_bps: number;
}

interface SellOrder {
  side: 'sell';
  client_id: string;
  mint: Pubkey;
  token_amount: string;
  max_slippage_bps: number;
}

type Order = BuyOrder | SellOrder;

// ---------------------------------------------------------------- per-mint tape

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  entryValue: number; // SOL, net sell value of the position when the buy landed
  invested: number; // SOL sent in buys for this position (fees included)
  exiting: boolean;
  filled: boolean;
}

// ---------------------------------------------------------------- helpers

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
const feeOf = (amount: bigint, bps: bigint): bigint => ceilDiv(amount * bps, BPS);

// Price of one token in SOL, as a plain number (a ratio of two reserve counts).
function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

// SOL the bot would walk away with for selling `tokens` at these reserves, after the
// curve fee and one transaction fee. Mirrors the harness: quote out is t * vq / (vt + t).
function sellValueSol(tokens: bigint, vq: bigint, vt: bigint, txFee: bigint): number {
  if (tokens === 0n || vt === 0n) return 0;
  const q = (tokens * vq) / (vt + tokens);
  const fee = feeOf(q, CURVE_FEE_BPS);
  const net = q - fee - txFee;
  if (net <= 0n) return 0;
  return Number(net) / Number(LAMPORTS_PER_SOL);
}

// ---------------------------------------------------------------- the bot

let hello: HelloMsg | null = null;
let nextClient = 1;

const curves = new Map<Pubkey, {
  created: number | null;
  vq: bigint;
  vt: bigint;
  rq: bigint;
  rt: bigint;
  complete: boolean;
}>();

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
const probes = new Map<Pubkey, boolean>(); // mint -> true once its probe sell is queued
let myFills = 0;
const myCoins = new Set<Pubkey>();
let firstTime: number | null = null;
let lastTime: number | null = null;

function tapeOf(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, trades: [], entries: 0, lastExit: -1000000000 };
    tapes.set(mint, t);
  }
  return t;
}

function freshClientId(): string {
  const id = 'o' + String(nextClient);
  nextClient++;
  return id;
}

// The entry signal on a tape at slot `now`, given the curve's real SOL reserve in SOL:
// a pullback from the window high, already bouncing off the window low, with live
// buy flow behind it.
function entryOk(t: Tape, now: number, rqSol: number): boolean {
  if (rqSol < MIN_REAL_SOL || rqSol > MAX_REAL_SOL) return false;
  if (t.created === null || now - t.created < MIN_AGE || now - t.created > MAX_AGE) return false;
  const from = now - ENTRY_WINDOW;
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let high = 0;
  let low = Number.POSITIVE_INFINITY;
  let last = 0;
  let lastSlot = -1;
  const byUser = new Map<string, number>();
  for (const tr of t.trades) {
    if (tr.slot <= from) continue;
    if (tr.buy) {
      buySol += tr.sol;
      buys++;
      byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
    } else {
      sellSol += tr.sol;
    }
    if (tr.price > high) high = tr.price;
    if (tr.price < low) low = tr.price;
    last = tr.price;
    lastSlot = tr.slot;
  }
  if (lastSlot < 0 || now - lastSlot > FRESH_SLOTS) return false;
  if (buys < MIN_BUYS || byUser.size < MIN_BUYERS) return false;
  if (buySol - sellSol < MIN_NET_SOL) return false;
  if (high <= 0 || low === Number.POSITIVE_INFINITY) return false;
  if (last > high * (1 - PULLBACK)) return false; // not pulled back enough yet
  if (last < low * (1 + BOUNCE)) return false; // not bouncing yet
  let top = 0;
  for (const v of byUser.values()) if (v > top) top = v;
  if (top > MAX_TOP_SHARE * buySol) return false;
  return true;
}

function decideBatch(batch: BatchMsg): Order[] {
  const h = hello!;
  const now = batch.slot;
  const txFee = BigInt(h.fees.base_fee_lamports) + BigInt(h.fees.priority_fee_lamports);
  const cap = h.caps.max_orders_per_batch;
  const orders: Order[] = [];
  const traded = new Set<Pubkey>();

  // Count our own fills (harness closes start with '_').
  for (const f of batch.fills) {
    if (f.status === 'filled' && f.client_id.charAt(0) !== '_') {
      myFills++;
      myCoins.add(f.mint);
    }
  }

  // Fold the batch's events into the tapes and curves.
  for (const e of batch.events) {
    if (e.block_time !== null) {
      if (firstTime === null) firstTime = e.block_time;
      if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
    }
    if (e.event === 'CreateEvent') {
      tapeOf(e.mint).created = e.slot;
      curves.set(e.mint, {
        created: e.slot,
        vq: BigInt(e.virtual_sol_reserves),
        vt: BigInt(e.virtual_token_reserves),
        rq: 0n,
        rt: BigInt(e.real_token_reserves),
        complete: false,
      });
    } else if (e.event === 'TradeEvent') {
      const t = tapeOf(e.mint);
      const sol = Number(e.sol_amount) / Number(LAMPORTS_PER_SOL);
      t.trades.push({
        slot: e.slot,
        buy: e.is_buy,
        sol,
        user: e.user,
        price: priceOf(BigInt(e.virtual_sol_reserves), BigInt(e.virtual_token_reserves)),
      });
      traded.add(e.mint);
      const c = curves.get(e.mint);
      if (c !== undefined) {
        c.vq = BigInt(e.virtual_sol_reserves);
        c.vt = BigInt(e.virtual_token_reserves);
        c.rq = BigInt(e.real_sol_reserves);
        c.rt = BigInt(e.real_token_reserves);
      } else {
        curves.set(e.mint, {
          created: null,
          vq: BigInt(e.virtual_sol_reserves),
          vt: BigInt(e.virtual_token_reserves),
          rq: BigInt(e.real_sol_reserves),
          rt: BigInt(e.real_token_reserves),
          complete: false,
        });
      }
    } else {
      const c = curves.get(e.mint);
      if (c !== undefined) c.complete = true;
      else curves.set(e.mint, { created: null, vq: 0n, vt: 0n, rq: 0n, rt: 0n, complete: true });
    }
  }

  // Prune stale tape entries for coins that traded this batch.
  const keepFrom = now - ENTRY_WINDOW - 5;
  for (const mint of traded) {
    const t = tapes.get(mint)!;
    let cut = 0;
    while (cut < t.trades.length && t.trades[cut]!.slot <= keepFrom) cut++;
    if (cut > 0) t.trades.splice(0, cut);
  }

  // Latest reserves per mint, preferring this batch's marks.
  const marks = new Map<string, MarkMsg>();
  for (const m of batch.marks) marks.set(m.mint, m);

  // Positions and pending orders, by mint.
  const positions = new Map<string, PositionMsg>();
  for (const p of batch.account.positions) positions.set(p.mint, p);
  const pendingByMint = new Map<Pubkey, number>();
  const pendingSell = new Set<Pubkey>();
  for (const po of pendingOrders.values()) {
    pendingByMint.set(po.mint, (pendingByMint.get(po.mint) ?? 0) + 1);
    if (po.side === 'sell') pendingSell.add(po.mint);
  }

  const cashSol = Number(BigInt(batch.account.cash_lamports)) / Number(LAMPORTS_PER_SOL);
  const txSol = Number(txFee) / Number(LAMPORTS_PER_SOL);
  let freeSol = cashSol;
  for (const po of pendingOrders.values()) {
    freeSol -= txSol;
    if (po.side === 'buy') freeSol -= Number(BigInt(po.quote_lamports)) / Number(LAMPORTS_PER_SOL);
  }

  const reservesOf = (mint: Pubkey): { vq: bigint; vt: bigint; rq: bigint } | null => {
    const mk = marks.get(mint);
    if (mk !== undefined) {
      return { vq: BigInt(mk.virtual_quote_reserves), vt: BigInt(mk.virtual_token_reserves), rq: BigInt(mk.real_quote_reserves) };
    }
    const c = curves.get(mint);
    if (c === undefined) return null;
    return { vq: c.vq, vt: c.vt, rq: c.rq };
  };

  // ---- exits first: sell whole positions on stop, take profit or time limit.
  for (const [mint, hd] of held) {
    const pos = positions.get(mint);
    const curve = curves.get(mint);
    if (pos === undefined) {
      if (!pendingByMint.has(mint)) {
        held.delete(mint);
        if (hd.filled) tapeOf(mint).lastExit = now;
        else tapeOf(mint).entries--;
      }
      continue;
    }
    const r = reservesOf(mint);
    if (r === null) continue;
    const tokens = BigInt(pos.token_amount);
    const value = sellValueSol(tokens, r.vq, r.vt, txFee);
    if (!hd.filled) {
      // First sight of the filled position: anchor every exit on what the tokens
      // would fetch right now, not on the quote spent (which already lost the
      // buy-side curve fee), so a 10% stop really means a 10% price move.
      hd.filled = true;
      hd.entryValue = value;
    }
    if (hd.entryValue <= 0) continue;
    if (curve === undefined || curve.complete) continue;
    let exit = hd.exiting;
    if (!exit && value < hd.entryValue * (1 - STOP_LOSS)) exit = true;
    if (!exit && value >= hd.entryValue * (1 + TAKE_PROFIT)) exit = true;
    if (!exit && now - hd.opened > MAX_HOLD && value < hd.entryValue * (1 + HOLD_IF_UP)) exit = true;
    if (!exit) continue;
    hd.exiting = true;
    if (unsellable.has(mint)) continue;
    if (pendingSell.has(mint)) continue;
    if (orders.length >= cap) break;
    orders.push({ side: 'sell', client_id: freshClientId(), mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIP_BPS });
    pendingSell.add(mint);
  }

  // ---- probe round trips: sell the whole probe as soon as its buy has landed.
  for (const [mint, selling] of probes) {
    const pos = positions.get(mint);
    const curve = curves.get(mint);
    if (pos === undefined) {
      if (!pendingByMint.has(mint)) probes.delete(mint);
      continue;
    }
    if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
    if (orders.length >= cap) break;
    orders.push({ side: 'sell', client_id: freshClientId(), mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIP_BPS });
    if (!selling) probes.set(mint, true);
  }

  // ---- entries, only on coins that traded this batch.
  let slotsLeft = h.caps.max_open_positions - committedCount(positions, pendingOrders);
  for (const mint of traded) {
    if (orders.length >= cap) break;
    const curve = curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    if (pendingByMint.has(mint) || probes.has(mint) || held.has(mint)) continue;
    const t = tapes.get(mint)!;
    if (slotsLeft <= 0) continue;
    if (t.entries >= MAX_ENTRIES || now - t.lastExit < COOLDOWN) continue;
    const r = reservesOf(mint);
    if (r === null) continue;
    const rqSol = Number(r.rq) / Number(LAMPORTS_PER_SOL);
    if (!entryOk(t, now, rqSol)) continue;
    // Per-reply size cap: 1% of the real SOL reserve.
    const capSol = Math.floor(Number((r.rq * BigInt(h.caps.max_order_bps_of_real_reserve)) / BPS)) / Number(LAMPORTS_PER_SOL);
    let amount = Math.min(capSol, FIRST_BUY_SOL);
    if (amount > freeSol - txSol) amount = freeSol - txSol;
    if (amount < MIN_BUY_SOL) continue;
    const lamports = BigInt(Math.floor(amount * Number(LAMPORTS_PER_SOL)));
    orders.push({ side: 'buy', client_id: freshClientId(), mint, quote_lamports: lamports.toString(), max_slippage_bps: BUY_SLIP_BPS });
    freeSol -= amount + txSol;
    held.set(mint, { opened: now, entryValue: 0, invested: amount, exiting: false, filled: false });
    t.entries++;
    slotsLeft--;
  }

  // ---- guardrail pacing: open a probe when fills or coins lag the pace.
  if (probes.size < MAX_PROBES && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
    const pace = Math.min(1, (lastTime - firstTime) / PACE_SECS);
    const needCoins = myCoins.size < Math.ceil(TARGET_COINS * pace);
    const needFills = myFills < Math.ceil(TARGET_FILLS * pace);
    if (needCoins || needFills) {
      const minRq = (PROBE_SOL * Number(BPS)) / h.caps.max_order_bps_of_real_reserve;
      for (const mint of traded) {
        if (orders.length >= cap || probes.size >= MAX_PROBES) break;
        if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || positions.has(mint)) continue;
        if (needCoins && !needFills && myCoins.has(mint)) continue;
        const curve = curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (Number(curve.rq) / Number(LAMPORTS_PER_SOL) < minRq * 1.5) continue;
        if (freeSol < PROBE_SOL + 2 * txSol) break;
        orders.push({ side: 'buy', client_id: freshClientId(), mint, quote_lamports: BigInt(Math.floor(PROBE_SOL * Number(LAMPORTS_PER_SOL))).toString(), max_slippage_bps: BUY_SLIP_BPS });
        probes.set(mint, false);
        freeSol -= PROBE_SOL + txSol;
      }
    }
  }

  return orders;
}

// Mints held plus mints with a buy pending: what counts against max_open_positions.
function committedCount(positions: Map<string, PositionMsg>, pending: Map<string, { mint: Pubkey; side: string; quote_lamports: string }>): number {
  const mints = new Set<Pubkey>(positions.keys());
  for (const po of pending.values()) if (po.side === 'buy') mints.add(po.mint);
  return mints.size;
}

// Orders sent and not yet reported back in a fill.
const pendingOrders = new Map<string, { mint: Pubkey; side: 'buy' | 'sell'; quote_lamports: string }>();

// Mints whose sells the harness keeps refusing for good (a position too big for the
// curve's real reserves, or tokens already gone): stop re-sending sells for them instead
// of spamming a rejected order on every batch; the replay flattens them at the end.
const unsellable = new Set<Pubkey>();

// ---------------------------------------------------------------- the line loop

async function main(): Promise<void> {
  let buf = '';
  let done = false;
  process.stdin.setEncoding('utf8');
  const lines: string[] = [];
  let waiter: ((line: string | null) => void) | null = null;
  process.stdin.on('data', (chunk: string) => {
    buf += chunk;
    let idx = buf.indexOf('\n');
    while (idx !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (waiter !== null) {
        const w = waiter;
        waiter = null;
        w(line);
      } else {
        lines.push(line);
      }
      idx = buf.indexOf('\n');
    }
  });
  process.stdin.on('end', () => {
    if (waiter !== null) {
      const w = waiter;
      waiter = null;
      w(null);
    }
  });
  const nextLine = (): Promise<string | null> => {
    const queued = lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => {
      waiter = resolve;
    });
  };

  for (;;) {
    const line = await nextLine();
    if (line === null) break;
    if (line.trim() === '') continue;
    const msg = JSON.parse(line) as HelloMsg | BatchMsg | DoneMsg;
    if (msg.type === 'hello') {
      hello = msg;
    } else if (msg.type === 'batch') {
      const batch = msg as BatchMsg;
      // Fold this batch's fills into the pending set before deciding. A sell the harness
      // refused for good marks its mint unsellable so the exit loop stops retrying it.
      for (const f of batch.fills) {
        const po = pendingOrders.get(f.client_id);
        if (f.status === 'rejected' && po !== undefined && po.side === 'sell' && (f.reason === 'max_order_size' || f.reason === 'insufficient_tokens')) {
          unsellable.add(f.mint);
        }
        pendingOrders.delete(f.client_id);
      }
      const orders = decideBatch(batch);
      for (const o of orders) {
        pendingOrders.set(o.client_id, {
          mint: o.mint,
          side: o.side,
          quote_lamports: o.side === 'buy' ? o.quote_lamports : '0',
        });
      }
      const reply = JSON.stringify({ type: 'reply', seq: batch.seq, orders });
      process.stdout.write(reply + '\n');
    } else if (msg.type === 'done') {
      done = true;
      break;
    }
  }
  if (!done) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
