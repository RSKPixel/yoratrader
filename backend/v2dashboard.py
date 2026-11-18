"""The v2 Dashboard: today at a glance.

- overview(): the time and market status, Kite, today's schedule (what the production scheduler has
  recorded so far), the F&O indices, today's paper trading and how fresh the data is. Cheap: a few
  small queries, and one Kite quote call when connected.
- models(): every backtest at the page's defaults (net a year, Sharpe, max drawdown, this year),
  built in the background and cached, since a few models take a while the first time.
"""

import threading
import time
from datetime import datetime, time as clock, timedelta

import gapwatch
import kite_auth
import v2connors
import v2gap
import v2kbdt
import v2pairs
import v2paper
import v2qmom
import v2xsmom
import v2xsmr
import connorswatch
import oopswatch
import v2oops
import v2tom
import v2ltlv
from db import connect

INDICES = ["NIFTY 50", "NIFTY BANK", "NIFTY FIN SERVICE", "NIFTY MID SELECT", "NIFTY NEXT 50"]
MODELS_TTL = 1800
_models = {"at": 0, "value": None, "building": False}
_lock = threading.Lock()


def _one(cursor, sql, args=()):
    cursor.execute(sql, args)
    row = cursor.fetchone()
    return row[0] if row else None


def _table_exists(cursor, name):
    return _one(cursor, "SELECT to_regclass(%s)", (name,)) is not None


