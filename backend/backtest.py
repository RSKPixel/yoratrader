"""Five-year backtest of Key Breakout Dow Theory on NSE cash data: the F&O indices and the Nifty 50 stocks.

Data lives in its own tables (bt_15m, bt_daily) so it never mixes with the live
futures tables the model pages scan. Kite has no intraday history for expired
futures, so cash data stands in:
- "indices": the five NSE indices with futures (NIFTY 50, BANK, FIN SERVICE,
  MID SELECT, NEXT 50), spot data.
- "stocks": today's NIFTY 50 constituents (cash market, with volume), full models.
  Using today's list for the whole period flatters results (survivorship bias).

Key Breakout Dow Theory (daily signals) with exits at 15:15 on day 1, 3 or 5, and
the model stop, a fixed % stop or the model stop capped at a %.

KBDT signals are replayed day by day: each day is enriched and scanned using only
the daily bars up to that day (a trailing window), exactly as the live scanner
would have seen it. Enriching the full history once would leak the future: swing
points are confirmed by later bars, and the weekly low-volatility filter uses the
whole week. Signals are stored, so later runs only replay new days.

Trades are stored gross (R before costs). Costs are applied when results are
served, as NSE futures charges plus a chosen slippage, converted to R. Rupee
values are for one futures lot at today's lot size.
"""

import csv
import io
import itertools
import multiprocessing
import time
from datetime import date, datetime, timedelta
from datetime import time as time_of_day
from zoneinfo import ZoneInfo

import pandas as pd
import requests
from kiteconnect.exceptions import TokenException
from psycopg2.extras import execute_values

import kite_auth
import orb
from db import connect, stored_lot_sizes
from enrich import enrich_eod
from universaltrader.ut import signals2

IST = ZoneInfo("Asia/Kolkata")
YEARS = 5  # history for the stocks
# F&O indices: daily bars from 2000 (KBDT signals), 15m bars from as early as Kite has them
# (2015 for NIFTY, BANK and FIN SERVICE; late 2015 for NEXT 50; 2022 for MID SELECT).
INDEX_DAILY_FROM = date(2000, 1, 1)
INDEX_15M_FROM = date(2015, 1, 1)
CONSTITUENTS_URL = "https://www.niftyindices.com/IndexConstituent/ind_nifty50list.csv"
CHUNK_15M = 190  # Kite allows 200 days per 15minute request
CHUNK_DAY = 1900  # and 2000 per day request
DAILY_LEAD = 120  # calendar days of daily bars before the first 15m day (SMA50 + ATR14)
PAUSE = 0.35  # Kite historical API allows about 3 requests a second
DATASETS = ("indices", "stocks", "fno")
# "fno": every stock with a current NFO future (today's list, so also survivorship-biased).
# Buy-on-gap only: the KBDT replay is too slow for ~180 symbols.
GAP_ONLY_DATASETS = ("fno",)
# Downloaded as far back as Kite goes (daily from INDEX_DAILY_FROM, 15m from INDEX_15M_FROM).
FULL_HISTORY_DATASETS = ("indices", "stocks", "fno")
# NSE indices with futures: (Kite index name, futures name)
FNO_INDICES = [
    ("NIFTY 50", "NIFTY"),
    ("NIFTY BANK", "BANKNIFTY"),
    ("NIFTY FIN SERVICE", "FINNIFTY"),
    ("NIFTY MID SELECT", "MIDCPNIFTY"),
    ("NIFTY NEXT 50", "NIFTYNXT50"),
]

# KBDT: exit day x stop. "5d" is the model stop (previous day's low/high);
# "5d-fixed-0.75" puts the stop 0.75% from entry; "5d-cap-0.75" keeps the
# model stop but never further than 0.75%.
VARIANTS = {
    "kbdt": {
        **{f"{n}d": {"hold_days": n, "stop_mode": "model", "stop_pct": None} for n in (1, 3, 5)},
        **{f"{n}d-{mode}-{pct:g}": {"hold_days": n, "stop_mode": mode, "stop_pct": pct}
           for n in (1, 3, 5) for mode in ("fixed", "cap") for pct in (0.5, 0.75, 1.0, 1.5, 2.0)},
    },
}
# Buy-on-gap (Ernest Chan, Algorithmic Trading ch. 4): buy at the open when a stock opens
# below the previous day's low by more than `threshold` standard deviations of its 90-day
# daily returns, but still above its 20-day average close; take the `top` biggest gaps of
# the day across the dataset; exit at 15:15 on the `hold`-th trading day (1 = same day, the
# book's rule; 2 = next day; entry day = day 1). One position per stock at a time. "both" also shorts the mirror image (open above
# the previous high by the threshold, below the 20-day average). Stop "none" is the book's
# rule (no stop; 1R = one 90-day standard deviation from entry); "1sd" enforces that stop.
GAP_SD_DAYS = 90
GAP_MA_DAYS = 20
GAP_MIN_SESSION_BARS = 20  # skip short special sessions (Muhurat trading)
GAP_OPEN_TOLERANCE = 0.01  # first 15m open vs daily open; larger means a bad print
# Exit at 15:15 = the close of the 15:00 candle. (From August 2026 Kite's stock candles end with the
# 15:00 candle; there is no 15:15 candle to take the open of. Indices still have one.)
GAP_EXIT_BAR = (15, 0)
# Gap threshold and exit stay at the book's values (1σ, same day): fewer knobs, less curve fitting.
# Tested and dropped: a 1.5σ threshold, and holds to the next, 3rd and 5th day (same edge per
# trade, 2-5x the drawdown). The hold machinery stays so GAP_HOLDS can bring them back.
GAP_THRESHOLDS = (1.0,)
GAP_HOLDS = (1,)
VARIANTS["gap"] = {
    f"{k:g}sd-top{n}-{sides}-{stop}-{hold}d": {"threshold": k, "top": n, "sides": sides, "stop": stop, "hold": hold}
    for k in GAP_THRESHOLDS for n in (5, 10) for sides in ("long", "both") for stop in ("none", "1sd") for hold in GAP_HOLDS
}
GAP_BOOK = "1sd-top10-long-none-1d"  # Chan's version
# Opening gap momentum (Chan ch. 7, Example 7.1): the mirror image on index futures. Buy at the
# open when the index opens above the previous high by more than 0.1σ, short when it opens below
# the previous low by more than 0.1σ; out at 15:15. No average filter, no ranking (each index on
# its own). Book: both sides, no stop. Indices (the book), and the F&O stocks as a check on the stock half
# of Chan's argument (gaps reverse in stocks). 15m period (before 2011 Kite's index opens
# are often just the previous close, so the gap isn't measurable).
VARIANTS["gapmom"] = {
    f"0.1sd-all-{sides}-{stop}-1d": {"threshold": 0.1, "top": None, "sides": sides, "stop": stop, "hold": 1}
    for sides in ("both", "long") for stop in ("none", "1sd")
}
GAPMOM_BOOK = "0.1sd-all-both-none-1d"
GAPMOM_DATASETS = ("indices", "fno")
GAP_MODELS = ("gap", "gapmom")
DEFAULT_MODEL, DEFAULT_VARIANT = "kbdt", "5d"
MODEL_NAMES = {"kbdt": "Key Breakout Dow Theory", "gap": "Buy on gap", "gapmom": "Opening gap momentum"}
# Kite's early daily history for some indices is closing prices only (open = high = low =
# close): NIFTY BANK to June 2005, FIN SERVICE to February 2012, MID SELECT to January 2022.
# Swings and stops need real candles, so daily bars up to the last close-only one are ignored.
REAL_OHLC = ("day > COALESCE((SELECT max(day) FROM bt_daily f WHERE f.symbol = %s AND f.high = f.low "
             "AND f.open = f.close), DATE '1900-01-01')")
KBDT_WINDOW = 250  # trailing daily bars enriched for each replayed day
KBDT_EXIT = (15, 15)  # exit at 15:15 on the last holding day

