"""Live trading items (the Live trading page): each one a model marked Live, with a name, its own settings
(copied from the model's paper book when created, then its own), the trading account it trades on, and
whether it is enabled (real money). An item starts disabled.

Enabling an item only marks it on: the orders come from each model's live order engine, built one model at
a time (ENGINES). A model without one sends nothing, and the page says so. Turn of the month is traded by
hand from its own page (livetrade.py).
"""

import json

import kite_auth
import modelstatus
from db import connect, schema_once

# Each model's settings, as its paper page shows them: (key, label, kind, rule, hint[, when]). Kinds: "stepper"
# (rule: min, max), "capital" (rule: min, max), "choice" (rule: [(value, text)]), "fixed" (rule: the text shown,
# not a setting). when: {key: value} the field shows only for (capital: spot only).
_DISASTER = ("disaster", "Disaster stop 10%", "choice", [("on", "On"), ("off", "Off")],
             "Out 10% from the entry if the day's low (long) or high (short) reaches it. Chan: a stop usually costs a "
             "mean-reversion model a little, but caps the loss if it stops working (a regime change, a black swan).")
_MAX_OPEN = ("max_open", "Max open", "stepper", (1, 10), "Positions held at once: the free slots fill at the next run")


def _connors():
    return [
        _MAX_OPEN,
        ("universe", "Universe", "fixed", "F&O stocks", "The stocks it trades"),
        ("price", "Instrument", "choice", [("spot", "Spot"), ("futures", "Futures")],
         "Spot: the signal from the share's closes and price now, the share bought for delivery. Futures: the signal from "
         "the future's own closes and its price now, one lot of the nearest future expiring at least 10 days after the buy."),
        ("setup", "Setup", "choice", [("rsi2", "RSI(2) < 10"), ("cumrsi2", "Cumulative RSI(2) < 35")],
         "In a stock above its 200-day average: the 2-day RSI below 10, or today's + yesterday's 2-day RSI below 35"),
        ("capital", "Capital", "capital", (10000, 100000000),
         "Spot: each position is this capital ÷ max open, in whole shares, bought for delivery. Futures positions are one lot each.",
         {"price": "spot"}),
        ("trade_at", "Exit at", "choice", [("close", "At close"), ("closeopen", "At next open")],
         "Entry is always at the close: the 15:15 run buys at the price then. The exit is decided at 15:15 and done then "
         "(At close) or at the next session's open (At next open)."),
        _DISASTER,
        ("exit", "Exit", "choice", [("hold", "5 days"), ("strength", "Exit on strength")],
         "Sold on the 5th trading day, or on strength (the first 15:15 the 2-day RSI is above 65, the 5th day at the latest)"),
        ("orders", "Orders", "choice", [("dry", "Dry run"), ("real", "Real orders")],
         "Dry run: each order built and logged, nothing sent. Real orders: sent to the account (from the live server only), "
         "fills checked with the broker every minute. The disaster stop isn't built for real orders yet."),
    ]


SPECS = {
    "short-term-reversion": _connors(),
    "cumulative-rsi": _connors(),
    "oops": [
        _MAX_OPEN,
        ("instrument", "Instrument", "fixed", "Futures", "One lot of the stock's current-month future"),
        ("exit", "Exit at", "fixed", "Next open", "Fixed, as in the book: sold at the next trading day's open; a future that expires that day is sold at 15:15"),
        ("stop", "Disaster stop 10%", "choice", [("on", "On"), ("off", "Off")], _DISASTER[4]),
    ],
    "buy-on-gap": [
        _MAX_OPEN,
        ("side", "Side", "choice", [("long", "Long (book)"), ("both", "Long & short")], "Long: buy gaps down (the book). Long & short: also short the mirror image."),
        _DISASTER,
    ],
    "xs-mean-reversion": [
        ("pairs", "Pairs", "choice", [(n, str(n)) for n in range(1, 6)], "k long + k short of the recorded 5 + 5 (the furthest from the day's average move first); one lot each."),
        ("entry", "Entry", "fixed", "09:15 open", "Fixed, as in the backtest: the 09:15 opening price"),
        ("exit", "Exit at", "fixed", "15:15", "Fixed, as in the backtest: sold the same day at 15:15"),
        _DISASTER,
    ],
    "turn-of-month": [
        ("lots", "Lots", "choice", [(n, str(n)) for n in range(1, 6)], "Nifty call lots bought"),
        ("stop", "Stop loss", "choice", [("off", "Off"), ("on", "On")], "A Kite GTT on the held call, set from its trading page"),
    ],
    "books-gold": [
        ("capital", "Capital", "capital", (10000, 100000000), "What the portfolio is sized on"),
    ],
}
LABELS = {
    "short-term-reversion": "Short-term mean reversion", "cumulative-rsi": "Short-term mean reversion (C-RSI)",
    "oops": "Oops gap reversal", "buy-on-gap": "Buy/Sell on gap", "xs-mean-reversion": "Cross-sectional mean reversion",
    "turn-of-month": "Turn of the month", "books-gold": "Books + gold",
}
PAGES = {"turn-of-month": "/v2/trade/turn-of-month", "books-gold": "/v2/trade/books-gold"}  # traded by hand from these
ENGINES = ("short-term-reversion", "cumulative-rsi")  # models with a live order engine (liveengine.py: dry run, logged)
HAND = {"turn-of-month": "You place its orders from its trading page", "books-gold": "You place its orders by hand from its page"}