def _schedule(cursor, today, now):
    """Each automatic step today: done (with when / how much), pending (not yet due), or late."""
    weekday = today.weekday() < 5
    t = now.time()

    def step(at, label, done, detail=None, until=None):
        due = clock(*at)
        if not weekday:
            state = "off"
        elif done:
            state = "done"
        elif t < due:
            state = "pending"
        elif until and t < clock(*until):
            state = "running"
        else:
            state = "late"
        return {"at": f"{at[0]:02d}:{at[1]:02d}", "label": label, "state": state, "detail": detail}

    pre = _one(cursor, "SELECT count(*) FROM xsmr_preopen_quotes WHERE day = %s AND snap = '0906'", (today,)) if _table_exists(cursor, "xsmr_preopen_quotes") else 0
    gap = _one(cursor, "SELECT candidates FROM gap_paper_days WHERE day = %s", (today,)) if _table_exists(cursor, "gap_paper_days") else None
    xs = _one(cursor, "SELECT quoted FROM xsmr_paper_days WHERE day = %s", (today,)) if _table_exists(cursor, "xsmr_paper_days") else None
    oops_day = None
    if _table_exists(cursor, "oops_paper_days"):
        cursor.execute("SELECT gapped, note FROM oops_paper_days WHERE day = %s", (today,))
        oops_day = cursor.fetchone()
    oops_open = _one(cursor, "SELECT count(*) FROM oops_paper WHERE day = %s AND exit_at IS NULL", (today,)) if oops_day else None
    oops_n = _one(cursor, "SELECT count(*) FROM oops_paper WHERE day = %s", (today,)) if oops_day else None
    con = con_cum = None
    if _table_exists(cursor, "connors_paper_days"):
        cursor.execute("SELECT bought, sold, note FROM connors_paper_days WHERE day = %s", (today,))
        con = cursor.fetchone()
    if _table_exists(cursor, "connors_paper_cum_days"):
        cursor.execute("SELECT bought, sold, note FROM connors_paper_cum_days WHERE day = %s", (today,))
        con_cum = cursor.fetchone()
    gap_open = _one(cursor, "SELECT count(*) FROM gap_paper WHERE day = %s AND status = 'open'", (today,)) if gap is not None else None
    xs_open = _one(cursor, "SELECT count(*) FROM xsmr_paper WHERE day = %s AND status = 'open'", (today,)) if xs is not None else None
    daily = _one(cursor, "SELECT max(day) FROM bt_daily WHERE symbol IN (SELECT symbol FROM bt_symbols WHERE dataset = 'fno')")
    exits_done = (gap is not None or xs is not None) and not gap_open and not xs_open
    bt15 = _one(cursor, "SELECT (max(datetime) AT TIME ZONE 'Asia/Kolkata')::date FROM bt_15m WHERE symbol = 'NIFTY 50'")
    # the live download counts as done when most futures have today's candles (not just one symbol)
    live_n = _one(cursor, "SELECT count(DISTINCT symbol) FROM eod WHERE exchange = 'NSE' AND datetime >= %s - 10", (today,)) or 0
    eod_today = _one(cursor, "SELECT count(DISTINCT symbol) FROM eod WHERE exchange = 'NSE' AND datetime = %s", (today,)) or 0
    m15_today = _one(cursor, "SELECT count(DISTINCT symbol) FROM intraday_15m WHERE exchange = 'NSE' AND datetime >= (%s::timestamp AT TIME ZONE 'Asia/Kolkata')",
                     (today,)) or 0
    return [
        step((9, 6), "Pre-open snapshot (futures auction)", bool(pre), f"{pre} futures quoted" if pre else None, until=(9, 9)),
        step((9, 15), "Buy/Sell on gap: picks at the open", gap is not None, f"{gap} qualifying stocks" if gap is not None else None, until=(9, 20)),
        step((9, 15), "Cross-sectional mean reversion: 5 + 5 at the open", xs is not None, f"{xs} stocks quoted" if xs is not None else None, until=(9, 20)),
        step((9, 15), "Oops gap reversal: watchlist, then buys through the day", oops_day is not None and not (oops_day[1] or "").startswith("market closed"),
             (oops_day[1] if oops_day and oops_day[1] else f"{oops_day[0]} opened below yesterday's low · {oops_n} bought" if oops_day else None),
             until=(9, 20)),
        step((15, 15), "Short-term mean reversion: sells and buys", con is not None and not (con[2] or "").startswith("market closed"),
             (f"{con[1] or 0} sold, {con[0] or 0} bought" if con and con[0] is not None else (con[2] if con else None)), until=(15, 25)),
        step((15, 15), "Cumulative RSI(2): sells and buys", con_cum is not None and not (con_cum[2] or "").startswith("market closed"),
             (f"{con_cum[1] or 0} sold, {con_cum[0] or 0} bought" if con_cum and con_cum[0] is not None else (con_cum[2] if con_cum else None)),
             until=(15, 25)),
        step((15, 16), "Intraday exits at 15:15", exits_done and not oops_open and (gap is not None or xs is not None),
             "all closed" if exits_done and (gap is not None or xs is not None) else None, until=(15, 30)),
        step((15, 45), "Daily candles refreshed", daily is not None and daily >= today, f"to {daily}" if daily else None, until=(16, 30)),
        step((15, 50), "Live futures download (EOD + 15 min)", live_n > 0 and min(eod_today, m15_today) >= 0.8 * live_n,
             f"today: EOD {eod_today}/{live_n} · 15 min {m15_today}/{live_n}" if eod_today or m15_today else None, until=(16, 45)),
        step((16, 0), "Backtest data top-up (15 min + daily)", bt15 is not None and bt15 >= today, f"to {bt15}" if bt15 else None, until=(17, 0)),
    ]


def _markets(kite_ok):
    rows = []
    if kite_ok:
        try:
            quotes = kite_auth.trading_client().quote([f"NSE:{s}" for s in INDICES])
            for s in INDICES:
                q = quotes.get(f"NSE:{s}") or {}
                last, prev = q.get("last_price"), (q.get("ohlc") or {}).get("close")
                if last:
                    rows.append({"symbol": s, "last": float(last), "prev": float(prev) if prev else None,
                                 "change_pct": round(100 * (last / prev - 1), 2) if prev else None, "live": True})
            if rows:
                return rows
        except Exception as error:
            print("Dashboard index quotes failed:", error)
    with connect() as conn, conn.cursor() as cursor:
        for s in INDICES:
            cursor.execute("SELECT day, close FROM bt_daily WHERE symbol = %s ORDER BY day DESC LIMIT 2", (s,))
            r = cursor.fetchall()
            if r:
                last, prev = r[0][1], (r[1][1] if len(r) > 1 else None)
                rows.append({"symbol": s, "last": float(last), "prev": float(prev) if prev else None, "as_of": r[0][0].isoformat(),
                             "change_pct": round(100 * (last / prev - 1), 2) if prev else None, "live": False})
    return rows


