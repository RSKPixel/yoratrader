"""Index option data for straddle backtests: Nifty and Bank Nifty, monthly expiries only.

bt_opt_daily (positional): NSE's daily F&O bhavcopy, 2008 on. Per day, the three nearest monthly expiries
(a month's monthly expiry is its last listed expiry date; weeklies are left out), every call and put
within STRIKE_BAND of the near-month future, and the index futures (type FUT, strike 0): open, high,
low, close, settlement price, open interest, contracts traded; lot size and underlying where NSE gives
them (the new file format, July 2024 on).

bt_opt_1m (intraday): Kite's 1-minute candles of the current and next monthly expiry, the at-the-money
strike +-MINUTE_STRIKES strikes (from that day's index high and low), calls and puts; one row per
contract per day, arrays like bt_1m. Kite only has history for contracts still listed, so this builds
up day by day from the first run (topped up after the close).
"""

import io
import time
import urllib.request
import zipfile
from datetime import date, datetime, timedelta
from datetime import time as clock

import pandas as pd
from psycopg2.extras import execute_values

from db import connect, schema_once

SYMBOLS = ("NIFTY", "BANKNIFTY")
SPOT = {"NIFTY": "NIFTY 50", "BANKNIFTY": "NIFTY BANK"}  # bt_daily / Kite NSE index names
STEP = {"NIFTY": 50, "BANKNIFTY": 100}
STRIKE_BAND = 0.15
MONTHLIES = 3
MINUTE_STRIKES = 10
START = date(2008, 1, 1)
NEW_FROM = date(2024, 7, 8)  # NSE's UDiFF bhavcopy from here
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
SESSION_START = 9 * 60 + 15


@schema_once
def ensure_tables():
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS bt_opt_daily (
                symbol TEXT NOT NULL, day DATE NOT NULL, expiry DATE NOT NULL, strike REAL NOT NULL, type TEXT NOT NULL,
                open REAL, high REAL, low REAL, close REAL, settle REAL, oi BIGINT, contracts BIGINT, lot INTEGER, underlying REAL,
                PRIMARY KEY (symbol, day, expiry, strike, type));
            CREATE INDEX IF NOT EXISTS bt_opt_daily_day ON bt_opt_daily (day);
            CREATE TABLE IF NOT EXISTS bt_opt_1m (
                symbol TEXT NOT NULL, expiry DATE NOT NULL, strike REAL NOT NULL, type TEXT NOT NULL, day DATE NOT NULL,
                minute SMALLINT[] NOT NULL, open REAL[] NOT NULL, high REAL[] NOT NULL, low REAL[] NOT NULL, close REAL[] NOT NULL,
                volume BIGINT[] NOT NULL, oi BIGINT[] NOT NULL,
                PRIMARY KEY (symbol, expiry, strike, type, day));
            CREATE INDEX IF NOT EXISTS bt_opt_1m_day ON bt_opt_1m (day);
        """)
        conn.commit()


# ---------- daily: NSE bhavcopy ----------

def _get(url):
    for attempt in range(3):
        try:
            data = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=60).read()
            z = zipfile.ZipFile(io.BytesIO(data))
            return z.read(z.namelist()[0])
        except Exception as error:
            if "404" in str(error):
                return None
            time.sleep(2 + 4 * attempt)
    return None


def _frame(d):
    """The day's index futures and options as one frame (both file formats), or None (no file)."""
    mon = d.strftime("%b").upper()
    if d < NEW_FROM:
        raw = _get(f"https://nsearchives.nseindia.com/content/historical/DERIVATIVES/{d.year}/{mon}/fo{d.strftime('%d')}{mon}{d.year}bhav.csv.zip")
        if not raw:
            return None
        f = pd.read_csv(io.BytesIO(raw))
        f.columns = [c.strip() for c in f.columns]
        f = f.rename(columns={"OPTIONTYPE": "OPTION_TYP"})  # some years' files name it so
        f = f[f["SYMBOL"].str.strip().isin(SYMBOLS) & f["INSTRUMENT"].str.strip().isin(["OPTIDX", "FUTIDX"])]
        return pd.DataFrame({
            "symbol": f["SYMBOL"].str.strip(), "expiry": pd.to_datetime(f["EXPIRY_DT"].str.strip(), format="mixed", dayfirst=True).dt.date,
            "strike": f["STRIKE_PR"].astype(float), "type": f["OPTION_TYP"].str.strip().replace({"XX": "FUT"}),
            "open": f["OPEN"], "high": f["HIGH"], "low": f["LOW"], "close": f["CLOSE"], "settle": f["SETTLE_PR"],
            "oi": f["OPEN_INT"], "contracts": f["CONTRACTS"], "lot": None, "underlying": None})
    raw = _get(f"https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_{d.strftime('%Y%m%d')}_F_0000.csv.zip")
    if not raw:
        return None
    f = pd.read_csv(io.BytesIO(raw))
    f = f[f["TckrSymb"].isin(SYMBOLS) & f["FinInstrmTp"].isin(["IDO", "IDF"])]
    return pd.DataFrame({
        "symbol": f["TckrSymb"], "expiry": pd.to_datetime(f["XpryDt"]).dt.date,
        "strike": f["StrkPric"].fillna(0).astype(float), "type": f["OptnTp"].where(f["FinInstrmTp"] == "IDO", "FUT"),
        "open": f["OpnPric"], "high": f["HghPric"], "low": f["LwPric"], "close": f["ClsPric"], "settle": f["SttlmPric"],
        "oi": f["OpnIntrst"], "contracts": f["TtlTradgVol"], "lot": f["NewBrdLotQty"], "underlying": f["UndrlygPric"]})


