"""F&O lot sizes and margin rates for the paper pages: positions are whole lots, and the capital a
day needs is its futures margin.

Once a day (the first call with Kite connected) every F&O stock's nearest future is priced with
Kite's margin API for one lot (NRML: SPAN + exposure). The rows go in fno_margins, so pages work
without Kite and dev and prod share them. rate = margin / (lot x future price): a position's margin
on any day is rate x lot x its price, so past paper days are sized at today's rates and lots (the
only ones stored).

Margins are per position, summed: no spread benefit between a day's longs and shorts (they're in
different stocks, where NSE gives little).
"""

import threading
from datetime import date

import gapwatch
import kite_auth
from db import connect

BATCH = 50  # orders per margin call
_lock = threading.Lock()
_mem = {"day": None, "rows": None}


def _ensure(cursor):
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS fno_margins (
            day DATE NOT NULL, symbol TEXT NOT NULL, future TEXT NOT NULL, expiry DATE NOT NULL,
            lot INTEGER NOT NULL, price DOUBLE PRECISION NOT NULL, margin DOUBLE PRECISION NOT NULL,
            span DOUBLE PRECISION, exposure DOUBLE PRECISION,
            PRIMARY KEY (day, symbol)
        )
        """
    )


def _fetch(today):
    kite = kite_auth.trading_client()
    stocks = set(gapwatch._symbols())
    futs = {}
    for r in kite.instruments("NFO"):
        if r["segment"] != "NFO-FUT" or r["name"] not in stocks or r["expiry"] < today:
            continue
        if r["name"] not in futs or r["expiry"] < futs[r["name"]]["expiry"]:
            futs[r["name"]] = r
    items = sorted(futs.items())
    quotes = {}
    for i in range(0, len(items), 200):
        quotes.update(kite.quote([f"NFO:{f['tradingsymbol']}" for _, f in items[i:i + 200]]))
    rows = []
    for i in range(0, len(items), BATCH):
        chunk = items[i:i + BATCH]
        orders = [{"exchange": "NFO", "tradingsymbol": f["tradingsymbol"], "transaction_type": "BUY", "variety": "regular",
                   "product": "NRML", "order_type": "MARKET", "quantity": int(f["lot_size"])} for _, f in chunk]
        for (symbol, f), m in zip(chunk, kite.order_margins(orders)):
            price = (quotes.get(f"NFO:{f['tradingsymbol']}") or {}).get("last_price")
            if price and m.get("total"):
                rows.append((today, symbol, f["tradingsymbol"], f["expiry"], int(f["lot_size"]), float(price), float(m["total"]),
                             float(m.get("span") or 0), float(m.get("exposure") or 0)))
    return rows


def table():
    """{symbol: {lot, rate, future, margin, price, day}} from the latest stored day; refreshed once a
    day when Kite is connected (a failed refresh keeps the last stored rates)."""
    today = gapwatch._now().date()
    with _lock:
        if _mem["day"] == today and _mem["rows"]:
            return _mem["rows"]
        with connect() as conn, conn.cursor() as cursor:
            _ensure(cursor)
            conn.commit()
            cursor.execute("SELECT max(day) FROM fno_margins")
            last = cursor.fetchone()[0]
        if last != today and kite_auth.status().get("connected"):
            try:
                rows = _fetch(today)
                if rows:
                    with connect() as conn, conn.cursor() as cursor:
                        cursor.executemany("INSERT INTO fno_margins (day, symbol, future, expiry, lot, price, margin, span, exposure) "
                                           "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (day, symbol) DO UPDATE SET "
                                           "future = EXCLUDED.future, expiry = EXCLUDED.expiry, lot = EXCLUDED.lot, price = EXCLUDED.price, "
                                           "margin = EXCLUDED.margin, span = EXCLUDED.span, exposure = EXCLUDED.exposure", rows)
                        conn.commit()
                    print(f"F&O margins: {len(rows)} futures priced")
            except Exception as error:
                print("F&O margins refresh failed:", error)
        with connect() as conn, conn.cursor() as cursor:
            cursor.execute("SELECT symbol, lot, price, margin, future, day FROM fno_margins WHERE day = (SELECT max(day) FROM fno_margins)")
            rows = {s: {"lot": lot, "rate": margin / (lot * price), "margin": margin, "price": price, "future": fut, "day": d.isoformat()}
                    for s, lot, price, margin, fut, d in cursor.fetchall()}
        if rows and next(iter(rows.values()))["day"] == today.isoformat():
            _mem.update(day=today, rows=rows)
        return rows


def as_of(rows):
    return next(iter(rows.values()))["day"] if rows else None


def size(rows, symbol, side, entry, exit_px, cps):
    """One lot of `symbol`: qty, contract value and margin at the entry, the rupee P&L to `exit_px`
    (None while unknown) after charges + slippage on both sides (cps per side, on the value traded)."""
    r = rows.get(symbol)
    if not r or not entry:
        return {"lot": None, "qty": None, "contract_rs": None, "margin_rs": None, "pnl_rs": None, "cost_rs": None, "net_rs": None}
    lot = r["lot"]
    contract = lot * entry
    sign = 1 if side == "long" else -1
    out = {"lot": lot, "qty": lot, "contract_rs": round(contract), "margin_rs": round(r["rate"] * contract),
           "pnl_rs": None, "cost_rs": round(cps * contract * 2), "net_rs": None}
    if exit_px:
        pnl = sign * lot * (exit_px - entry)
        cost = cps * lot * (entry + exit_px)
        out.update(pnl_rs=round(pnl, 2), cost_rs=round(cost, 2), net_rs=round(pnl - cost, 2))
    return out


def margin_pct(net_rs, margin_rs):
    return round(100 * net_rs / margin_rs, 3) if net_rs is not None and margin_rs else None


if __name__ == "__main__":
    t = table()
    print(len(t), as_of(t), {k: t[k] for k in list(t)[:3]})