# NSE futures charges as a fraction of turnover (same schedule as the model pages).
STT_SELL = 0.0005
EXCHANGE = 0.0000173
SEBI = 0.000001
STAMP_BUY = 0.00002
GST = 0.18
BROKERAGE_PER_ORDER = 20
# Assumed one-lot notional, used only to turn ₹20/order brokerage into a percentage.
LOT_NOTIONAL = {"indices": 1_500_000, "stocks": 700_000, "fno": 700_000}
FUTURES_NAME = dict(FNO_INDICES)  # index name -> futures name, for lot sizes


def _ensure_tables(cursor):
    # The first version stored ORB only, without model/variant; its rows are derived, so rebuild.
    cursor.execute(
        "SELECT 1 FROM information_schema.columns WHERE table_name = 'bt_trades' AND column_name = 'model'"
    )
    if cursor.fetchone() is None:
        cursor.execute("DROP TABLE IF EXISTS bt_trades; DROP TABLE IF EXISTS bt_runs")
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS bt_15m (
            symbol TEXT NOT NULL,
            datetime TIMESTAMPTZ NOT NULL,
            open DOUBLE PRECISION, high DOUBLE PRECISION, low DOUBLE PRECISION, close DOUBLE PRECISION,
            volume BIGINT,
            PRIMARY KEY (symbol, datetime)
        );
        CREATE TABLE IF NOT EXISTS bt_daily (
            symbol TEXT NOT NULL,
            day DATE NOT NULL,
            open DOUBLE PRECISION, high DOUBLE PRECISION, low DOUBLE PRECISION, close DOUBLE PRECISION,
            volume BIGINT,
            PRIMARY KEY (symbol, day)
        );
        CREATE TABLE IF NOT EXISTS bt_symbols (
            dataset TEXT NOT NULL,
            symbol TEXT NOT NULL,
            name TEXT,
            PRIMARY KEY (dataset, symbol)
        );
        CREATE TABLE IF NOT EXISTS bt_trades (
            model TEXT NOT NULL,
            variant TEXT NOT NULL,
            dataset TEXT NOT NULL,
            symbol TEXT NOT NULL,
            date DATE NOT NULL,
            side TEXT, entry_time BIGINT NOT NULL, entry_label TEXT,
            entry DOUBLE PRECISION, stop DOUBLE PRECISION, target DOUBLE PRECISION, exit DOUBLE PRECISION,
            exit_reason TEXT, t1_hit BOOLEAN, r DOUBLE PRECISION, status TEXT,
            exit_date DATE,
            PRIMARY KEY (model, variant, dataset, symbol, entry_time)
        );
        ALTER TABLE bt_trades ADD COLUMN IF NOT EXISTS exit_date DATE;
        CREATE TABLE IF NOT EXISTS bt_kbdt_signals (
            symbol TEXT NOT NULL,
            day DATE NOT NULL,
            side TEXT NOT NULL,
            level DOUBLE PRECISION NOT NULL,
            stop DOUBLE PRECISION NOT NULL,
            PRIMARY KEY (symbol, day)
        );
        CREATE TABLE IF NOT EXISTS bt_kbdt_progress (
            symbol TEXT PRIMARY KEY,
            last_day DATE NOT NULL
        );
        ALTER TABLE bt_kbdt_progress ADD COLUMN IF NOT EXISTS first_day DATE;
        CREATE TABLE IF NOT EXISTS bt_runs (
            dataset TEXT PRIMARY KEY,
            ran_at TIMESTAMPTZ NOT NULL,
            first_day DATE, last_day DATE,
            symbols INTEGER, days_scanned INTEGER
        );
        """
    )
    # Rows written before first_day existed were replayed from the first stored 15m day.
    cursor.execute(
        "UPDATE bt_kbdt_progress p SET first_day = (SELECT min(datetime AT TIME ZONE 'Asia/Kolkata')::date "
        "FROM bt_15m b WHERE b.symbol = p.symbol) WHERE first_day IS NULL"
    )


def _constituents():
    """Today's NIFTY 50 list from niftyindices.com; falls back to the last stored list."""
    try:
        response = requests.get(CONSTITUENTS_URL, headers={"User-Agent": "Mozilla/5.0"}, timeout=20)
        response.raise_for_status()
        rows = list(csv.DictReader(io.StringIO(response.text)))
        found = [(row["Symbol"].strip(), row["Company Name"].strip()) for row in rows if row.get("Symbol")]
        if len(found) >= 45:
            return found
    except Exception as error:
        print("Could not fetch NIFTY 50 constituents:", error)
    with connect() as conn, conn.cursor() as cursor:
        _ensure_tables(cursor)
        cursor.execute("SELECT symbol, name FROM bt_symbols WHERE dataset = 'stocks' ORDER BY symbol")
        stored = cursor.fetchall()
    if not stored:
        raise RuntimeError("Could not get the NIFTY 50 constituent list")
    return stored


def _fno_stocks():
    """Every stock with a current NFO future (Kite instruments); falls back to the last stored list."""
    try:
        from contracts import list_contracts

        indices = set(FUTURES_NAME.values())
        # Index futures not in FNO_INDICES (e.g. NIFTYFPI) are not stocks either.
        found = sorted({row["name"] for row in list_contracts("NSE")
                        if row["name"] not in indices and not row["name"].startswith("NIFTY")})
        if len(found) >= 100:
            return [(name, name) for name in found]
    except Exception as error:
        print("Could not list F&O stocks:", error)
    with connect() as conn, conn.cursor() as cursor:
        _ensure_tables(cursor)
        cursor.execute("SELECT symbol, name FROM bt_symbols WHERE dataset = 'fno' ORDER BY symbol")
        return cursor.fetchall()


def _last_stored(cursor, table, column, symbol, edge="max"):
    cursor.execute(f"SELECT {edge}({column}) FROM {table} WHERE symbol = %s", (symbol,))
    value = cursor.fetchone()[0]
    if value is None:
        return None
    return value.astimezone(IST).date() if isinstance(value, datetime) else value


def _fetch(kite, token, start, end, interval, chunk):
    bars = []
    cursor = start
    while cursor <= end:
        stop = min(end, cursor + timedelta(days=chunk - 1))
        part = kite.historical_data(
            token,
            from_date=datetime.combine(cursor, datetime.min.time()),
            to_date=datetime.combine(stop, datetime.max.time()).replace(microsecond=0),
            interval=interval,
        )
        bars.extend(part or [])
        cursor = stop + timedelta(days=1)
        time.sleep(PAUSE)
    return bars


def _store(cursor, symbol, bars_15m, bars_day):
    # Kite occasionally returns the same candle twice; one INSERT can't update a row twice.
    bars_15m = list({b["date"]: b for b in bars_15m}.values())
    bars_day = list({b["date"].date(): b for b in bars_day}.values())
    if bars_15m:
        execute_values(
            cursor,
            "INSERT INTO bt_15m (symbol, datetime, open, high, low, close, volume) VALUES %s "
            "ON CONFLICT (symbol, datetime) DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high, "
            "low = EXCLUDED.low, close = EXCLUDED.close, volume = EXCLUDED.volume",
            [(symbol, b["date"], b["open"], b["high"], b["low"], b["close"], int(b.get("volume") or 0)) for b in bars_15m],
            page_size=5000,
        )
    if bars_day:
        execute_values(
            cursor,
            "INSERT INTO bt_daily (symbol, day, open, high, low, close, volume) VALUES %s "
            "ON CONFLICT (symbol, day) DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high, "
            "low = EXCLUDED.low, close = EXCLUDED.close, volume = EXCLUDED.volume",
            [(symbol, b["date"].date(), b["open"], b["high"], b["low"], b["close"], int(b.get("volume") or 0)) for b in bars_day],
            page_size=5000,
        )


