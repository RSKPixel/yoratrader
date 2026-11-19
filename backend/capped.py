"""The capped-limit version of the futures paper books, shown side by side with the market version.

The market version (the paper books as they are) assumes every pick is bought at its printed price plus
slippage (with a thin future's extra cost from realfill). The capped version sends a limit order instead,
no worse than the printed price by CAP, waits WAIT seconds, and if it isn't filled cancels it and gives the
slot to the next candidate. It is worked out afterwards from the recorded order book. Nothing places orders.

- Buy/Sell on gap and Cross-sectional: at 09:15:01 a limit at the open +CAP (a long) / -CAP (a short) for
  the top picks. A slot not filled by 09:15:31 goes to the next-ranked pick (Cross-sectional: the same side),
  in rounds of WAIT seconds while the tick log runs (to 09:16:30, so three rounds).
- Oops: when a watched future trades back at yesterday's low, a buy limit at the low +CAP for WAIT seconds.
  Slots go to the first ones filled. Missed ones don't take a slot, so a later name on the watchlist can.
  Triggers come from the tick log at the open and, later in the day, from the Oops tick stream (oops_capped).

A limit buy fills at the first ask at or under the limit within the wait (a sell: the first bid at or over).
The fill is the real price paid, so no model slippage is added on the way in, only charges. The way out is
as in the market version (the same exit price, with the order book's extra cost at the 15:15 / next-open exit).

Every miss is kept with its reason, so "missed winners" can be weighed against "slippage saved".
"""

from datetime import datetime, timedelta
from datetime import time as clock

from zoneinfo import ZoneInfo

from db import connect

IST = ZoneInfo("Asia/Kolkata")

CAP = {"gap": 0.002, "xsmr": 0.002, "oops": 0.003}  # round numbers, not tuned: well above a liquid future's spread
WAIT = 30  # seconds an order rests before it's cancelled
FIRST = clock(9, 15, 1)  # the open-entry books send their first orders here
DATA_END = clock(9, 16, 30)  # the morning tick log's end


def _ticks(day, symbols, start=clock(9, 15), end=DATA_END):
    """{symbol: [(exch_ts, ltp, bid, ask)]} for a window of the tick log (default: the morning), in time order."""
    if not symbols:
        return {}
    with connect() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT symbol, exch_ts, ltp, bid, ask FROM tick_open WHERE day = %s AND symbol = ANY(%s) "
                       "AND exch_ts >= %s AND exch_ts <= %s ORDER BY symbol, exch_ts, recv_ts",
                       (day, list(symbols), datetime.combine(day, start), datetime.combine(day, end)))
        out = {}
        for s, ts, ltp, bid, ask in cursor.fetchall():
            out.setdefault(s, []).append((ts, ltp, bid, ask))
    return out


def has_ticks(day):
    with connect() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT 1 FROM tick_open WHERE day = %s AND exch_ts >= %s LIMIT 1", (day, datetime.combine(day, clock(9, 15))))
        return cursor.fetchone() is not None


def _last_tick(ticks):
    return max((rows[-1][0] for rows in ticks.values() if rows), default=None)


def first_fill(rows, order, limit, a, b):
    """The first (time, price) in [a, b] a resting limit order fills at: a buy at an ask <= limit, a sell at a bid >= limit."""
    for ts, ltp, bid, ask in rows or ():
        if ts < a:
            continue
        if ts > b:
            break
        if order == "buy" and ask and ask <= limit:
            return ts, float(ask)
        if order == "sell" and bid and bid >= limit:
            return ts, float(bid)
    return None


def open_entries(day, cands, slots, cap):
    """The open-entry books (gap, cross-sectional). cands: dicts in rank order with symbol, side, entry (the
    open) and group (the slot pool: the side, or one pool); slots: {group: n}. Returns (fills, misses):
    fills [(cand, fill time, fill price)], misses [(cand, reason)]. None when the day has no tick log."""
    ticks = _ticks(day, {c["symbol"] for c in cands})
    end = _last_tick(ticks)
    if end is None:
        return None
    free = dict(slots)
    queue = {g: [c for c in cands if c["group"] == g] for g in slots}
    fills, misses = [], []
    a = last = datetime.combine(day, FIRST)
    while a <= end and any(free[g] > 0 and queue[g] for g in free):
        b = a + timedelta(seconds=WAIT)
        if b > end:  # the tick log stops before this round's wait is up: judged on what's there if most of it is
            if (end - a).total_seconds() < 0.66 * WAIT:
                break
            b = end
        for g in free:
            sent, queue[g] = queue[g][: free[g]], queue[g][free[g]:]
            for c in sent:
                long = c["side"] == "long"
                limit = c["entry"] * (1 + cap if long else 1 - cap)
                got = first_fill(ticks.get(c["symbol"]), "buy" if long else "sell", limit, a, b)
                if got:
                    fills.append((c, got[0], got[1]))
                    free[g] -= 1
                else:
                    misses.append((c, f"not filled {a:%H:%M:%S}-{b:%H:%M:%S} at {limit:.2f} or better"))
        a = last = b
    return fills, misses, last