def _keep(f, d):
    """Monthly expiries only (the last expiry of each month), the nearest three, strikes near the future."""
    out = []
    for sym, g in f.groupby("symbol"):
        exp = pd.Series(sorted(set(e for e in g["expiry"] if e >= d)))
        if exp.empty:
            continue
        monthly = exp.groupby([e.year * 100 + e.month for e in exp]).max().sort_values().head(MONTHLIES).tolist()
        g = g[g["expiry"].isin(monthly)]
        fut = g[g["type"] == "FUT"].sort_values("expiry")
        ref = float(fut["close"].iloc[0]) if len(fut) else None
        if ref:
            g = g[(g["type"] == "FUT") | ((g["strike"] - ref).abs() <= STRIKE_BAND * ref)]
        out.append(g[(g["type"] == "FUT") | (g["contracts"].fillna(0) > 0) | (g["oi"].fillna(0) > 0)])
    return pd.concat(out) if out else f.iloc[:0]


def _num(x):
    return None if x is None or pd.isna(x) else float(x)


def _int(x):
    return None if x is None or pd.isna(x) else int(x)


def _trading_days(since, until):
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT day FROM bt_daily WHERE symbol = 'NIFTY 50' AND day >= %s AND day <= %s ORDER BY day", (since, until))
        return [r[0] for r in cur.fetchall()]


def download_daily(since=None, until=None, on_progress=None):
    """NSE's files for the trading days not stored yet (resumable); returns days stored and missing."""
    ensure_tables()
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT DISTINCT day FROM bt_opt_daily")
        have = {r[0] for r in cur.fetchall()}
    days = [d for d in _trading_days(since or START, until or date.today() - timedelta(days=1)) if d not in have]
    stored, missing = 0, []
    for i, d in enumerate(days):
        try:
            f = _frame(d)
        except Exception as error:  # a file in an unexpected layout: note it, carry on
            print("option file", d, "not read:", error, flush=True)
            f = None
        if f is None or f.empty:
            missing.append(d.isoformat())
        else:
            f = _keep(f, d)
            rows = [(r.symbol, d, r.expiry, float(r.strike), r.type, _num(r.open), _num(r.high), _num(r.low), _num(r.close),
                     _num(r.settle), _int(r.oi), _int(r.contracts), _int(r.lot), _num(r.underlying)) for r in f.itertuples()]
            with connect() as conn, conn.cursor() as cur:
                execute_values(cur, "INSERT INTO bt_opt_daily (symbol, day, expiry, strike, type, open, high, low, close, settle, oi, "
                                    "contracts, lot, underlying) VALUES %s ON CONFLICT DO NOTHING", rows, page_size=2000)
                conn.commit()
            stored += 1
        if on_progress:
            on_progress(i + 1, len(days), d, stored, len(missing))
        time.sleep(0.4)
    return {"days": stored, "missing": missing}


# ---------- intraday: Kite 1-minute ----------