def download(on_progress=None, datasets=DATASETS, rerun=True):
    """Fetch or top up 15m and daily bars: the F&O indices and F&O stocks from INDEX_DAILY_FROM /
    INDEX_15M_FROM (as far as Kite has them; earlier history is backfilled)."""
    def report(**state):
        if on_progress:
            on_progress(state)

    stocks = _constituents() if "stocks" in datasets else []
    fno = _fno_stocks() if "fno" in datasets else []
    kite = kite_auth.trading_client()
    tokens = {
        row["tradingsymbol"]: row["instrument_token"]
        for row in kite.instruments("NSE")
        if row["segment"] in ("NSE", "INDICES")
    }
    wanted = ([("indices", name, future) for name, future in FNO_INDICES if "indices" in datasets]
              + [("fno", s, n) for s, n in fno] + [("stocks", s, n) for s, n in stocks])
    today = date.today()
    first = today - timedelta(days=round(365.25 * YEARS))
    candles, errors = 0, []

    with connect() as conn, conn.cursor() as cursor:
        _ensure_tables(cursor)
        refreshed = [d for d in ("stocks", "fno") if d in datasets]
        cursor.execute("DELETE FROM bt_symbols WHERE dataset = ANY(%s) OR NOT (dataset = ANY(%s))",
                       (refreshed, list(DATASETS)))
        execute_values(cursor, "INSERT INTO bt_symbols (dataset, symbol, name) VALUES %s ON CONFLICT DO NOTHING",
                       [(d, s, n) for d, s, n in wanted])
        conn.commit()

        fetched = set()
        for index, (dataset, symbol, _) in enumerate(wanted):
            report(status="running", phase="download", done=index, total=len(wanted), symbol=symbol,
                   candles=candles, errors=list(errors))
            if symbol in fetched:  # a Nifty 50 stock is also an F&O stock: one download
                continue
            token = tokens.get(symbol)
            if token is None:
                errors.append(f"{symbol}: not found in Kite instruments")
                continue
            try:
                full = dataset in FULL_HISTORY_DATASETS
                want_15m = INDEX_15M_FROM if full else first
                want_day = INDEX_DAILY_FROM if full else first - timedelta(days=DAILY_LEAD)
                bars_15m, bars_day = [], []
                for table, column, want, interval, chunk, out in (
                    ("bt_15m", "datetime", want_15m, "15minute", CHUNK_15M, bars_15m),
                    ("bt_daily", "day", want_day, "day", CHUNK_DAY, bars_day),
                ):
                    first_have = _last_stored(cursor, table, column, symbol, "min")
                    last_have = _last_stored(cursor, table, column, symbol)
                    if first_have is None:
                        out.extend(_fetch(kite, token, want, today, interval, chunk))
                        continue
                    if first_have > want + timedelta(days=7):  # backfill older history
                        out.extend(_fetch(kite, token, want, first_have - timedelta(days=1), interval, chunk))
                    out.extend(_fetch(kite, token, last_have, today, interval, chunk))
                _store(cursor, symbol, bars_15m, bars_day)
                conn.commit()
                fetched.add(symbol)
                candles += len(bars_15m)
            except TokenException:
                raise  # expired Kite login: every request would fail, so stop now
            except Exception as error:
                conn.rollback()
                print(f"Backtest download failed for {symbol}:", error)
                errors.append(f"{symbol}: {error}")

    if not rerun:
        return {"symbols": len(wanted), "candles": candles, "errors": errors}
    report(status="running", phase="backtest", done=0, total=len(wanted), symbol="all models", candles=candles,
           errors=list(errors))
    run_backtest()
    report(status="completed", phase="done", done=len(wanted), total=len(wanted), symbol="", candles=candles,
           errors=list(errors))
    return {"symbols": len(wanted), "candles": candles, "errors": errors}


def _symbols(cursor, dataset):
    cursor.execute("SELECT symbol FROM bt_symbols WHERE dataset = %s ORDER BY symbol", (dataset,))
    return [row[0] for row in cursor.fetchall()]


def _load_symbol(conn, symbol):
    bars = pd.read_sql(
        "SELECT datetime, open, high, low, close, volume FROM bt_15m WHERE symbol = %s ORDER BY datetime",
        conn, params=[symbol],
    )
    daily = pd.read_sql(
        f"SELECT day AS datetime, open, high, low, close FROM bt_daily WHERE symbol = %s AND {REAL_OHLC} ORDER BY day",
        conn, params=[symbol, symbol],
    )
    if not bars.empty:
        bars["datetime"] = pd.to_datetime(bars["datetime"], utc=True).dt.tz_convert("Asia/Kolkata")
    return bars, daily


def _load_dataset_symbol(conn, dataset, symbol):
    """Every dataset uses each symbol's full stored history (the Nifty 50 stocks share candles with "fno")."""
    return _load_symbol(conn, symbol)


def _kbdt_signals(symbol, first_day):
    """Replay KBDT day by day from first_day; returns {day: (side, level, stop)}.

    Each day is enriched from the trailing KBDT_WINDOW daily bars ending that day,
    then scanned on its last bar, as the live scanner does. Days already replayed
    are read back from bt_kbdt_signals.
    """
    with connect() as conn:
        daily = pd.read_sql(
            f"SELECT day AS datetime, open, high, low, close, volume FROM bt_daily WHERE symbol = %s AND {REAL_OHLC} "
            "ORDER BY day",
            conn, params=[symbol, symbol],
        )
        with conn.cursor() as cursor:
            cursor.execute("SELECT first_day, last_day FROM bt_kbdt_progress WHERE symbol = %s", (symbol,))
            row = cursor.fetchone()
            done_from, done_through = (row[0] or row[1], row[1]) if row else (None, None)
            cursor.execute("SELECT day, side, level, stop FROM bt_kbdt_signals WHERE symbol = %s", (symbol,))
            signals = {day: (side, level, stop) for day, side, level, stop in cursor.fetchall()}
        if daily.empty:
            return signals
        daily["datetime"] = pd.to_datetime(daily["datetime"])
        days = daily["datetime"].dt.date
        new = []
        lo, hi = done_from, done_through
        for i in range(len(daily)):
            day = days.iloc[i]
            if day < first_day or (done_through and done_from <= day <= done_through) or day >= date.today():
                continue
            window = daily.iloc[max(0, i - KBDT_WINDOW + 1): i + 1]
            hits = signals2(enrich_eod(window, project=False), models=["KBDT"])
            lo, hi = min(lo or day, day), max(hi or day, day)
            if hits.empty:
                continue
            hit = hits.iloc[-1]
            if pd.to_datetime(hit["datetime"]).date() != day or pd.isna(hit.get("signal_price")) or pd.isna(hit.get("stop_loss")):
                continue
            side = "long" if str(hit["kbdt"]).lower() == "buy" else "short"
            signals[day] = (side, float(hit["signal_price"]), float(hit["stop_loss"]))
            new.append((symbol, day, side, float(hit["signal_price"]), float(hit["stop_loss"])))
        with conn.cursor() as cursor:
            if new:
                execute_values(cursor, "INSERT INTO bt_kbdt_signals (symbol, day, side, level, stop) VALUES %s "
                                       "ON CONFLICT (symbol, day) DO NOTHING", new)
            if hi and (lo, hi) != (done_from, done_through):
                cursor.execute("INSERT INTO bt_kbdt_progress (symbol, first_day, last_day) VALUES (%s, %s, %s) "
                               "ON CONFLICT (symbol) DO UPDATE SET first_day = EXCLUDED.first_day, "
                               "last_day = EXCLUDED.last_day", (symbol, lo, hi))
        conn.commit()
    return signals