def market_exit(day, symbol, side, at, within=60):
    """An intraday book's exit as a market order sent at `at` (naive IST): a long sells at the bid, a short buys
    at the ask, the first quote in the tick log within `within` seconds. (time, price) or None (not recorded)."""
    rows = _ticks(day, {symbol}, at.time(), (at + timedelta(seconds=within)).time()).get(symbol) or []
    for ts, ltp, bid, ask in rows:
        px = bid if side == "long" else ask
        if px:
            return ts, float(px)
    return None


def unwind(day, symbol, side, at):
    """Selling back a filled leg at the market at `at` (a long: the bid, a short: the ask): the first quote at or
    after it, else the last one recorded before it. (time, price) or None."""
    rows = _ticks(day, {symbol}).get(symbol) or []
    after = [r for r in rows if r[0] >= at]
    for ts, ltp, bid, ask in after + list(reversed([r for r in rows if r[0] < at])):
        px = bid if side == "long" else ask
        if px:
            return ts, float(px)
    return None


# ---- Oops: triggers through the day ---------------------------------------------------------------

def ensure_table(cursor):
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS oops_capped (
            day DATE NOT NULL, symbol TEXT NOT NULL, trig_at TIMESTAMP NOT NULL, prev_low DOUBLE PRECISION NOT NULL,
            fill_at TIMESTAMP, fill_px DOUBLE PRECISION, done BOOLEAN NOT NULL DEFAULT FALSE,
            PRIMARY KEY (day, symbol)
        )
        """
    )


def oops_events(day, watch, cap=CAP["oops"]):
    """Every watched future's capped buy that day: [(symbol, trig_at, fill_at or None, fill_px or None)],
    from the tick log at the open and the Oops stream's record later (watch: {symbol: prev_low})."""
    ticks = _ticks(day, set(watch))
    end = _last_tick(ticks)
    with connect() as conn, conn.cursor() as cursor:
        ensure_table(cursor)
        conn.commit()
        cursor.execute("SELECT symbol, trig_at, fill_at, fill_px, done FROM oops_capped WHERE day = %s", (day,))
        streamed = {s: (t, fa, fp, done) for s, t, fa, fp, done in cursor.fetchall()}
    out = []
    for s, pl in watch.items():
        rows = ticks.get(s) or []
        trig = next((ts for ts, ltp, _, _ in rows if ltp and ltp >= pl and ts >= datetime.combine(day, clock(9, 15))), None)
        if trig and end and (end - trig).total_seconds() >= 0.66 * WAIT:  # most of the wait inside the tick log
            got = first_fill(rows, "buy", pl * (1 + cap), trig, min(end, trig + timedelta(seconds=WAIT)))
            out.append((s, trig, got[0] if got else None, got[1] if got else None))
        elif s in streamed:
            t, fa, fp, done = streamed[s]
            if done or fa or t + timedelta(seconds=WAIT) < datetime.now(IST).replace(tzinfo=None):  # no tick after the wait: a miss
                out.append((s, t, fa, fp))
    return sorted(out, key=lambda e: (e[2] or e[1], e[0]))


class OopsRecorder:
    """Used by the Oops tick stream: each watched future's first trade at yesterday's low starts a capped
    buy; the first ask under the cap within WAIT seconds fills it, else it's a miss (stored either way)."""

    def __init__(self):
        self.day, self.watch, self.pending, self.seen, self.below = None, {}, {}, set(), set()

    def reset(self, day, watch):
        if day != self.day:
            self.day, self.pending, self.seen, self.below = day, {}, set(), set()
            with connect() as conn, conn.cursor() as cursor:
                ensure_table(cursor)
                conn.commit()
                cursor.execute("SELECT symbol FROM oops_capped WHERE day = %s", (day,))
                self.seen = {r[0] for r in cursor.fetchall()}
        self.watch = {s: pl for s, pl in watch.items() if s not in self.seen}

    def symbols(self):
        return set(self.watch) | set(self.pending)

    def _store(self, s, trig, pl, fill_at=None, fill_px=None, done=False):
        with connect() as conn, conn.cursor() as cursor:
            cursor.execute("INSERT INTO oops_capped (day, symbol, trig_at, prev_low, fill_at, fill_px, done) VALUES (%s, %s, %s, %s, %s, %s, %s) "
                           "ON CONFLICT (day, symbol) DO UPDATE SET fill_at = EXCLUDED.fill_at, fill_px = EXCLUDED.fill_px, done = EXCLUDED.done",
                           (self.day, s, trig, pl, fill_at, fill_px, done))
            conn.commit()

    def on_tick(self, s, ts, ltp, ask):
        """ts: the exchange time (naive IST)."""
        if s in self.pending:
            trig, pl = self.pending[s]
            if ask and ask <= pl * (1 + CAP["oops"]) and ts <= trig + timedelta(seconds=WAIT):
                del self.pending[s]
                self._store(s, trig, pl, ts, float(ask), True)
            elif ts > trig + timedelta(seconds=WAIT):
                del self.pending[s]
                self._store(s, trig, pl, done=True)
        elif s in self.watch and ltp:
            if ltp < self.watch[s]:
                self.below.add(s)  # a trigger is a trade back up at the low, seen from below
                return
            pl = self.watch.pop(s)
            self.seen.add(s)
            if s not in self.below:  # first seen already above it (a restart mid-day): when it crossed isn't known
                return
            self.pending[s] = (ts, pl)
            self._store(s, ts, pl)
            self.on_tick(s, ts, ltp, ask)  # the trigger tick's own ask can fill it
