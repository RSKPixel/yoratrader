"""Realistic fills for the futures paper books, from the recorded order book (tick_open).

A paper book assumes it trades at a printed price (the open, an Oops level, the 15:15 price) plus a fixed
slippage per model (slip.py). That holds for liquid futures. A thin one can have a wide spread: on 19 Nov
VMM's paper short at 91.86 could only really have been sold at about 89.6, and ADANIENSOL's Oops buy at 1,457
at about 1,490, both about 2.4% worse.

The rule: a market order sent at the moment the paper book trades pays the far side of the book, i.e. a buy
pays the ask, a sell gets the bid, taken as the median over the next WINDOW seconds of recorded ticks (one
tick can be a flash). Its cost against the paper price, beyond the model's own slippage, is added as extra
slippage on that side. If the order book was better than the paper price, nothing is taken off: the model's
slippage stays the floor.

Covered moments (the tick log runs 09:14-09:17 and 15:14-15:15:30, see ticklog.py):
- entries at the open (Buy/Sell on gap, Cross-sectional): 09:15:01;
- exits at 15:15 (Gap, Cross-sectional): 15:15:00;
- next-open exits (Oops): 09:15:01 the next trading day;
- Oops buys: the fill second if inside a logged window, else the ask stored at the fill (oops_paper.fill_ask).
Stops and moments with no recorded book: the model's slippage only.
"""

from datetime import datetime
from datetime import time as clock

from db import connect

WINDOW = 10  # seconds of the book after the order is sent
OPEN_AT, CLOSE_AT = clock(9, 15, 1), clock(15, 15, 0)


def _books(wants):
    """{(day, symbol, t): (median bid, median ask)} over [t, t + WINDOW s] for each (day, symbol, t)."""
    wants = sorted(set(wants))
    if not wants:
        return {}
    with connect() as conn, conn.cursor() as cursor:
        cursor.execute(
            """
            SELECT w.day, w.symbol, w.t,
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY k.bid) FILTER (WHERE k.bid > 0),
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY k.ask) FILTER (WHERE k.ask > 0)
            FROM unnest(%s::date[], %s::text[], %s::timestamp[]) AS w(day, symbol, t)
            JOIN tick_open k ON k.day = w.day AND k.symbol = w.symbol
                            AND k.exch_ts >= w.t AND k.exch_ts <= w.t + make_interval(secs => %s)
            GROUP BY w.day, w.symbol, w.t
            """,
            ([w[0] for w in wants], [w[1] for w in wants], [w[2] for w in wants], WINDOW),
        )
        return {(d, s, t): (b, a) for d, s, t, b, a in cursor.fetchall()}


def _cost(order, px, bid, ask):
    """The far side's cost against the paper price (a fraction; None if that side wasn't quoted)."""
    if order == "buy":
        return (ask - px) / px if ask else None
    return (px - bid) / px if bid else None


class Fills:
    """Collect the moments a page needs, look them all up in one query, then read the extra slippage.

        f = Fills(model_slip)
        k = f.want(day, symbol, "buy", datetime, price)      # or f.want_ask(price, stored_ask) for an Oops fill
        f.load()
        f.extra(k)   # extra slippage (fraction of that side's price), 0.0 when the book was fine or unknown
        f.measured(k)  # the measured far-side cost (fraction) or None
    """

    def __init__(self, model_slip):
        self.slip = model_slip
        self.items, self.got = [], {}

    def want(self, day, symbol, order, at, px):
        if not (day and symbol and at and px):
            self.items.append(None)
        else:
            self.items.append(("tick", day, symbol, order, at.replace(tzinfo=None, microsecond=0), float(px)))
        return len(self.items) - 1

    def want_ask(self, px, ask):
        self.items.append(("ask", float(px), float(ask)) if px and ask else None)
        return len(self.items) - 1

    def load(self):
        self.got = _books([(i[1], i[2], i[4]) for i in self.items if i and i[0] == "tick"])
        return self

    def measured(self, k):
        i = self.items[k]
        if i is None:
            return None
        if i[0] == "ask":
            return (i[2] - i[1]) / i[1]
        bid, ask = self.got.get((i[1], i[2], i[4]), (None, None))
        return _cost(i[3], i[5], bid, ask)

    def extra(self, k):
        m = self.measured(k)
        return max(0.0, m - self.slip) if m is not None else 0.0


def at_open(day):
    return datetime.combine(day, OPEN_AT)


def at_close(day):
    return datetime.combine(day, CLOSE_AT)


def in_window(t):
    """Whether a moment (naive IST) falls in the tick log's windows."""
    tt = t.time()
    return clock(9, 15) <= tt <= clock(9, 17) or clock(15, 14) <= tt <= clock(15, 15, 30)