def _kbdt_trades(signals, bars, hold_days, stop_pct=None, stop_mode="model"):
    """Simulate KBDT signals on 15m bars: enter at the key-break level (or the open
    if price gapped past it), stop at the previous day's low/high, exit at 15:15 on
    the hold_days-th trading day (entry day = day 1). One position at a time.

    stop_pct changes the stop: stop_mode "fixed" puts it stop_pct % from entry
    instead; "cap" keeps the model stop but never further than stop_pct %."""
    if not signals or bars.empty:
        return []
    bars = bars.reset_index(drop=True)
    day_of = bars["datetime"].dt.date
    trading_days = sorted(day_of.unique())
    day_index = {d: i for i, d in enumerate(trading_days)}
    starts = {d: int(idx[0]) for d, idx in bars.groupby(day_of).indices.items()}
    ends = {d: int(idx[-1]) for d, idx in bars.groupby(day_of).indices.items()}
    exit_clock = time_of_day(*KBDT_EXIT)
    trades, busy_until = [], None

    for day in sorted(signals):
        if day not in day_index or (busy_until and day <= busy_until):
            continue
        side, level, stop = signals[day]
        long = side == "long"
        # Entry: first 15m bar of the day that trades through the level.
        entry_i = None
        for i in range(starts[day], ends[day] + 1):
            bar = bars.iloc[i]
            if (long and bar["high"] >= level) or (not long and bar["low"] <= level):
                entry_i = i
                break
        if entry_i is None:
            continue
        entry_bar = bars.iloc[entry_i]
        if hold_days == 1 and entry_bar["datetime"].time() >= exit_clock:
            continue
        entry = max(level, float(entry_bar["open"])) if long else min(level, float(entry_bar["open"]))
        if stop_pct:
            fixed = entry * (1 - stop_pct / 100) if long else entry * (1 + stop_pct / 100)
            if stop_mode == "fixed":
                stop = fixed
            elif stop_mode == "cap":
                stop = max(stop, fixed) if long else min(stop, fixed)
        risk = entry - stop if long else stop - entry
        if risk <= 0:
            continue
        last_day_i = day_index[day] + hold_days - 1
        exit_px = exit_bar = reason = None
        for i in range(entry_i, len(bars)):
            bar = bars.iloc[i]
            bar_day_i = day_index[day_of.iloc[i]]
            if bar_day_i > last_day_i:
                break
            if bar_day_i == last_day_i and bar["datetime"].time() >= exit_clock:
                exit_px, exit_bar, reason = float(bar["open"]), bar, "time"
                break
            gap = i > entry_i and ((long and bar["open"] <= stop) or (not long and bar["open"] >= stop))
            if gap:
                exit_px, exit_bar, reason = float(bar["open"]), bar, "stop (gap)"
                break
            if (long and bar["low"] <= stop) or (not long and bar["high"] >= stop):
                exit_px, exit_bar, reason = stop, bar, "stop"
                break
        status = "closed"
        if exit_px is None:
            last_day = trading_days[min(last_day_i, len(trading_days) - 1)]
            final = bars.iloc[ends[last_day]]
            if last_day_i >= len(trading_days) or last_day >= date.today():
                status, reason = "open", "open"
            else:
                reason = "session end"
            exit_px, exit_bar = float(final["close"]), final
        sign = 1 if long else -1
        exit_day = exit_bar["datetime"].date()
        busy_until = exit_day
        trades.append({
            "date": day.isoformat(), "side": side, "entry_time": _epoch(entry_bar["datetime"]),
            "entry_label": entry_bar["datetime"].strftime("%H:%M"), "entry": round(entry, 2), "stop": round(stop, 2),
            "exit": round(exit_px, 2), "exit_reason": reason, "r": round(sign * (exit_px - entry) / risk, 3),
            "status": status, "exit_date": exit_day.isoformat(),
        })
    return trades


def _epoch(ts):
    return orb._epoch_ist(ts)


def _scan_one(item):
    """Every KBDT variant and the buy-on-gap candidates for one symbol (runs in a worker process)."""
    dataset, symbol = item
    with connect() as conn:
        bars, daily = _load_dataset_symbol(conn, dataset, symbol)
    if bars.empty:
        return dataset, symbol, None, [], {}
    rows = []
    first_15m = bars["datetime"].dt.date.min()
    # Indices: replay KBDT from the daily history (after KBDT_WINDOW bars of warm-up);
    # days before the first 15m candle are simulated on daily candles.
    daily_days = pd.to_datetime(daily["datetime"]).dt.date
    first_day = first_15m
    if dataset == "indices" and len(daily) > KBDT_WINDOW:
        first_day = min(first_15m, daily_days.iloc[KBDT_WINDOW])
    daily_ix = daily.set_index(pd.to_datetime(daily["datetime"]))
    gap = {"gap": _gap_candidates(dataset, symbol, bars, daily)}
    if dataset in GAPMOM_DATASETS:
        gap["gapmom"] = _gap_candidates(dataset, symbol, bars, daily, "gapmom")
    for model, variants in VARIANTS.items():
        if model != "kbdt" or dataset in GAP_ONLY_DATASETS:  # gap models are built in run_backtest
            continue
        signals = _kbdt_signals(symbol, first_day)
        early = {d: v for d, v in signals.items() if d < first_15m}
        for variant, params in variants.items():
            found, busy_until = [], None
            for day in sorted(early):
                if busy_until and day <= busy_until:
                    continue
                t = _daily_trade(day, early[day], daily_ix, params["hold_days"], params["stop_pct"], params["stop_mode"])
                if t:
                    t["entry_time"] = _epoch(pd.Timestamp(day).tz_localize("Asia/Kolkata") + pd.Timedelta(hours=9, minutes=15))
                    found.append(t)
                    busy_until = date.fromisoformat(t["exit_date"])
            later = {d: v for d, v in signals.items() if d >= first_15m and not (busy_until and d <= busy_until)}
            found += _kbdt_trades(later, bars, params["hold_days"], params["stop_pct"], params["stop_mode"])
            for t in found:
                rows.append((model, variant, dataset, symbol, t["date"], t["side"], t["entry_time"], t["entry_label"],
                             t["entry"], t["stop"], None, t["exit"], t["exit_reason"], False, t["r"], t["status"],
                             t["exit_date"]))
    covered = daily_days[(daily_days >= first_day)]
    return (dataset, symbol, (first_day, max(covered.max(), bars["datetime"].dt.date.max()), covered.nunique()),
            rows, gap)


