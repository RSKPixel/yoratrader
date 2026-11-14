"""Volatility breakout paper trading on the five F&O indices (Larry Williams; the backtest page's
index book): long only, one position per index, sold at the first profitable 09:15 open (at most
5 trading days). Both breakout sizes are tracked, k = 1.0 (the page default) and k = 0.5.

Two versions of every trade, side by side:
- "index": the backtest's own rules on the index prices: the level is the index's 09:15 open +
  k x yesterday's index range, the buy is the first 15m index candle that reaches it, the sale is
  the index's 09:15 open.
- "futures": the same rules on the future's own prices (its open, yesterday's futures range, its
  15m candles, its open the morning it is sold): what you would trade by hand. The future is the
  nearest one expiring at least MIN_EXPIRY_DAYS later, so a 5-day hold doesn't cross expiry. (The
  futures pre-open auction covers current-month contracts only; near expiry this is next month's.)

From gapwatch's production scheduler:
- record_open(), at 09:15:01: sell open trades whose open is above the buy price, or on their 5th
  trading day; then store every index's level (indices sold this morning can be bought again today).
- finalize(), after 15:16: from today's 15m candles, the first candle (09:15 to 15:00) that reached
  each level of an index not held; bought at the level (or that candle's open, if it opened above).
Nothing here places orders.
"""

import time
from datetime import timedelta
from datetime import time as clock

import backtest
import gapwatch
import kite_auth
import vbo
import xsmr
from db import connect

KS = (1.0, 0.5)
HOLD = vbo.SWING_DAYS
MAX_OPEN = 5  # one per index: the page's default for the indices
BACKTEST_VARIANT = "k1-swing-max5"
INDICES = vbo.INDEX_LOTS  # index tradingsymbol -> futures name
MIN_EXPIRY_DAYS = 8
LAST_ENTRY_SLOT = (15, 0)
_cache = {"day": None, "futures": {}, "tokens": {}}


