"""One stock, one intraday book: the order of the intraday paper books when two want the same future.

ORDER: 1. Oops gap reversal, 2. Buy/Sell on gap, 3. Cross-sectional mean reversion. A stock already held by one
book is skipped by the others, and the skipping book takes its next candidate.

Without looking ahead, "already held" means:
- at the open (09:15:00-09:15:01) the books claim at the same moment, so the order decides: Gap and Cross-sectional
  skip what Oops has filled by 09:15:01, and Cross-sectional skips what Gap fills in its opening rounds;
- after that, whoever holds a stock first keeps it: an Oops buy later in the day skips a stock Gap or
  Cross-sectional already hold (they hold to 15:15), and a Gap fill is dropped if Oops filled the stock first.

Worked out from the tick-filled books (capped.py), with the paper pages' saved settings (max open, side, pairs).
"""

import json
import time
from datetime import datetime
from datetime import time as clock

import capped
from db import connect

ENABLED = False  # 19 Nov 2026: off by the user's decision: every book trades on its own until the paper results decide
ORDER = ("oops", "gap", "xsmr")
NAMES = {"oops": "Oops gap reversal", "gap": "Buy/Sell on gap", "xsmr": "Cross-sectional mean reversion"}
OPEN_CLAIM = clock(9, 15, 1)
_cache = {}


def _settings():
    """The paper pages' saved settings (the one user's), with the pages' defaults."""
    with connect() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT key, value FROM user_settings WHERE key IN ('params.paper-buy-on-gap', 'params.paper-xs-mean-reversion', "
                       "'paper.gap.side', 'paper.xsmr.pairs') ORDER BY user_id")
        got = {}
        for k, v in cursor.fetchall():
            got.setdefault(k, v)

    def val(k, default):
        v = got.get(k)
        if v is None:
            return default
        if isinstance(v, str):
            try:
                v = json.loads(v)
            except Exception:
                pass
        return v
    gap_open = int((val("params.paper-buy-on-gap", {}) or {}).get("maxOpen") or 5)
    xs_open = int((val("params.paper-xs-mean-reversion", {}) or {}).get("maxOpen") or 10)
    pairs = int(val("paper.xsmr.pairs", 5) or 5)
    return {"gap_open": gap_open, "gap_side": val("paper.gap.side", "long"), "xs_k": max(1, min(pairs, 5, xs_open // 2 or 5))}


def _oops_fills(day):
    import oopswatch
    with connect() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT symbol, prev_low FROM oops_paper_watch WHERE day = %s", (day,))
        watch = dict(cursor.fetchall())
        cursor.execute("SELECT max(slots) FROM oops_paper WHERE day = %s", (day,))
        slots = cursor.fetchone()[0] or oopswatch.max_open()
    events = [e for e in (capped.oops_events(day, watch) if watch else []) if e[2]]
    return {s: fa for s, _, fa, _ in events}, {s for s, _, _, _ in events[:slots]}


def _open_book(day, table, rows, slots, group, cap, blocked):
    cands = [{"symbol": s, "side": side, "entry": e, "group": group(side), "row": {"rank": i}} for i, (s, side, e) in enumerate(rows)
             if s not in blocked]
    res = capped.open_entries(day, cands, slots, cap)
    return {c["symbol"]: ts for c, ts, _ in res[0]} if res else {}


def claims(day):
    """{model: {symbol: fill time}} after the order is applied, and {model: {symbol: why skipped}}."""
    key = day
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < 60:
        return hit[1]
    cfg = _settings()
    oops, first_slots = _oops_fills(day)
    at_open = {s for s, fa in oops.items() if fa.time() <= OPEN_CLAIM and s in first_slots}
    skipped = {"oops": {}, "gap": {}, "xsmr": {}}
    with connect() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT symbol, side, entry, gap_pct FROM gap_paper WHERE day = %s", (day,))
        g_rows = sorted(cursor.fetchall(), key=lambda r: -abs(r[3]))
        cursor.execute("SELECT symbol, side, entry, rank FROM xsmr_paper WHERE day = %s ORDER BY side, rank", (day,))
        x_rows = cursor.fetchall()
    g_rows = [(s, side, e) for s, side, e, _ in g_rows if cfg["gap_side"] == "both" or side == "long"]
    gap = _open_book(day, "gap", g_rows, {"all": cfg["gap_open"]}, lambda side: "all", capped.CAP["gap"], at_open)
    for s in at_open & {r[0] for r in g_rows}:
        skipped["gap"][s] = f"held by {NAMES['oops']}"
    for s, ts in list(gap.items()):  # Oops filled it first (after the open moment): Oops keeps it
        if s in oops and oops[s] < ts:
            del gap[s]
            skipped["gap"][s] = f"held by {NAMES['oops']}"
    x_block = at_open | set(gap)
    xs = _open_book(day, "xsmr", [(s, side, e) for s, side, e, _ in x_rows], {"long": cfg["xs_k"], "short": cfg["xs_k"]},
                    lambda side: side, capped.CAP["xsmr"], x_block)
    for s in x_block & {r[0] for r in x_rows}:
        skipped["xsmr"][s] = f"held by {NAMES['oops'] if s in at_open else NAMES['gap']}"
    for s, fa in oops.items():  # a later Oops buy of a stock Gap / Cross-sectional already hold
        if fa.time() > OPEN_CLAIM:
            first = min((ts, m) for m, book in (("gap", gap), ("xsmr", xs)) for x, ts in book.items() if x == s) if s in gap or s in xs else None
            if first and first[0] < fa:
                skipped["oops"][s] = f"held by {NAMES[first[1]]}"
    out = {"skip": skipped, "config": cfg}
    _cache[key] = (time.time(), out)
    return out


def skipped(model, day):
    """{symbol: why} the book `model` must skip that day ({} before the tick log has it, or with the order off)."""
    if not ENABLED:
        return {}
    try:
        return claims(day)["skip"][model]
    except Exception as error:
        print("Book priority:", error)
        return {}