def _gap_candidates(dataset, symbol, bars, daily, model="gap"):
    """Every buy-on-gap setup of one symbol, simulated on its 15m bars, before the daily top-N ranking.

    model "gap" fades the gap (buy-on-gap, with the 20-day average filter); "gapmom" follows it
    (opening gap momentum, no filter). Returns {(threshold, sides, stop, hold): [(day, score, row), ...]}; score is the size of the gap
    (as a return from the previous low/high to the open) used to rank the day's candidates.
    Signals use only data known at the open: the previous day's low/high, the 20-day average
    and the 90-day standard deviation of close-to-close returns up to the previous close.
    """
    out = {}
    if bars.empty or len(daily) <= GAP_SD_DAYS:
        return out
    d = daily.copy()
    d["day"] = pd.to_datetime(d["datetime"]).dt.date
    d = d.set_index("day")
    prev_close = d["close"].shift(1)
    sd = d["close"].pct_change().rolling(GAP_SD_DAYS).std().shift(1)
    ma = d["close"].rolling(GAP_MA_DAYS).mean().shift(1)
    gap_down = d["open"] / d["low"].shift(1) - 1  # negative: opened below the previous low
    gap_up = d["open"] / d["high"].shift(1) - 1  # positive: opened above the previous high

    bars = bars.reset_index(drop=True)
    day_of = bars["datetime"].dt.date
    time_of = bars["datetime"].dt.time
    groups = bars.groupby(day_of).indices
    trading_days = sorted(groups)
    day_pos = {dd: k for k, dd in enumerate(trading_days)}
    o, h, l, c = (bars[col].to_numpy(float) for col in ("open", "high", "low", "close"))
    exit_bar_at = time_of_day(*GAP_EXIT_BAR)
    today = date.today()

    def time_exit(day, hold):
        """(bar index, price, reason, status) of the time exit on the hold-th day from `day`:
        the close of its 15:00 candle, i.e. the price at 15:15."""
        k = day_pos[day] + hold - 1
        if k >= len(trading_days):  # the hold runs past the data: still open at the last close
            return len(bars) - 1, c[-1], "open", "open"
        idx = groups[trading_days[k]]
        i = next((int(j) for j in idx if time_of.iloc[j] == exit_bar_at), None)
        if i is None:  # a short session with no 15:00 candle: out at its close
            i = int(idx[-1])
            return i, c[i], "session end", "closed"
        return i, c[i], "time", "closed"

    for day, idx in groups.items():
        if day not in d.index or day >= today or len(idx) < GAP_MIN_SESSION_BARS:
            continue
        sigma, avg = sd.get(day), ma.get(day)
        if pd.isna(sigma) or pd.isna(avg) or sigma <= 0 or pd.isna(prev_close.get(day)):
            continue
        start, end = int(idx[0]), int(idx[-1])
        if time_of.iloc[start] != time_of_day(9, 15):
            continue
        if not any(time_of.iloc[i] == exit_bar_at for i in range(start + 1, end + 1)):
            continue
        exits = {hold: time_exit(day, hold) for hold in GAP_HOLDS}
        entry = o[start]
        # Corporate-action days can carry a stale 09:15 print (TMPV on its 2025-10-14 demerger
        # opened at 400 but the first 15m candle shows 561.65): skip when the two opens disagree.
        if abs(entry / d.at[day, "open"] - 1) > GAP_OPEN_TOLERANCE:
            continue
        if model == "gap":  # fade: buy below the previous low, sell above the previous high
            setups = (("long", gap_down[day], -1, entry > avg), ("short", gap_up[day], 1, entry < avg))
        else:  # follow: buy above the previous high, sell below the previous low
            setups = (("long", gap_up[day], 1, True), ("short", gap_down[day], -1, True))
        for side, gap_ret, direction, ok in setups:
            if pd.isna(gap_ret) or not ok:
                continue
            long = side == "long"
            sigmas = direction * gap_ret / sigma
            risk = entry * sigma
            stop = entry - risk if long else entry + risk
            for threshold in {p["threshold"] for p in VARIANTS[model].values()}:
                if sigmas <= threshold:
                    continue
                for stop_mode, hold in itertools.product(("none", "1sd"), {p["hold"] for p in VARIANTS[model].values()}):
                    exit_bar, exit_px, reason, status = exits[hold]
                    if stop_mode == "1sd":
                        for i in range(start, exit_bar + 1):  # the exit candle counts: we exit at its close
                            if i > start and ((long and o[i] <= stop) or (not long and o[i] >= stop)):
                                exit_bar, exit_px, reason, status = i, o[i], "stop (gap)", "closed"
                                break
                            if (long and l[i] <= stop) or (not long and h[i] >= stop):
                                exit_bar, exit_px, reason, status = i, stop, "stop", "closed"
                                break
                    sign = 1 if long else -1
                    ts = bars["datetime"].iloc[start]
                    row = (dataset, symbol, day.isoformat(), side, _epoch(ts), ts.strftime("%H:%M"),
                           round(float(entry), 2), round(float(stop), 2), None, round(float(exit_px), 2), reason, False,
                           round(float(sign * (exit_px - entry) / risk), 3), status, day_of.iloc[exit_bar].isoformat())
                    for sides in ("long", "both"):
                        if sides == "long" and not long:
                            continue
                        out.setdefault((threshold, sides, stop_mode, hold), []).append((day, abs(float(gap_ret)), row))
    return out


def _gap_one(item):
    """Gap-model candidates and the scanned span of one symbol (runs in a worker process):
    {model: candidates} for buy-on-gap, plus opening gap momentum on its datasets."""
    dataset, symbol = item
    with connect() as conn:
        bars, daily = _load_dataset_symbol(conn, dataset, symbol)
    if bars.empty:
        return dataset, None, {}
    days = bars["datetime"].dt.date
    found = {"gap": _gap_candidates(dataset, symbol, bars, daily)}
    if dataset in GAPMOM_DATASETS:
        found["gapmom"] = _gap_candidates(dataset, symbol, bars, daily, "gapmom")
    return dataset, (days.min(), days.max(), days.nunique()), found


def run_gap_backtest():
    """Rerun only the gap models (buy-on-gap, opening gap momentum): replaces their trades and leaves
    every other model's untouched.
    Also records the run span of the gap-only datasets (bt_runs)."""
    with connect() as conn, conn.cursor() as cursor:
        _ensure_tables(cursor)
        conn.commit()
        cursor.execute("SELECT dataset, symbol FROM bt_symbols ORDER BY dataset, symbol")
        items = cursor.fetchall()
    workers = max(1, min(8, (multiprocessing.cpu_count() or 2) - 1))
    with multiprocessing.get_context("spawn").Pool(workers) as pool:
        found = pool.map(_gap_one, items)
    rows = []
    for model in GAP_MODELS:
        rows += _gap_rows([(dataset, gap.get(model, {})) for dataset, _, gap in found], model)
    runs = {}
    for dataset, span, _ in found:
        if span and dataset in GAP_ONLY_DATASETS:
            run = runs.setdefault(dataset, {"first": span[0], "last": span[1], "days": 0, "symbols": 0})
            run["first"], run["last"] = min(run["first"], span[0]), max(run["last"], span[1])
            run["days"], run["symbols"] = max(run["days"], span[2]), run["symbols"] + 1
    with connect() as conn, conn.cursor() as cursor:
        cursor.execute("DELETE FROM bt_trades WHERE model = ANY(%s)", (list(GAP_MODELS),))
        execute_values(cursor, "INSERT INTO bt_trades (model, variant, dataset, symbol, date, side, entry_time, entry_label, "
                               "entry, stop, target, exit, exit_reason, t1_hit, r, status, exit_date) VALUES %s "
                               "ON CONFLICT DO NOTHING", rows, page_size=5000)
        for dataset, run in runs.items():
            cursor.execute(
                "INSERT INTO bt_runs (dataset, ran_at, first_day, last_day, symbols, days_scanned) "
                "VALUES (%s, now(), %s, %s, %s, %s) ON CONFLICT (dataset) DO UPDATE SET ran_at = EXCLUDED.ran_at, "
                "first_day = EXCLUDED.first_day, last_day = EXCLUDED.last_day, symbols = EXCLUDED.symbols, "
                "days_scanned = EXCLUDED.days_scanned",
                (dataset, run["first"], run["last"], run["symbols"], run["days"]),
            )
        conn.commit()
    _compare_cache.clear()
    return len(rows)


def _gap_rows(candidates, model="gap"):
    """Rank each day's gap candidates per dataset and keep the top N for every gap variant.

    Stocks still held from an earlier gap (multi-day holds) can't be bought again until the
    day after their exit, so they drop out before the day's ranking."""
    rows = []
    for variant, params in VARIANTS[model].items():
        key = (params["threshold"], params["sides"], params["stop"], params["hold"])
        by_day = {}
        for dataset, found in candidates:
            for day, score, row in found.get(key, []):
                by_day.setdefault((dataset, day), []).append((score, row))
        busy = {}  # (dataset, symbol) -> exit date (ISO)
        for (dataset, day), picks in sorted(by_day.items(), key=lambda kv: kv[0][1]):
            iso = day.isoformat()
            picks = [p for p in picks if busy.get((dataset, p[1][1]), "") < iso]
            picks.sort(key=lambda p: -p[0])
            for _, row in picks[: params["top"]]:
                rows.append((model, variant, *row))
                busy[(dataset, row[1])] = row[-1]
    return rows