def _monthly_contracts(kite, today):
    """{symbol: [(expiry, [instrument rows])]} for the current and next monthly expiry."""
    ins = [i for i in kite.instruments("NFO") if i["name"] in SYMBOLS and i["instrument_type"] in ("CE", "PE")]
    out = {}
    for sym in SYMBOLS:
        rows = [i for i in ins if i["name"] == sym and i["expiry"] >= today]
        exp = sorted({i["expiry"] for i in rows})
        by_month = {}
        for e in exp:
            by_month[(e.year, e.month)] = max(by_month.get((e.year, e.month), e), e)
        monthly = sorted(by_month.values())[:2]
        out[sym] = [(e, [i for i in rows if i["expiry"] == e]) for e in monthly]
    return out


def _rows(key, bars):
    by_day = {}
    for b in bars:
        ts = b["date"]
        by_day.setdefault(ts.date(), {})[ts.hour * 60 + ts.minute - SESSION_START] = b
    out = []
    for day, mins in sorted(by_day.items()):
        k = sorted(mins)
        out.append((*key, day, k, [mins[m]["open"] for m in k], [mins[m]["high"] for m in k], [mins[m]["low"] for m in k],
                    [mins[m]["close"] for m in k], [int(mins[m].get("volume") or 0) for m in k], [int(mins[m].get("oi") or 0) for m in k]))
    return out


def download_minutes(since=None, until=None, on_progress=None):
    """Kite 1-minute candles (with OI) for the current and next monthly expiry, ATM +-MINUTE_STRIKES strikes
    of each day's index range, from `since` (default: as far back as Kite has, 60 days) to `until`."""
    import backtest
    import kite_auth
    ensure_tables()
    kite = kite_auth.trading_client()
    today = date.today()
    until = until or today
    since = since or today - timedelta(days=60)
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT symbol, day, high, low FROM bt_daily WHERE symbol = ANY(%s) AND day >= %s", (list(SPOT.values()), since))
        rng = {}
        for s, d, h, lo in cur.fetchall():
            rng.setdefault(s, []).append((h, lo))
    contracts = _monthly_contracts(kite, today)
    jobs = []
    for sym, exps in contracts.items():
        hl = rng.get(SPOT[sym]) or []
        if not hl:
            continue
        lo, hi = min(x[1] for x in hl), max(x[0] for x in hl)
        step = STEP[sym]
        a, b = (lo // step - MINUTE_STRIKES) * step, (hi // step + MINUTE_STRIKES + 1) * step
        for e, rows in exps:
            for i in rows:
                if a <= i["strike"] <= b:
                    jobs.append((sym, e, float(i["strike"]), i["instrument_type"], i["instrument_token"]))
    stored, errors = 0, []
    for n, (sym, e, k, t, tok) in enumerate(jobs):
        bars = []
        for attempt in range(4):
            try:
                bars = kite.historical_data(tok, datetime.combine(since, clock(9, 0)), datetime.combine(until, clock(15, 30)), "minute", oi=True)
                break
            except Exception as error:
                if "access_token" in str(error) or "api_key" in str(error):
                    raise
                if attempt == 3:
                    errors.append(f"{sym} {e} {k} {t}: {error}")
                time.sleep(2 * (attempt + 1))
        time.sleep(backtest.PAUSE)
        if bars:
            rows = _rows((sym, e, k, t), bars)
            with connect() as conn, conn.cursor() as cur:
                execute_values(cur, "INSERT INTO bt_opt_1m (symbol, expiry, strike, type, day, minute, open, high, low, close, volume, oi) "
                                    "VALUES %s ON CONFLICT (symbol, expiry, strike, type, day) DO UPDATE SET minute = EXCLUDED.minute, "
                                    "open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close, "
                                    "volume = EXCLUDED.volume, oi = EXCLUDED.oi", rows,
                               template="(%s, %s, %s, %s, %s, %s::smallint[], %s::real[], %s::real[], %s::real[], %s::real[], %s::bigint[], %s::bigint[])",
                               page_size=200)
                conn.commit()
            stored += len(rows)
        if on_progress:
            on_progress(n + 1, len(jobs), stored, len(errors))
    return {"contracts": len(jobs), "contract_days": stored, "errors": errors}


def topup():
    """After the close: yesterday's (and any missed) NSE files, and today's minutes."""
    d = download_daily(since=date.today() - timedelta(days=15))
    m = download_minutes(since=date.today() - timedelta(days=3))
    return {"daily_days": d["days"], "minute_rows": m["contract_days"], "minute_errors": len(m["errors"])}
