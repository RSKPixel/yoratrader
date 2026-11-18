"""Each model's status, shared by everyone (not a per-user setting): research (the default: backtested
only), testing (paper traded), live (approved for real trading; a marker, nothing places orders) or
archived (dropped: kept, but out of the way). A model's backtest and paper pages share one status."""

import re

from db import connect, schema_once

STATUSES = ("research", "testing", "live", "archived")
ID_RE = re.compile(r"^[a-z0-9-]{1,60}$")


@schema_once
def _ensure(cursor):
    cursor.execute("CREATE TABLE IF NOT EXISTS model_status (model TEXT PRIMARY KEY, status TEXT NOT NULL, "
                   "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_by TEXT)")


def all_statuses():
    with connect() as conn, conn.cursor() as cursor:
        _ensure(cursor)
        conn.commit()
        cursor.execute("SELECT model, status FROM model_status")
        return dict(cursor.fetchall())


def set_status(model, status, user=None):
    if not ID_RE.match(model or ""):
        raise ValueError("Unknown model.")
    if status not in STATUSES:
        raise ValueError(f"Status must be one of {', '.join(STATUSES)}.")
    with connect() as conn, conn.cursor() as cursor:
        _ensure(cursor)
        if status == "research":
            cursor.execute("DELETE FROM model_status WHERE model = %s", (model,))
        else:
            cursor.execute("INSERT INTO model_status (model, status, updated_by) VALUES (%s, %s, %s) ON CONFLICT (model) "
                           "DO UPDATE SET status = EXCLUDED.status, updated_at = NOW(), updated_by = EXCLUDED.updated_by",
                           (model, status, user))
        conn.commit()
    return status