def run_backtest():
    """Rerun every KBDT and buy-on-gap variant over all stored symbols and replace the stored trades."""
    with connect() as conn, conn.cursor() as cursor:
        _ensure_tables(cursor)
        conn.commit()
        cursor.execute("SELECT dataset, symbol FROM bt_symbols ORDER BY dataset, symbol")
        items = cursor.fetchall()
    # spawn, not fork: this runs inside the API server's thread.
    workers = max(1, min(8, (multiprocessing.cpu_count() or 2) - 1))
    with multiprocessing.get_context("spawn").Pool(workers) as pool:
        results_ = pool.map(_scan_one, items)
    runs = {}
    gap_rows = []
    for model in GAP_MODELS:
        gap_rows += _gap_rows([(dataset, (gap or {}).get(model, {})) for dataset, _, _, _, gap in results_], model)
    results_.append((None, None, None, gap_rows, None))
    with connect() as conn, conn.cursor() as cursor:
        cursor.execute("DELETE FROM bt_trades")
        cursor.execute("DELETE FROM bt_runs WHERE NOT (dataset = ANY(%s))", (list(DATASETS),))
        for dataset, _, span, rows, _ in results_:
            if span:
                first, last, days = span
                run = runs.setdefault(dataset, {"first": first, "last": last, "days": 0, "symbols": 0})
                run["first"], run["last"] = min(run["first"], first), max(run["last"], last)
                run["days"], run["symbols"] = max(run["days"], days), run["symbols"] + 1
            if rows:
                execute_values(
                    cursor,
                    "INSERT INTO bt_trades (model, variant, dataset, symbol, date, side, entry_time, entry_label, entry, "
                    "stop, target, exit, exit_reason, t1_hit, r, status, exit_date) VALUES %s ON CONFLICT DO NOTHING",
                    rows,
                    page_size=5000,
                )
        for dataset, run in runs.items():
            cursor.execute(
                "INSERT INTO bt_runs (dataset, ran_at, first_day, last_day, symbols, days_scanned) "
                "VALUES (%s, now(), %s, %s, %s, %s) ON CONFLICT (dataset) DO UPDATE SET ran_at = EXCLUDED.ran_at, "
                "first_day = EXCLUDED.first_day, last_day = EXCLUDED.last_day, symbols = EXCLUDED.symbols, "
                "days_scanned = EXCLUDED.days_scanned",
                (dataset, run["first"], run["last"], run["symbols"], run["days"]),
            )
        conn.commit()
    _compare_cache.clear()


def _cost_r(trade, dataset, slippage):
    """Round-trip cost of one trade in R: futures charges plus slippage on both sides."""
    entry, risk = trade["entry"], abs(trade["entry"] - trade["stop"])
    if risk <= 0:
        return 0.0
    points = trade["r"] * risk
    exit_px = entry + points if trade["side"] == "long" else entry - points
    buy, sell = (entry, exit_px) if trade["side"] == "long" else (exit_px, entry)
    orders = 3 if trade["t1_hit"] else 2
    brokerage = BROKERAGE_PER_ORDER * orders / LOT_NOTIONAL[dataset] * entry
    exchange = (buy + sell) * EXCHANGE
    sebi = (buy + sell) * SEBI
    charges = brokerage + exchange + sebi + sell * STT_SELL + buy * STAMP_BUY + (brokerage + exchange + sebi) * GST
    return (charges + (buy + sell) * slippage) / risk


def _load_trades(model, variant, dataset, max_per_day, slippage):
    with connect() as conn, conn.cursor() as cursor:
        _ensure_tables(cursor)
        cursor.execute(
            "SELECT symbol, date, side, entry_time, entry_label, entry, stop, target, exit, exit_reason, t1_hit, r, status, "
            "exit_date FROM bt_trades WHERE model = %s AND variant = %s AND dataset = %s ORDER BY date, entry_time",
            (model, variant, dataset),
        )
        columns = [c.name for c in cursor.description]
        trades = [dict(zip(columns, row)) for row in cursor.fetchall()]
        cursor.execute("SELECT ran_at, first_day, last_day, symbols, days_scanned FROM bt_runs WHERE dataset = %s",
                       (dataset,))
        row = cursor.fetchone()
    run = None
    if row:
        run = dict(zip(("ran_at", "first_day", "last_day", "symbols", "days_scanned"), row))
        run = {k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in run.items()}
    for t in trades:
        t["date"] = t["date"].isoformat()
        t["exit_date"] = t["exit_date"].isoformat() if t["exit_date"] else t["date"]
    if max_per_day:
        trades = [t for t in orb.cap_per_day(trades, max_per_day) if t["status"] in ("closed", "open")]
    lots = stored_lot_sizes()
    for t in trades:
        t["cost_r"] = round(_cost_r(t, dataset, slippage), 3)
        t["net_r"] = round(t["r"] - t["cost_r"], 3)
        # Rupees for one lot at today's lot size: R x risk points x lot.
        lot = lots.get(("NSE", FUTURES_NAME.get(t["symbol"], t["symbol"])))
        t["lot_size"] = lot
        if lot:
            risk_rs = abs(t["entry"] - t["stop"]) * lot
            t["risk_rs"] = round(risk_rs)
            t["gross_rs"] = round(t["r"] * risk_rs)
            t["cost_rs"] = round(t["cost_r"] * risk_rs)
            t["net_rs"] = round(t["net_r"] * risk_rs)
        else:
            t["risk_rs"] = t["gross_rs"] = t["cost_rs"] = t["net_rs"] = None
    return trades, run


def _group(frame, key):
    rows = []
    for value, g in frame.groupby(key):
        rows.append({
            key: value,
            "trades": len(g),
            "win_rate": round(float(100 * (g["net_r"] > 0).mean()), 1),
            "gross_r": round(float(g["r"].sum()), 2),
            "net_r": round(float(g["net_r"].sum()), 2),
            "gross_rs": round(float(g["gross_rs"].sum())),
            "net_rs": round(float(g["net_rs"].sum())),
        })
    return rows


def _summary(trades):
    frame = pd.DataFrame(trades)
    frame["year"] = frame["date"].str[:4]
    for column in ("risk_rs", "gross_rs", "cost_rs", "net_rs"):
        frame[column] = pd.to_numeric(frame[column]).fillna(0)
    net, gross = frame["net_r"], frame["r"]
    daily = frame.groupby("date")[["r", "net_r", "gross_rs", "net_rs"]].sum()
    equity_net = daily["net_r"].cumsum()
    equity_rs = daily["net_rs"].cumsum()
    wins, losses = net[net > 0].sum(), -net[net <= 0].sum()
    std = net.std()
    yearly = frame.groupby("year")["net_r"].sum()
    return frame, daily, {
        "trades": int(len(frame)),
        "days": int(daily.shape[0]),
        "win_rate_gross": round(float(100 * (gross > 0).mean()), 1),
        "win_rate": round(float(100 * (net > 0).mean()), 1),
        "gross_r": round(float(gross.sum()), 2),
        "avg_gross_r": round(float(gross.mean()), 3),
        "net_r": round(float(net.sum()), 2),
        "avg_cost_r": round(float(frame["cost_r"].mean()), 3),
        "avg_net_r": round(float(net.mean()), 3),
        "profit_factor": round(float(wins / losses), 2) if losses > 0 else None,
        "max_drawdown_r": round(float((equity_net - equity_net.cummax()).min()), 2),
        "gross_rs": round(float(frame["gross_rs"].sum())),
        "net_rs": round(float(frame["net_rs"].sum())),
        "avg_cost_rs": round(float(frame["cost_rs"].mean())),
        "avg_net_rs": round(float(frame["net_rs"].mean())),
        "median_risk_rs": round(float(frame["risk_rs"].median())),
        "max_drawdown_rs": round(float((equity_rs - equity_rs.cummax()).min())),
        "no_lot_size": int(frame["lot_size"].isna().sum()),
        "t_stat": round(float(net.mean() / (std / len(net) ** 0.5)), 2) if std and len(net) > 1 else None,
        "green_years": int((yearly > 0).sum()),
        "years": int(len(yearly)),
        "median_risk_pct": round(float(((frame["entry"] - frame["stop"]).abs() / frame["entry"] * 100).median()), 2),
        "long": int((frame["side"] == "long").sum()),
        "short": int((frame["side"] == "short").sum()),
    }