def _paper_settings(model):
    """The model's paper book settings now: what a new live item starts with."""
    if model in ("short-term-reversion", "cumulative-rsi"):
        import connorswatch as c
        b = "rsi2" if model == "short-term-reversion" else "cum"
        return {"orders": "dry", "setup": "rsi2" if b == "rsi2" else "cumrsi2", "capital": c.capital(b), "max_open": c.max_open(b), "price": c.price(b), "trade_at": c.trade_at(b),
                "exit": c.exit_mode(b), "disaster": c.disaster(b)}
    if model == "oops":
        import oopswatch as o
        return {"max_open": o.max_open(), "exit": o.exit_mode(), "stop": o.stop_mode()}
    if model in ("buy-on-gap", "xs-mean-reversion"):
        import priority
        cfg = priority._settings()
        if model == "buy-on-gap":
            return {"max_open": cfg["gap_open"], "side": cfg["gap_side"], "disaster": cfg["gap_disaster"]}
        return {"pairs": cfg["xs_k"], "disaster": cfg["xs_disaster"]}
    if model == "turn-of-month":
        return {"lots": 1, "stop": "off"}
    if model == "books-gold":
        import livetrade
        return {"capital": livetrade.mix_capital()}
    raise ValueError("unknown model")


def _clean(model, settings, strict=True):
    """The settings checked against the model's fields: unknown keys dropped, numbers in range, choices listed."""
    out = {}
    for key, label, kind, rule, *_ in SPECS[model]:
        if key not in settings or kind == "fixed":
            continue
        if not strict:  # a paper setting the live item doesn't offer (an old value): left out
            try:
                out.update(_clean(model, {key: settings[key]}))
            except ValueError:
                pass
            continue
        v = settings[key]
        if kind in ("stepper", "capital"):
            try:
                v = int(v)
            except (TypeError, ValueError):
                raise ValueError(f"{label}: a whole number")
            if not rule[0] <= v <= rule[1]:
                raise ValueError(f"{label}: {rule[0]:,} to {rule[1]:,}")
        elif v not in [c[0] for c in rule]:
            raise ValueError(f"{label}: not one of the choices")
        out[key] = v
    return out


@schema_once
def _ensure(cursor):
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS live_items (
            id SERIAL PRIMARY KEY, model TEXT NOT NULL, name TEXT NOT NULL, account TEXT,
            settings JSONB NOT NULL DEFAULT '{}', enabled BOOLEAN NOT NULL DEFAULT false,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_by TEXT,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_by TEXT, enabled_at TIMESTAMPTZ
        );
        """
    )


def accounts():
    """The broker accounts in Settings: Kite, and Angel One when its credentials are stored. connected: it can
    trade now (Kite: today's login; Angel One: client code, PIN and the authenticator secret stored, so it logs
    itself in)."""
    k = kite_auth.status()
    out = [{"id": "kite", "broker": "Kite", "connected": bool(k.get("connected")),
            "label": f"Kite · {k.get('user_name') or ''} ({k['user_id']})".replace("·  (", "· (") if k.get("connected") and k.get("user_id")
            else "Kite (not connected: log in from Settings)"}]
    try:
        import angel_auth
        a = angel_auth.credentials()
        if a.get("client_code"):
            ready = bool(a.get("api_key") and a.get("has_pin") and a.get("has_totp_secret"))
            out.append({"id": "angel", "broker": "Angel One", "connected": ready,
                        "label": f"Angel One · {a.get('name') + ' ' if a.get('name') else ''}({a['client_code']})"
                                 + ("" if ready else " (PIN or authenticator secret missing in Settings)")})
    except Exception as error:
        print("Live items: Angel One account:", error)
    return out


# One model, two paper books: short-term mean reversion is added once (its setup a setting: RSI(2) or C-RSI),
# when either book is marked Live; an item a setup, so several items with their own names and settings
SAME = {"cumulative-rsi": "short-term-reversion"}


def _live(model, st=None):
    st = st or modelstatus.all_statuses()
    return any(st.get(m) == "live" for m in [model] + [k for k, v in SAME.items() if v == model])


def models():
    """The models that can be added: the ones marked Live, with their paper settings now (a model can be added
    any number of times, each item its own name and settings)."""
    st = modelstatus.all_statuses()
    out = []
    for m in SPECS:
        if m in SAME or not _live(m, st):
            continue
        try:
            paper = _paper_settings(m)
        except Exception as error:
            paper, err = {}, str(error)
        else:
            err = None
        out.append({"id": m, "label": LABELS[m], "paper": paper, "error": err})
    return out


def _row(r):
    i, model, name, account, settings, enabled, created_at, enabled_at = r
    return {"id": i, "model": model, "model_label": LABELS.get(model, model), "name": name, "account": account,
            "settings": settings or {}, "enabled": enabled, "created_at": created_at.isoformat(),
            "enabled_at": enabled_at.isoformat() if enabled_at else None, "page": PAGES.get(model),
            "orders": "engine" if model in ENGINES else "hand" if model in HAND else "none",
            "real": (settings or {}).get("orders") == "real",
            "orders_note": (("REAL ORDERS: when enabled, its orders are sent to the account at its times in the live market (from the live server), fills checked every minute"
                             if (settings or {}).get("orders") == "real" else
                             "Order engine on, DRY RUN: when enabled, its orders are built and logged at its times in the live market, nothing is sent") if model in ENGINES else HAND.get(model)
                            or "Its order engine isn't built yet: enabled or not, nothing is sent")}


def items():
    with connect() as conn, conn.cursor() as cursor:
        _ensure(cursor)
        conn.commit()
        cursor.execute("SELECT id, model, name, account, settings, enabled, created_at, enabled_at FROM live_items ORDER BY id")
        rows = [_row(r) for r in cursor.fetchall()]
    fields = {m: [{"key": x[0], "label": x[1], "kind": x[2], "rule": x[3], "hint": x[4], "when": x[5] if len(x) > 5 else None}
                  for x in f] for m, f in SPECS.items()}
    return {"items": rows, "fields": fields, "accounts": accounts()}


def _one(cursor, item_id):
    cursor.execute("SELECT id, model, name, account, settings, enabled, created_at, enabled_at FROM live_items WHERE id = %s", (item_id,))
    r = cursor.fetchone()
    if not r:
        raise ValueError("No such item")
    return _row(r)


def create(model, name, user=None):
    """A new item, disabled, with the model's paper settings and the Kite account."""
    if model not in SPECS:
        raise ValueError("Unknown model")
    model = SAME.get(model, model)
    if not _live(model):
        raise ValueError("Only models marked Live can be added")
    name = (name or "").strip() or LABELS[model]
    if len(name) > 80:
        raise ValueError("Name: 80 characters at most")
    settings = _clean(model, _paper_settings(model), strict=False)
    acct = accounts()[0]["id"]
    with connect() as conn, conn.cursor() as cursor:
        _ensure(cursor)
        cursor.execute("INSERT INTO live_items (model, name, account, settings, created_by, updated_by) VALUES (%s, %s, %s, %s, %s, %s) "
                       "RETURNING id", (model, name, acct, json.dumps(settings), user, user))
        i = cursor.fetchone()[0]
        out = _one(cursor, i)
        conn.commit()
    return out