def _ensure_tables(cursor):
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS vbo_paper_levels (
            day DATE NOT NULL, basis TEXT NOT NULL, symbol TEXT NOT NULL, instrument TEXT NOT NULL,
            open DOUBLE PRECISION NOT NULL, prev_high DOUBLE PRECISION NOT NULL, prev_low DOUBLE PRECISION NOT NULL,
            PRIMARY KEY (day, basis, symbol)
        );
        CREATE TABLE IF NOT EXISTS vbo_paper (
            basis TEXT NOT NULL, k DOUBLE PRECISION NOT NULL, symbol TEXT NOT NULL, buy_day DATE NOT NULL,
            instrument TEXT NOT NULL, level DOUBLE PRECISION NOT NULL, buy_time TEXT NOT NULL, buy DOUBLE PRECISION NOT NULL,
            sell_day DATE, sell DOUBLE PRECISION, reason TEXT,
            PRIMARY KEY (basis, k, symbol, buy_day)
        );
        CREATE TABLE IF NOT EXISTS vbo_paper_days (
            day DATE PRIMARY KEY, opened_at TIMESTAMPTZ, finalized_at TIMESTAMPTZ, market_open BOOLEAN,
            sold INTEGER, bought INTEGER, note TEXT
        );
        """
    )


def _instruments(kite, today):
    """{index: token} and {index: (future tradingsymbol, token, expiry)}, once a day."""
    if _cache["day"] != today:
        tokens = {r["tradingsymbol"]: r["instrument_token"] for r in kite.instruments("NSE")
                  if r["segment"] == "INDICES" and r["tradingsymbol"] in INDICES}
        names = {v: k for k, v in INDICES.items()}
        best = {}
        for r in kite.instruments("NFO"):
            if r["instrument_type"] != "FUT" or r["name"] not in names or r["expiry"] < today + timedelta(days=MIN_EXPIRY_DAYS):
                continue
            index = names[r["name"]]
            if index not in best or r["expiry"] < best[index]["expiry"]:
                best[index] = r
        _cache.update(day=today, tokens=tokens,
                      futures={k: (v["tradingsymbol"], v["instrument_token"], v["expiry"]) for k, v in best.items()})
    return _cache["tokens"], _cache["futures"]


def _last_session(today):
    """The last day this log saw the market open at 09:15 (a Muhurat-only day doesn't count)."""
    with connect() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT max(day) FROM vbo_paper_days WHERE day < %s AND market_open", (today,))
        return cursor.fetchone()[0]


def _yesterday(kite, token, today, session):
    """Yesterday's (high, low): the day candle of the last regular session (`session`, from this log),
    else the last weekday candle (Muhurat trading is mostly on a weekend)."""
    bars = kite.historical_data(token, today - timedelta(days=15), today - timedelta(days=1), "day")
    bars = [b for b in bars if b["date"].date() < today and b["date"].weekday() < 5]
    if session is not None and (today - session).days <= 7:
        bars = [b for b in bars if b["date"].date() <= session]
    return (float(bars[-1]["high"]), float(bars[-1]["low"])) if bars else None


def _sessions_after(cursor, day, upto):
    cursor.execute("SELECT count(*) FROM vbo_paper_days WHERE day > %s AND day <= %s AND market_open", (day, upto))
    return cursor.fetchone()[0]


def record_open(force=False):
    now = gapwatch._now()
    today = now.date()
    if today.weekday() >= 5 or now.time() < gapwatch.OPEN_AT:
        return {"recorded": False, "reason": "market not open yet"}
    with connect() as conn, conn.cursor() as cursor:
        _ensure_tables(cursor)
        conn.commit()
        cursor.execute("SELECT opened_at FROM vbo_paper_days WHERE day = %s", (today,))
        row = cursor.fetchone()
        if row and row[0] and not force:
            return {"recorded": False, "reason": "already recorded"}
    kite = kite_auth.trading_client()
    tokens, futures = _instruments(kite, today)
    keys = [f"NSE:{s}" for s in INDICES] + [f"NFO:{f[0]}" for f in futures.values()]
    with connect() as conn, conn.cursor() as cursor:
        cursor.execute("SELECT DISTINCT instrument FROM vbo_paper WHERE basis = 'futures' AND sell_day IS NULL")
        keys += [f"NFO:{r[0]}" for r in cursor.fetchall()]
    quotes = kite.quote(sorted(set(keys)))
    stamp = gapwatch._now()
    traded = [q for k, q in quotes.items() if k.startswith("NFO:") and q.get("last_trade_time")
              and q["last_trade_time"].date() == today]
    market_open = len(traded) > 0
    if not market_open:
        with connect() as conn, conn.cursor() as cursor:
            cursor.execute("INSERT INTO vbo_paper_days (day, opened_at, market_open, note) VALUES (%s, %s, false, %s) "
                           "ON CONFLICT (day) DO UPDATE SET opened_at = EXCLUDED.opened_at, market_open = false, note = EXCLUDED.note",
                           (today, stamp, "market closed (no futures traded today)"))
            conn.commit()
        return {"recorded": False, "reason": "market closed"}

    def open_of(key):
        q = quotes.get(key) or {}
        o = (q.get("ohlc") or {}).get("open")
        return float(o) if o else None

    sold = 0
    with connect() as conn, conn.cursor() as cursor:
        cursor.execute("INSERT INTO vbo_paper_days (day, opened_at, market_open) VALUES (%s, %s, true) "
                       "ON CONFLICT (day) DO UPDATE SET opened_at = EXCLUDED.opened_at, market_open = true", (today, stamp))
        # 1. Sales at this open.
        cursor.execute("SELECT basis, k, symbol, buy_day, instrument, buy FROM vbo_paper WHERE sell_day IS NULL AND buy_day < %s",
                       (today,))
        for basis, k, symbol, buy_day, instrument, buy in cursor.fetchall():
            o = open_of(f"NSE:{instrument}" if basis == "index" else f"NFO:{instrument}")
            if o is None:
                continue
            age = _sessions_after(cursor, buy_day, today)
            if o > buy or age >= HOLD:
                cursor.execute("UPDATE vbo_paper SET sell_day = %s, sell = %s, reason = %s "
                               "WHERE basis = %s AND k = %s AND symbol = %s AND buy_day = %s",
                               (today, o, "profitable open" if o > buy else f"day {HOLD} open", basis, k, symbol, buy_day))
                sold += 1
        # 2. Today's levels: the open and yesterday's range, for the index and its future.
        levels = 0
        session = _last_session(today)
        for symbol in INDICES:
            for basis, instrument, token in (("index", symbol, tokens.get(symbol)),
                                             ("futures", *(futures.get(symbol) or (None, None))[:2])):
                o = open_of(f"NSE:{instrument}" if basis == "index" else f"NFO:{instrument}") if instrument else None
                prev = _yesterday(kite, token, today, session) if token else None
                time.sleep(0.35)  # Kite allows ~3 historical requests a second
                if o is None or prev is None:
                    continue
                cursor.execute("INSERT INTO vbo_paper_levels (day, basis, symbol, instrument, open, prev_high, prev_low) "
                               "VALUES (%s, %s, %s, %s, %s, %s, %s) ON CONFLICT (day, basis, symbol) DO UPDATE SET "
                               "instrument = EXCLUDED.instrument, open = EXCLUDED.open, prev_high = EXCLUDED.prev_high, "
                               "prev_low = EXCLUDED.prev_low", (today, basis, symbol, instrument, o, prev[0], prev[1]))
                levels += 1
        late = stamp.time() > gapwatch.LIVE_FILL_BY
        cursor.execute("UPDATE vbo_paper_days SET sold = %s, note = %s WHERE day = %s",
                       (sold, f"opens taken at {stamp.time():%H:%M:%S}" + (" (late)" if late else ""), today))
        conn.commit()
    return {"recorded": True, "sold": sold, "levels": levels}


def finalize(force=False):
    """After 15:16: the breakouts of the day, from the 15m candles."""
    now = gapwatch._now()
    today = now.date()
    if today.weekday() >= 5 or (now.time() < gapwatch.EXIT_AT and not force):
        return 0
    with connect() as conn, conn.cursor() as cursor:
        _ensure_tables(cursor)
        conn.commit()
        cursor.execute("SELECT finalized_at, market_open FROM vbo_paper_days WHERE day = %s", (today,))
        row = cursor.fetchone()
        if not row or not row[1] or (row[0] and not force):
            return 0
        cursor.execute("SELECT basis, symbol, instrument, open, prev_high, prev_low FROM vbo_paper_levels WHERE day = %s", (today,))
        levels = cursor.fetchall()
        cursor.execute("SELECT basis, k, symbol FROM vbo_paper WHERE sell_day IS NULL AND buy_day < %s", (today,))
        held = set(cursor.fetchall())
        cursor.execute("SELECT basis, k, symbol FROM vbo_paper WHERE buy_day = %s", (today,))
        done = set(cursor.fetchall())
    kite = kite_auth.trading_client()
    tokens, futures = _instruments(kite, today)
    fut_tokens = {v[0]: v[1] for v in futures.values()}
    candles, rows = {}, []
    for basis, symbol, instrument, o, ph, pl in levels:
        token = tokens.get(instrument) if basis == "index" else fut_tokens.get(instrument)
        if token is None:
            continue
        if instrument not in candles:
            bars = kite.historical_data(token, today, today, "15minute")
            candles[instrument] = [b for b in bars if b["date"].date() == today
                                   and (b["date"].hour, b["date"].minute) <= LAST_ENTRY_SLOT]
            time.sleep(0.35)
        for k in KS:
            if (basis, k, symbol) in held or (basis, k, symbol) in done:
                continue
            level = o + k * (ph - pl)
            for b in candles[instrument]:
                if b["high"] >= level:
                    rows.append((basis, k, symbol, today, instrument, level, f"{b['date']:%H:%M}", max(level, float(b["open"]))))
                    break
    with connect() as conn, conn.cursor() as cursor:
        for r in rows:
            cursor.execute("INSERT INTO vbo_paper (basis, k, symbol, buy_day, instrument, level, buy_time, buy) "
                           "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT DO NOTHING", r)
        cursor.execute("UPDATE vbo_paper_days SET finalized_at = %s, bought = %s WHERE day = %s",
                       (gapwatch._now(), len(rows), today))
        conn.commit()
    return len(rows)


def paper(slippage=0.0002):
    """The log per version (index / futures) and breakout size: open and closed trades net of costs
    on both sides, today's levels, the days, and totals (each index is a fifth of capital)."""
    cost = xsmr.cost_per_side(slippage)
    with connect() as conn, conn.cursor() as cursor:
        _ensure_tables(cursor)
        conn.commit()
        cursor.execute("SELECT basis, k, symbol, buy_day, instrument, level, buy_time, buy, sell_day, sell, reason "
                       "FROM vbo_paper ORDER BY buy_day DESC, symbol")
        trades = cursor.fetchall()
        cursor.execute("SELECT max(day) FROM vbo_paper_levels")
        last = cursor.fetchone()[0]
        cursor.execute("SELECT basis, symbol, instrument, open, prev_high, prev_low FROM vbo_paper_levels WHERE day = %s "
                       "ORDER BY symbol, basis", (last,))
        level_rows = cursor.fetchall()
        cursor.execute("SELECT day, opened_at, finalized_at, market_open, sold, bought, note FROM vbo_paper_days "
                       "ORDER BY day DESC LIMIT 60")
        days = cursor.fetchall()
        today = gapwatch._now().date()
        ages = {(t[0], t[1], t[2], t[3]): _sessions_after(cursor, t[3], today) for t in trades if t[8] is None}
    books = {}
    for basis, k, symbol, buy_day, instrument, level, buy_time, buy, sell_day, sell, reason in trades:
        b = books.setdefault(f"{basis}-{k:g}", {"basis": basis, "k": k, "open": [], "closed": []})
        row = {"symbol": symbol, "instrument": instrument, "buy_day": buy_day.isoformat(), "buy_time": buy_time,
               "level": round(level, 2), "buy": round(buy, 2)}
        if sell_day is None:
            row["day_of_hold"] = ages[(basis, k, symbol, buy_day)]
            b["open"].append(row)
            continue
        gross = sell / buy - 1
        net = gross - cost * (1 + sell / buy)
        row.update({"sell_day": sell_day.isoformat(), "sell": round(sell, 2), "reason": reason,
                    "gross_pct": round(100 * gross, 2), "net_pct": round(100 * net, 2)})
        b["closed"].append(row)
    for b in books.values():
        nets = [t["net_pct"] for t in b["closed"]]
        b["summary"] = {"trades": len(nets), "open": len(b["open"]),
                        "win_rate": round(100 * sum(n > 0 for n in nets) / len(nets), 1) if nets else None,
                        "avg_net_pct": round(sum(nets) / len(nets), 2) if nets else None,
                        "book_net_pct": round(sum(nets) / MAX_OPEN, 2)}
    levels = [{"basis": basis, "symbol": symbol, "instrument": instrument, "open": round(o, 2),
               "range": round(ph - pl, 2), **{f"level_{k:g}": round(o + k * (ph - pl), 2) for k in KS}}
              for basis, symbol, instrument, o, ph, pl in level_rows]
    fmt = lambda t: t.astimezone(backtest.IST).strftime("%H:%M:%S") if t else None
    return {"books": books, "levels_day": last.isoformat() if last else None, "levels": levels,
            "ks": list(KS), "hold": HOLD, "max_open": MAX_OPEN, "backtest_variant": BACKTEST_VARIANT,
            "cost_per_side_bps": round(10000 * cost, 2),
            "days": [{"day": d.isoformat(), "opened_at": fmt(o), "finalized_at": fmt(f), "market_open": m,
                      "sold": s, "bought": b, "note": n} for d, o, f, m, s, b, n in days]}