def results(model, variant, dataset, max_per_day=3, slippage=0.0002):
    trades, run = _load_trades(model, variant, dataset, max_per_day, slippage)
    if not trades:
        return {"run": run, "summary": None, "years": [], "months": [], "equity": []}
    frame, daily, summary = _summary(trades)
    frame["month"] = frame["date"].str[:7]
    equity_net, equity_gross = daily["net_r"].cumsum(), daily["r"].cumsum()
    equity_net_rs, equity_gross_rs = daily["net_rs"].cumsum(), daily["gross_rs"].cumsum()
    equity = [{"date": d, "gross": round(float(g), 2), "net": round(float(n), 2),
               "gross_rs": round(float(gr)), "net_rs": round(float(nr))}
              for d, g, n, gr, nr in zip(daily.index, equity_gross, equity_net, equity_gross_rs, equity_net_rs)]
    lots = sorted({(t["symbol"], t["lot_size"]) for t in trades if t["lot_size"]})
    return {"run": run, "summary": summary, "years": _group(frame, "year"), "months": _group(frame, "month"),
            "equity": equity, "lots": [{"symbol": s, "lot_size": l} for s, l in lots]}


def month_trades(model, variant, dataset, month, max_per_day=3, slippage=0.0002):
    trades, _ = _load_trades(model, variant, dataset, max_per_day, slippage)
    return [t for t in trades if t["date"].startswith(month)]


_compare_cache = {}


def compare(dataset, max_per_day=3, slippage=0.0002, model_filter=None):
    """One summary row per model and variant, for the comparison table."""
    if model_filter:
        return [r for r in compare(dataset, max_per_day, slippage) if r["model"] == model_filter]
    key = (dataset, max_per_day, slippage)
    if key in _compare_cache:
        return _compare_cache[key]
    rows = []
    for model, variants in VARIANTS.items():
        for variant, params in variants.items():
            trades, _ = _load_trades(model, variant, dataset, max_per_day, slippage)
            if not trades:
                continue
            _, _, summary = _summary(trades)
            rows.append({"model": model, "variant": variant, "name": MODEL_NAMES[model], "params": params,
                         "live": params.get("stop_mode") == "model" or variant in (GAP_BOOK, GAPMOM_BOOK),
                         **summary})
    _compare_cache[key] = rows
    return rows


FUT_MIN_BARS = 60  # daily bars needed before a futures day is scanned (about 3 months)


def _ensure_fut_tables(cursor):
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS kbdt_fut_signals (
            symbol TEXT NOT NULL,
            day DATE NOT NULL,
            side TEXT NOT NULL,
            level DOUBLE PRECISION NOT NULL,
            stop DOUBLE PRECISION NOT NULL,
            PRIMARY KEY (symbol, day)
        );
        CREATE TABLE IF NOT EXISTS kbdt_fut_progress (
            symbol TEXT PRIMARY KEY,
            last_day DATE NOT NULL
        );
        """
    )


def _futures_signals(future, daily):
    """KBDT signals for every futures day with enough history, replayed day by day.
    Finished days are stored; today's still-forming day is always recomputed."""
    today = date.today()
    days = [d.date() for d in daily.index]
    with connect() as conn, conn.cursor() as cursor:
        _ensure_fut_tables(cursor)
        cursor.execute("SELECT last_day FROM kbdt_fut_progress WHERE symbol = %s", (future,))
        row = cursor.fetchone()
        done_through = row[0] if row else None
        cursor.execute("SELECT day, side, level, stop FROM kbdt_fut_signals WHERE symbol = %s", (future,))
        signals = {d: (side, level, stop) for d, side, level, stop in cursor.fetchall()}
        new, last = [], done_through
        for i in range(FUT_MIN_BARS - 1, len(daily)):
            day = days[i]
            if done_through and day <= done_through:
                continue
            window = daily.iloc[max(0, i - KBDT_WINDOW + 1): i + 1]
            hits = signals2(enrich_eod(window, project=False), models=["KBDT"])
            found = None
            if not hits.empty:
                hit = hits.iloc[-1]
                if (pd.to_datetime(hit["datetime"]).date() == day and pd.notna(hit.get("signal_price"))
                        and pd.notna(hit.get("stop_loss"))):
                    side = "long" if str(hit["kbdt"]).lower() == "buy" else "short"
                    found = (side, float(hit["signal_price"]), float(hit["stop_loss"]))
            if day >= today:
                if found:
                    signals[day] = found
                else:
                    signals.pop(day, None)
                continue
            last = day
            if found:
                signals[day] = found
                new.append((future, day, *found))
        if new:
            execute_values(cursor, "INSERT INTO kbdt_fut_signals (symbol, day, side, level, stop) VALUES %s "
                                   "ON CONFLICT (symbol, day) DO NOTHING", new)
        if last and last != done_through:
            cursor.execute("INSERT INTO kbdt_fut_progress (symbol, last_day) VALUES (%s, %s) ON CONFLICT (symbol) "
                           "DO UPDATE SET last_day = EXCLUDED.last_day", (future, last))
        conn.commit()
    return signals


def _daily_trade(day, signal, daily, hold_days, stop_pct, stop_mode):
    """Estimate a KBDT trade from daily candles (no 15m data): enter at the level, or
    the open if it gapped past; a stop touched on the entry day counts as hit;
    later days check gaps then lows/highs; exit at the close of the hold_days-th day."""
    side, level, stop = signal
    long = side == "long"
    days = [d.date() for d in daily.index]
    i = days.index(day)
    bar = daily.iloc[i]
    entry = max(level, float(bar["open"])) if long else min(level, float(bar["open"]))
    if stop_pct:
        fixed = entry * (1 - stop_pct / 100) if long else entry * (1 + stop_pct / 100)
        stop = fixed if stop_mode == "fixed" else (max(stop, fixed) if long else min(stop, fixed))
    risk = entry - stop if long else stop - entry
    if risk <= 0:
        return None
    exit_px = exit_day = reason = None
    last_i = i + hold_days - 1
    for j in range(i, min(last_i, len(daily) - 1) + 1):
        b = daily.iloc[j]
        if j > i and ((long and b["open"] <= stop) or (not long and b["open"] >= stop)):
            exit_px, exit_day, reason = float(b["open"]), days[j], "stop (gap)"
            break
        if (long and b["low"] <= stop) or (not long and b["high"] >= stop):
            exit_px, exit_day, reason = stop, days[j], "stop"
            break
        if j == last_i:
            exit_px, exit_day, reason = float(b["close"]), days[j], "time (close)"
    status = "closed"
    if exit_px is None or (exit_day >= date.today() and reason.startswith("time")):
        status, reason = "open", "open"
        exit_px, exit_day = float(daily.iloc[-1]["close"]), days[-1]
    sign = 1 if long else -1
    return {"date": day.isoformat(), "side": side, "entry_time": None, "entry_label": "daily", "entry": round(entry, 2),
            "stop": round(stop, 2), "exit": round(exit_px, 2), "exit_reason": reason,
            "r": round(sign * (exit_px - entry) / risk, 3), "status": status, "exit_date": exit_day.isoformat()}