def update(item_id, name=None, account=None, settings=None, user=None):
    """Change an item's name, account or settings. Settings change while enabled too (from its next run: positions
    already held keep their quantities); the account only while disabled (its holdings are on that account)."""
    with connect() as conn, conn.cursor() as cursor:
        _ensure(cursor)
        it = _one(cursor, item_id)
        if it["enabled"] and account is not None and account != it["account"]:
            raise ValueError("Disable the item before changing its account")
        if name is not None:
            name = name.strip()
            if not name or len(name) > 80:
                raise ValueError("Name: 1 to 80 characters")
        if account is not None and account not in [a["id"] for a in accounts()]:
            raise ValueError("Not one of the trading accounts in Settings")
        new = {**it["settings"], **_clean(it["model"], settings)} if settings is not None else it["settings"]
        if new.get("orders") == "real" and new.get("disaster") == "on":
            raise ValueError("Real orders: the disaster stop isn't built for them yet. Turn the disaster stop off, or keep Dry run")
        cursor.execute("UPDATE live_items SET name = COALESCE(%s, name), account = COALESCE(%s, account), settings = %s, "
                       "updated_at = now(), updated_by = %s WHERE id = %s", (name, account, json.dumps(new), user, item_id))
        out = _one(cursor, item_id)
        conn.commit()
    return out


def set_enabled(item_id, enabled, user=None):
    """Switch an item on (real money on its account) or off. On needs its account connected."""
    with connect() as conn, conn.cursor() as cursor:
        _ensure(cursor)
        it = _one(cursor, item_id)
        if enabled:
            acct = next((a for a in accounts() if a["id"] == it["account"]), None)
            if not acct or not acct["connected"]:
                raise ValueError("Its trading account isn't connected: log in to Kite from Settings, or pick the account again")
        cursor.execute("UPDATE live_items SET enabled = %s, enabled_at = CASE WHEN %s THEN now() ELSE enabled_at END, "
                       "updated_at = now(), updated_by = %s WHERE id = %s", (bool(enabled), bool(enabled), user, item_id))
        out = _one(cursor, item_id)
        conn.commit()
    print(f"Live item {item_id} ({it['model']}) {'enabled' if enabled else 'disabled'} by {user}")
    return out


def delete(item_id):
    with connect() as conn, conn.cursor() as cursor:
        _ensure(cursor)
        it = _one(cursor, item_id)
        if it["enabled"]:
            raise ValueError("Disable the item before deleting it")
        cursor.execute("DELETE FROM live_items WHERE id = %s", (item_id,))
        conn.commit()
    return {"deleted": item_id}