def _paper(gap_max_open=5, xsmr_max_open=10):
    """The paper cards, at the max open each paper page was last set to (the page passes them)."""
    out = {}
    try:
        out["tom"] = v2tom.plan()  # turn of the month: a manual trade, its dates and the call to buy
    except Exception as error:
        out["tom"] = {"error": str(error)}
    pairs = min(5, xsmr_max_open // 2) if xsmr_max_open else 5
    try:
        g = v2paper.gap("long", "none", gap_max_open)
        today = next((d for d in g["days"] if d["day"] == g["today"]), None)
        out["gap"] = {"today_positions": len(today["picks"]) if today else 0, "today_net_rs": today["net_rs"] if today else None,
                      "today_margin_pct": today["net_value_pct"] if today else None, "today_margin_rs": today["margin_rs"] if today else None,
                      "today_status": today["status"] if today else None, "total_net_rs": g["summary"]["net_rs"], "open_net_rs": _open_days_rs(g["days"]),
                      "capital_rs": g["summary"]["capital_rs"], "days": g["summary"]["days"], "max_open": gap_max_open,
                      "watchlist": len(g["watchlist"]), "session": g["session"]}
    except Exception as error:
        out["gap"] = {"error": str(error)}
    try:
        x = v2paper.xsmr_(pairs, "none", xsmr_max_open)
        today = next((d for d in x["days"] if d["day"] == x["today"]), None)
        out["xsmr"] = {"today_positions": len(today["picks"]) if today else 0, "today_net_rs": today["net_rs"] if today else None,
                       "today_margin_pct": today["net_value_pct"] if today else None, "today_margin_rs": today["margin_rs"] if today else None,
                       "today_status": today["status"] if today else None, "total_net_rs": x["summary"]["net_rs"], "open_net_rs": _open_days_rs(x["days"]),
                       "capital_rs": x["summary"]["capital_rs"], "days": x["summary"]["days"], "max_open": xsmr_max_open, "pairs": pairs}
    except Exception as error:
        out["xsmr"] = {"error": str(error)}
    try:
        o = oopswatch.paper()
        today = next((d for d in o["days"] if d["day"] == o["today"]), None)
        out["oops"] = {"watched": len(o["watchlist"]), "today_positions": len(today["picks"]) if today else 0,
                       "today_status": today["status"] if today else None, "today_net_rs": today["net_rs"] if today else None,
                       "today_value_pct": today["net_value_pct"] if today else None, "total_net_rs": o["summary"]["net_rs"], "open_net_rs": _open_days_rs(o["days"]),
                       "capital_rs": o["summary"]["capital_rs"], "days": o["summary"]["days"], "max_open": o["max_open"]}
    except Exception as error:
        out["oops"] = {"error": str(error)}
    for key, book in (("connors", "rsi2"), ("connors_cum", "cum")):  # the two short-term mean reversion books
        try:
            c = connorswatch.paper(book=book)
            out[key] = {"open": len(c["open"]), "max_open": c["max_open"], "closed": c["summary"]["trades"],
                        "net_rs": c["lots"]["stock"]["net_rs"], "fut_net_rs": c["lots"]["book"]["net_rs"], "price": c.get("price"),
                        "open_net_rs": round(sum(t.get("stock_net_rs") or 0 for t in c["open"]), 2) if c["open"] else None,
                        "open_fut_net_rs": round(sum(t.get("book_net_rs") or 0 for t in c["open"]), 2) if c["open"] else None,
                        "capital_rs": c["lots"]["stock"]["capital_rs"] or (c["max_open"] * (c["lots"]["avg_lot_margin_rs"] or 0)),
                        "open_symbols": [t["symbol"] for t in c["open"]],
                        **_positional_today(c, gapwatch._now().date().isoformat())}
        except Exception as error:
            out[key] = {"error": str(error)}
    return out


def _open_days_rs(days):
    """An intraday book's days not closed yet (today's live trades; Oops buys waiting for the next open), marked now."""
    open_ = [d["net_rs"] for d in days if d.get("status") != "closed" and d.get("net_rs") is not None]
    return round(sum(open_), 2) if open_ else None


def _positional_today(c, today):
    """A held-for-days book's net today, one lot a position, each trade on its own prices (spot: the share;
    futures: its contract): a trade bought today counts its whole net; one bought before counts its move from
    yesterday's close (Kite's previous close) to now, or to its sale today less the sale's cost."""
    held = [t for t in c["open"] if t["buy_day"] != today]
    sold = [t for t in c["closed"] if t.get("sell_day") == today and t["buy_day"] != today]
    new = [t for t in c["open"] + c["closed"] if t["buy_day"] == today and (t in c["open"] or t.get("sell_day") == today)]
    total = sum(t.get("book_net_rs") or 0 for t in new)
    fut = lambda t: t.get("priced") == "futures" and t.get("fut")
    key = lambda t: f"NFO:{t['fut']}" if fut(t) else f"NSE:{t['symbol']}"
    keys = sorted({key(t) for t in held + sold})
    if keys:
        if not kite_auth.status().get("connected"):
            return {"today_net_rs": None}
        try:
            q = kite_auth.trading_client().quote(keys)
        except Exception as error:
            print("Dashboard: previous closes failed:", error)
            return {"today_net_rs": None}
        for t in held + sold:
            k = "fut" if fut(t) else "stock"
            prev = ((q.get(key(t)) or {}).get("ohlc") or {}).get("close")
            end = (t.get("fut_sell") if t in sold else t.get("fut_ltp")) if fut(t) else (t.get("sell") if t in sold else t.get("ltp"))
            if not prev or end is None or not t.get(f"{k}_qty"):
                return {"today_net_rs": None}
            total += (end - prev) * t[f"{k}_qty"] - ((t.get(f"{k}_cost_rs") or 0) / 2 if t in sold else 0)
    return {"today_net_rs": round(total, 2) if held or sold or new else None}


def paper_curve(gap_max_open=5, xsmr_max_open=10):
    """Each paper book's cumulative net in rupees by day (one lot a position; SR and CR at futures prices,
    closed trades on their sale day and the open ones marked now), and their total."""
    import pandas as pd
    pairs = min(5, xsmr_max_open // 2) if xsmr_max_open else 5
    daily, errors = {}, {}

    def days_net(label, days):
        daily[label] = {d["day"]: d["net_rs"] for d in days if d.get("net_rs") is not None}

    for label, build in (("Buy/Sell on gap", lambda: v2paper.gap("long", "none", gap_max_open)["days"]),
                         ("Cross-sectional mean reversion", lambda: v2paper.xsmr_(pairs, "none", xsmr_max_open)["days"]),
                         ("Oops gap reversal", lambda: oopswatch.paper()["days"])):
        try:
            days_net(label, build())
        except Exception as error:
            errors[label] = str(error)
    today = gapwatch._now().date().isoformat()
    for label, book in (("Short-term mean reversion", "rsi2"), ("Cumulative RSI(2)", "cum")):
        try:
            c = connorswatch.paper(book=book)
            per = {}
            for t in c["closed"]:
                if t.get("book_net_rs") is not None:
                    d = t["exit_at"][:10]
                    per[d] = per.get(d, 0.0) + t["book_net_rs"]
            live = sum(t.get("book_net_rs") or 0 for t in c["open"])
            if c["open"]:
                per[today] = per.get(today, 0.0) + live  # the open positions, marked now
            daily[label] = per
        except Exception as error:
            errors[label] = str(error)
    days = sorted({d for v in daily.values() for d in v})
    if not days:
        return {"days": [], "series": {}, "total": [], "errors": errors}
    frame = pd.DataFrame({k: pd.Series(v, dtype=float) for k, v in daily.items()}).reindex(days).fillna(0.0).cumsum()
    return {"days": days, "series": {k: [round(float(x), 2) for x in frame[k]] for k in frame.columns},
            "total": [round(float(x), 2) for x in frame.sum(axis=1)], "errors": errors}


def _freshness(cursor):
    def iso(v):
        return v.isoformat() if v else None
    return {
        "backtest_daily": iso(_one(cursor, "SELECT max(day) FROM bt_daily WHERE symbol IN (SELECT symbol FROM bt_symbols WHERE dataset = 'fno')")),
        "backtest_index_daily": iso(_one(cursor, "SELECT max(day) FROM bt_daily WHERE symbol = 'NIFTY 50'")),
        "backtest_15m": iso(_one(cursor, "SELECT (max(datetime) AT TIME ZONE 'Asia/Kolkata')::date FROM bt_15m WHERE symbol = 'RELIANCE'")),
        "live_daily": iso(_one(cursor, "SELECT max(datetime) FROM eod WHERE exchange = 'NSE'")),
        "live_15m": iso(_one(cursor, "SELECT (max(datetime) AT TIME ZONE 'Asia/Kolkata')::date FROM intraday_15m WHERE exchange = 'NSE'")),
    }


def _last_session(today):
    """The latest weekday before today (exchange holidays aren't known): what 'fresh' data should reach."""
    day = today - timedelta(days=1)
    while day.weekday() >= 5:
        day -= timedelta(days=1)
    return day


def overview(gap_max_open=5, xsmr_max_open=10):
    now = gapwatch._now()
    today = now.date()
    kite = kite_auth.status()
    with connect() as conn, conn.cursor() as cursor:
        schedule = _schedule(cursor, today, now)
        fresh = _freshness(cursor)
    market_open = today.weekday() < 5 and clock(9, 15) <= now.time() < clock(15, 30)
    return {
        "now": now.strftime("%Y-%m-%d %H:%M:%S"), "today": today.isoformat(), "weekday": now.strftime("%A"),
        "market_open": market_open, "preopen": today.weekday() < 5 and clock(9, 0) <= now.time() < clock(9, 15),
        "next_session": gapwatch.next_session(now).isoformat(), "expected_data": _last_session(today).isoformat()
        if not (today.weekday() < 5 and now.time() >= clock(15, 45)) else today.isoformat(),
        "kite": kite, "schedule": schedule, "markets": _markets(kite.get("connected")), "paper": _paper(gap_max_open, xsmr_max_open), "freshness": fresh,
    }


MODELS = [
    ("kbdt", "Key Breakout Dow Theory", "Positional", "Indices · 5-day hold · max 5",
     lambda: v2kbdt.results("indices", "5d", "model", 1.0, 5)),
    ("buy-on-gap", "Buy/Sell on gap", "Intraday", "F&O · long · max 5", lambda: v2gap.results("fno", "long", "none", 5)),
    ("gap-momentum", "Opening gap momentum", "Intraday", "Indices · both sides · max 5",
     lambda: v2gap.results("indices", "both", "none", 5, model="gapmom")),
    ("xs-mean-reversion", "Cross-sectional mean reversion", "Intraday", "F&O · 3 + 3 · 09:15",
     lambda: v2xsmr.results("fno", "intraday", "0915", "none", 6, 3)),
    ("pairs", "Pairs trading", "Positional", "F&O · Bollinger · 3 pairs", lambda: v2pairs.results("bollinger", "close", 6, 3)),
    ("xs-momentum", "Cross-sectional momentum", "Positional", "F&O · 3 + 3", lambda: v2xsmom.results("fno", "close", 6, 3)),
    ("quant-momentum", "Quantitative momentum", "Positional", "F&O · book · max 5", lambda: v2qmom.results("fno", "book", "none", 5)),
    ("short-term-reversion", "Short-term mean reversion", "Positional", "F&O · RSI(2) · max 3 · close",
     lambda: v2connors.results("fno", "rsi2", "5d", 3, "none", "close", "all", instrument="cash")),
    ("oops", "Oops gap reversal", "Intraday", "F&O · no stop, out at 15:15 · first 3 a day",
     lambda: v2oops.results("none", "any", 3)),
    ("turn-of-month", "Turn of the month", "Positional", "Nifty futures · last 4 days to the 3rd",
     lambda: v2tom.results("nifty", "4")),
    ("low-volatility", "Long trend low volatility", "Positional", "F&O stocks, cash · max 10 · 20% trailing stop",
     lambda: v2ltlv.results(10, "20", 0.0002, "cash")),
    ("cumulative-rsi", "Cumulative RSI(2) · exit on strength", "Positional", "F&O · cumulative RSI(2) · max 3 · close",
     lambda: v2connors.results("fno", "cumrsi2", "0d", 3, "none", "close", "all", instrument="cash")),
]


def _build_models():
    rows = []
    year = str(datetime.now().year)
    for mid, label, style, settings, run in MODELS:
        try:
            r = run()
            s = r.get("summary")
            this_year = next((y for y in r.get("years", []) if str(y["year"]) == year), None)
            rows.append({"id": mid, "label": label, "style": style, "settings": settings,
                         "link": f"/v2/backtesting/{'short-term-reversion' if mid == 'cumulative-rsi' else mid}",
                         "net_year_pct": s["net_year_pct"] if s else None, "sharpe": s["sharpe"] if s else None,
                         "ruin_pct": s.get("ruin_half_pct") if s else None, "ruin_safe_size": s.get("ruin_safe_size") if s else None,
                         "max_dd_pct": s["max_dd_pct"] if s else None, "green": f"{s['green_years']}/{s['years']}" if s else None,
                         "this_year_pct": this_year["net_pct"] if this_year else None, "from": s["from"] if s else None})
        except Exception as error:
            rows.append({"id": mid, "label": label, "style": style, "settings": settings, "error": str(error)})
    return rows


def models():
    """The scoreboard; built in the background the first time (a few models take ~40 s cold)."""
    with _lock:
        fresh = _models["value"] is not None and time.time() - _models["at"] < MODELS_TTL
        if not fresh and not _models["building"]:
            _models["building"] = True

            def go():
                try:
                    value = _build_models()
                    with _lock:
                        _models.update(value=value, at=time.time())
                finally:
                    with _lock:
                        _models["building"] = False
            threading.Thread(target=go, daemon=True, name="dashboard-models").start()
        return {"models": _models["value"], "building": _models["building"], "year": datetime.now().year}


_nfo = {"at": None, "map": {}}
_bars = {}  # (instrument key, since) -> (time fetched, [[unix seconds IST, close]])


def _instrument_token(kite, key):
    """NSE:SYMBOL or NFO:CONTRACT -> Kite's instrument token (NFO map cached for 6 hours)."""
    exchange, symbol = key.split(":", 1)
    if exchange == "NSE":
        return gapwatch._token(kite, symbol)
    if _nfo["at"] is None or time.time() - _nfo["at"] > 6 * 3600:
        _nfo["map"] = {r["tradingsymbol"]: r["instrument_token"] for r in kite.instruments("NFO")}
        _nfo["at"] = time.time()
    return _nfo["map"].get(symbol)


def _closes(kite, key, since, fetched):
    """Closes of key's candles from the day `since` to now: 5-minute bars for a position bought today
    or yesterday, 15-minute for one held longer. Cached a minute; Kite allows ~3 history calls a second."""
    hit = _bars.get((key, since))
    if hit and time.time() - hit[0] < 60:
        return hit[1]
    token = _instrument_token(kite, key)
    if not token:
        return []
    if fetched[0]:
        time.sleep(0.35)
    fetched[0] += 1
    now = gapwatch._now().replace(tzinfo=None)
    start = datetime.combine(datetime.fromisoformat(since).date(), clock(9, 15))
    interval = "5minute" if (now - start).days < 2 else "15minute"
    bars = kite.historical_data(token, from_date=start, to_date=now, interval=interval)
    out = [[int(b["date"].timestamp()) + 19800, float(b["close"])] for b in bars]
    _bars[(key, since)] = (time.time(), out)
    return out


def open_positions(gap_max_open=5, xsmr_max_open=10):
    """Every paper book's open positions with their price path since they were bought (the paper landing
    page's charts): a position held by more than one book is shown once, with each book named. Prices
    are what the book trades: the stock for gap and cross-sectional, the future for Oops, SR and CR."""
    pairs = min(5, xsmr_max_open // 2) if xsmr_max_open else 5
    found, errors = [], {}

    def intraday(label, href, build, fut=False):
        try:
            for d in build()["days"]:
                if d.get("status") == "closed":
                    continue
                for p in d["picks"]:
                    if p.get("closed"):
                        continue
                    key = f"NFO:{p['fut']}" if fut and p.get("fut") else f"NSE:{p['symbol']}"
                    found.append({"book": label, "href": href, "symbol": p["symbol"], "key": key, "side": p.get("side", "long"),
                                  "since": d["day"], "entry_at": p.get("entry_at"), "entry": p.get("entry"), "stop": p.get("stop"),
                                  "last": p.get("exit"), "net_rs": p.get("net_rs"), "net_pct": p.get("net_value_pct")})
        except Exception as error:
            errors[label] = str(error)

    intraday("Buy/Sell on gap", "/v2/paper/buy-on-gap", lambda: v2paper.gap("long", "none", gap_max_open), fut=True)
    intraday("Cross-sectional mean reversion", "/v2/paper/xs-mean-reversion", lambda: v2paper.xsmr_(pairs, "none", xsmr_max_open), fut=True)
    intraday("Oops gap reversal", "/v2/paper/oops", oopswatch.paper, fut=True)
    for label, href, book in (("Short-term mean reversion", "/v2/paper/short-term-reversion", "rsi2"),
                              ("Cumulative RSI(2)", "/v2/paper/cumulative-rsi", "cum")):
        try:
            for t in connorswatch.paper(book=book)["open"]:
                fut = t.get("priced") == "futures" and bool(t.get("fut"))
                key = f"NFO:{t['fut']}" if fut else f"NSE:{t['symbol']}"
                found.append({"book": label, "href": href, "symbol": t["symbol"], "key": key, "side": "long", "since": t["buy_day"],
                              "entry_at": t.get("entry_at"), "entry": t.get("fut_buy") if fut else t.get("buy"), "stop": None,
                              "last": t.get("fut_ltp") if fut else t.get("ltp"),
                              "net_rs": t.get("fut_net_rs") if fut else t.get("stock_net_rs"),
                              "net_pct": t.get("fut_net_value_pct") if fut else t.get("stock_net_value_pct"),
                              "day_of_hold": t.get("day_of_hold")})
        except Exception as error:
            errors[label] = str(error)
    merged = {}
    for p in found:
        k = (p["key"], p["since"], p["entry"])
        if k in merged:
            merged[k]["books"].append({"label": p["book"], "href": p["href"]})
        else:
            merged[k] = {**{x: v for x, v in p.items() if x not in ("book", "href")}, "books": [{"label": p["book"], "href": p["href"]}]}
    rows = sorted(merged.values(), key=lambda p: (p["since"], p["symbol"]))
    chart_error = None
    if rows and kite_auth.status().get("connected"):
        kite, fetched = kite_auth.trading_client(), [0]
        for p in rows:
            try:
                p["closes"] = _closes(kite, p["key"], p["since"], fetched)
            except Exception as error:
                p["closes"], chart_error = [], str(error)
    elif rows:
        chart_error = "Kite not connected: no price paths"
    return {"positions": rows, "errors": errors, "chart_error": chart_error}