def recent_kbdt_signals(hold_days=5, stop_mode="model", stop_pct=None, slippage=0.0002, days=None):
    """KBDT signals on the index futures (all available days, or the last `days`),
    with how each trades under the chosen exit and stop.

    Uses the live futures data (continuous daily bars in `eod`, 15m bars in
    `intraday_15m`), replayed day by day exactly like the backtest. Trades whose
    entry day has 15m candles are simulated on them; older ones are estimated
    from daily candles. One open position per futures contract at a time.
    """
    from db import fetch_eod_frame

    lots = stored_lot_sizes()
    rows, freshness = [], {}
    for index_name, future in FNO_INDICES:
        daily = fetch_eod_frame("NSE", future)
        if daily.empty:
            continue
        daily = daily[["open", "high", "low", "close", "volume"]]
        bars, _ = orb._load("NSE", future)
        intraday_days = set(bars["datetime"].dt.date) if not bars.empty else set()
        freshness[future] = {
            "daily": daily.index[-1].date().isoformat(),
            "daily_from": daily.index[min(FUT_MIN_BARS - 1, len(daily) - 1)].date().isoformat(),
            "intraday": bars["datetime"].max().strftime("%Y-%m-%d %H:%M") if not bars.empty else None,
            "intraday_from": bars["datetime"].min().strftime("%Y-%m-%d") if not bars.empty else None,
        }
        signals = _futures_signals(future, daily)
        trading_days = [d.date() for d in daily.index]
        if days:
            keep = set(trading_days[-days:])
            signals = {d: v for d, v in signals.items() if d in keep}
        lot = lots.get(("NSE", future))
        busy_until = None
        for day in sorted(signals):
            side, level, model_stop = signals[day]
            row = {"date": day.isoformat(), "index": index_name, "symbol": future, "side": side, "level": round(level, 2),
                   "model_stop": round(model_stop, 2), "lot_size": lot, "today": day >= date.today(), "trade": None}
            if busy_until and day <= busy_until:
                row["note"] = "not taken: a position in this future was still open"
                rows.append(row)
                continue
            if day in intraday_days:
                found = _kbdt_trades({day: signals[day]}, bars, hold_days, stop_pct, stop_mode)
                t = found[0] if found else None
                method = "15m"
                if t is None:
                    session = bars[bars["datetime"].dt.date == day]
                    crossed = session[(session["high"] >= level) if side == "long" else (session["low"] <= level)]
                    if crossed.empty:
                        row["note"] = ("not taken: this contract's 15m candles never reached the level "
                                       "(the continuous daily series and the 15m candles differ slightly)")
                    elif hold_days == 1 and crossed.iloc[0]["datetime"].time() >= time_of_day(*KBDT_EXIT):
                        row["note"] = "not taken: the break came at or after 15:15, too late for a same-day exit"
                    else:
                        row["note"] = "not taken: the stop was past the entry price"
            else:
                t = _daily_trade(day, signals[day], daily, hold_days, stop_pct, stop_mode)
                method = "daily"
                if t is None:
                    row["note"] = "not taken: the stop was past the entry"
            if t:
                t["symbol"], t["t1_hit"] = future, False
                cost_r = _cost_r(t, "indices", slippage)
                risk_pts = abs(t["entry"] - t["stop"])
                held = [d for d in trading_days if day <= d <= date.fromisoformat(t["exit_date"])]
                t.update({
                    "method": method, "cost_r": round(cost_r, 3), "net_r": round(t["r"] - cost_r, 3),
                    "risk_rs": round(risk_pts * lot) if lot else None,
                    "net_rs": round((t["r"] - cost_r) * risk_pts * lot) if lot else None,
                    "day_of_hold": min(len(held), hold_days),
                })
                row["trade"] = t
                busy_until = date.fromisoformat(t["exit_date"])
            rows.append(row)
    rows.sort(key=lambda r: (r["date"], r["index"]), reverse=True)
    return {"signals": rows, "freshness": freshness, "days": days}


def _setup_for_next_session(daily):
    """Tomorrow's KBDT setup from daily bars up to the latest close.

    The pending key-break level is the last Dow peak (break up -> BUY) or trough
    (break down -> SELL). To apply the model's own filters, a hypothetical next bar
    that just touches the level is appended and the real signal code is run on it:
    if it fires, the setup is live. Returns a dict, or None without enough data.
    """
    if len(daily) < FUT_MIN_BARS:
        return None
    window = daily.iloc[-KBDT_WINDOW:]
    enriched = enrich_eod(window, project=False)
    last = enriched.iloc[-1]
    if pd.notna(last.get("peak")):
        side, level = "long", float(last["peak"])
    elif pd.notna(last.get("trough")):
        side, level = "short", float(last["trough"])
    else:
        return None
    stop = float(window.iloc[-1]["low"] if side == "long" else window.iloc[-1]["high"])

    # Next weekday stands in for the next session (exchange holidays aren't known here).
    next_day = window.index[-1] + pd.offsets.BDay(1)
    probe = pd.DataFrame(
        [{"open": level, "high": level, "low": level, "close": level, "volume": 0}], index=[next_day]
    )
    probed = enrich_eod(pd.concat([window, probe]), project=False)
    hits = signals2(probed, models=["KBDT"])
    live = not hits.empty and pd.to_datetime(hits.iloc[-1]["datetime"]) == next_day

    # Why it is or isn't live: the weekly low-volatility filter, and the previous
    # opposite key break, which must have been a losing trade.
    lwv = probed.iloc[-1].get("lwv")
    lwv_on = bool(int(lwv)) if pd.notna(lwv) else False
    opposite = -1.0 if side == "long" else 1.0
    prior = probed.iloc[:-1]
    prior = prior[(prior["direction"] == opposite) & prior["dow_cross"].notna()]
    prev_break = float(prior.iloc[-1]["dow_cross"]) if not prior.empty else None
    prev_break_day = prior.index[-1].date().isoformat() if not prior.empty else None
    prev_lost = None
    if prev_break is not None:
        prev_lost = (prev_break - level < 0) if side == "long" else (level - prev_break < 0)
    reasons = []
    if not lwv_on:
        reasons.append("weekly low-volatility filter is off")
    if prev_break is None:
        reasons.append("no earlier opposite key break")
    elif not prev_lost:
        reasons.append("the previous opposite key break was a winner")
    close = float(window.iloc[-1]["close"])
    return {
        "as_of": window.index[-1].date().isoformat(), "side": side, "level": round(level, 2),
        "stop": round(stop, 2), "close": round(close, 2), "live": bool(live), "lwv_on": lwv_on,
        "prev_break": round(prev_break, 2) if prev_break is not None else None, "prev_break_day": prev_break_day,
        "prev_break_lost": prev_lost, "reasons": [] if live else (reasons or ["the model's checks did not pass"]),
    }


def kbdt_setups():
    """Tomorrow's KBDT setups on the five index futures, from their daily bars."""
    from db import fetch_eod_frame

    lots = stored_lot_sizes()
    out = []
    for index_name, future in FNO_INDICES:
        daily = fetch_eod_frame("NSE", future)
        if daily.empty:
            continue
        setup = _setup_for_next_session(daily[["open", "high", "low", "close", "volume"]])
        row = {"index": index_name, "symbol": future, "lot_size": lots.get(("NSE", future))}
        if setup is None:
            row.update({"live": False, "reasons": ["not enough daily history"]})
        else:
            row.update(setup)
            row["forming"] = setup["as_of"] >= date.today().isoformat() and datetime.now().time() < time_of_day(15, 30)
        out.append(row)
    return out


def index_futures_ltp():
    """Last traded price of the current (front-month) contract of each index future."""
    from contracts import list_contracts

    wanted = {future for _, future in FNO_INDICES}
    contracts = {row["name"]: row for row in list_contracts("NSE") if row["name"] in wanted}
    keys = {f"NFO:{row['tradingsymbol']}": name for name, row in contracts.items()}
    if not keys:
        return {}
    quotes = kite_auth.trading_client().ltp(list(keys))
    out = {}
    for key, name in keys.items():
        quote = quotes.get(key)
        if quote:
            out[name] = {"ltp": float(quote["last_price"]), "tradingsymbol": key.split(":", 1)[1],
                         "expiry": contracts[name]["expiry"]}
    return out
