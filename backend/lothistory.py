"""Historical futures lot sizes (stock and index futures), from NSE's daily F&O bhavcopy.

NSE's files list the lot size only from July 2024 (the UDiFF format's NewBrdLotQty). Before that, a
contract's lot is worked out as traded value / (contracts x price): within about 1% of the real lot,
which is a round number. Lots change only at NSE's revisions (and bonuses / splits), so one day a week
is enough to see every lot in force; the week a lot changed can then be narrowed to the day.

fut_lot_weekly: one row per symbol per sampled day: the estimate (near-month contract), contracts
traded, and the exact lot where NSE gives it. Raw files aren't kept.

Run:  venv/bin/python lothistory.py download [since] [until]
"""

import io
import sys
import time
from datetime import date, timedelta

import pandas as pd
from psycopg2.extras import execute_values

import optdata
from db import connect

START = date(2003, 1, 1)


def ensure_table():
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS fut_lot_weekly (
                symbol TEXT NOT NULL, day DATE NOT NULL, kind TEXT NOT NULL, expiry DATE, lot_est REAL, lot_exact INTEGER,
                contracts BIGINT, close REAL, PRIMARY KEY (symbol, day));
        """)
        conn.commit()


def _file(d):
    """The day's stock and index futures: symbol, kind (stock / index), expiry, contracts, close, value (Rs), exact lot."""
    mon = d.strftime("%b").upper()
    if d < optdata.NEW_FROM:
        raw = optdata._get(f"https://nsearchives.nseindia.com/content/historical/DERIVATIVES/{d.year}/{mon}/fo{d.strftime('%d')}{mon}{d.year}bhav.csv.zip")
        if not raw:
            return None
        f = pd.read_csv(io.BytesIO(raw))
        f.columns = [c.strip() for c in f.columns]
        f = f[f["INSTRUMENT"].str.strip().isin(["FUTSTK", "FUTIDX"])]
        return pd.DataFrame({
            "symbol": f["SYMBOL"].str.strip(), "kind": f["INSTRUMENT"].str.strip().map({"FUTSTK": "stock", "FUTIDX": "index"}),
            "expiry": pd.to_datetime(f["EXPIRY_DT"].str.strip(), format="mixed", dayfirst=True).dt.date,
            "contracts": f["CONTRACTS"].astype(float), "close": f["CLOSE"].astype(float), "value": f["VAL_INLAKH"].astype(float) * 1e5,
            "lot": None})
    raw = optdata._get(f"https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_{d.strftime('%Y%m%d')}_F_0000.csv.zip")
    if not raw:
        return None
    f = pd.read_csv(io.BytesIO(raw))
    f = f[f["FinInstrmTp"].isin(["STF", "IDF"])]
    return pd.DataFrame({
        "symbol": f["TckrSymb"], "kind": f["FinInstrmTp"].map({"STF": "stock", "IDF": "index"}),
        "expiry": pd.to_datetime(f["XpryDt"]).dt.date, "contracts": f["TtlTradgVol"].astype(float),
        "close": f["ClsPric"].astype(float), "value": f["TtlTrfVal"].astype(float), "lot": f["NewBrdLotQty"]})


def _rows(d, f):
    """One row per symbol: its near-month contract (the most traded month if the near one barely traded)."""
    f = f[(f["contracts"] > 0) & (f["close"] > 0)].copy()
    if f.empty:
        return []
    f = f.sort_values(["symbol", "expiry"])
    near = f.groupby("symbol").head(1)
    best = f.loc[f.groupby("symbol")["contracts"].idxmax()]  # when the near month has a handful of trades (expiry day)
    pick = near.set_index("symbol")
    alt = best.set_index("symbol")
    thin = pick["contracts"] < 20
    pick.loc[thin] = alt.loc[pick.index[thin]]
    out = []
    for sym, r in pick.iterrows():
        units = r["value"] / r["close"]  # traded quantity at about the close
        est = units / r["contracts"]
        lot = int(r["lot"]) if r["lot"] is not None and pd.notna(r["lot"]) else None
        contracts = r["contracts"]
        if d >= optdata.NEW_FROM:
            est = lot
        out.append((sym, d, r["kind"], r["expiry"], float(est) if est else None, lot, int(contracts), float(r["close"])))
    return out


def _sample_days(since, until):
    """One trading day a week (the week's Tuesday, else its next trading day; never an expiry Thursday when avoidable)."""
    days = optdata._trading_days(since, until)
    weeks = {}
    for d in days:
        k = d.isocalendar()[:2]
        weeks.setdefault(k, []).append(d)
    picks = []
    for k in sorted(weeks):
        w = weeks[k]
        pref = [x for x in w if x.weekday() == 1] or [x for x in w if x.weekday() in (2, 0)] or w
        picks.append(pref[0])
    return picks


def download(since=START, until=None, every=1):
    ensure_table()
    until = until or date.today()
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT DISTINCT day FROM fut_lot_weekly")
        have = {r[0] for r in cur.fetchall()}
    todo = [d for d in _sample_days(since, until)[::every] if d not in have]
    print(f"{len(todo)} days to fetch ({len(have)} already stored)", flush=True)
    t0, done, missing = time.time(), 0, []
    for d in todo:
        try:
            f = _file(d)
        except Exception as error:  # a bad file: note it, carry on
            print(d, "failed:", error, flush=True)
            missing.append(d)
            continue
        if f is None:
            missing.append(d)
            continue
        rows = _rows(d, f)
        with connect() as conn, conn.cursor() as cur:
            execute_values(cur, "INSERT INTO fut_lot_weekly (symbol, day, kind, expiry, lot_est, lot_exact, contracts, close) VALUES %s "
                                "ON CONFLICT (symbol, day) DO NOTHING", rows)
            conn.commit()
        done += 1
        if done % 25 == 0:
            rate = (time.time() - t0) / done
            print(f"{done}/{len(todo)} · {d} · {len(rows)} symbols · ~{rate * (len(todo) - done) / 60:.0f} min left", flush=True)
        time.sleep(0.4)  # gentle on NSE's archive
    print(f"done: {done} days, {len(missing)} without a file: {missing[:20]}", flush=True)


if __name__ == "__main__":
    if sys.argv[1:2] == ["download"]:
        a = [date.fromisoformat(x) for x in sys.argv[2:4]]
        download(*a)
