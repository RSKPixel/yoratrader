"""Per-user settings (theme, page parameters, nav state...): the app keeps none in the browser, so
every device and both dev and prod (they share the database) see the same ones.

One JSON value per (user, key). Keys are short names the frontend picks (e.g. "theme",
"params.paper-buy-on-gap"); values are small.
"""

import json
import re

from psycopg2.extras import Json

from db import connect, schema_once

KEY_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,100}$")
MAX_VALUE_BYTES = 20000


@schema_once
def _ensure(cursor):
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS user_settings (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            key TEXT NOT NULL, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (user_id, key)
        )
        """
    )


def get_all(user_id):
    with connect() as conn, conn.cursor() as cursor:
        _ensure(cursor)
        conn.commit()
        cursor.execute("SELECT key, value FROM user_settings WHERE user_id = %s", (user_id,))
        return dict(cursor.fetchall())


def put(user_id, values):
    """Upsert {key: value}; a None value deletes the key."""
    for key, value in values.items():
        if not KEY_RE.match(key or ""):
            raise ValueError(f"Bad setting name: {key!r}")
        if value is not None and len(json.dumps(value)) > MAX_VALUE_BYTES:
            raise ValueError(f"Setting {key} is too large.")
    with connect() as conn, conn.cursor() as cursor:
        _ensure(cursor)
        for key, value in values.items():
            if value is None:
                cursor.execute("DELETE FROM user_settings WHERE user_id = %s AND key = %s", (user_id, key))
            else:
                cursor.execute("INSERT INTO user_settings (user_id, key, value) VALUES (%s, %s, %s) "
                               "ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
                               (user_id, key, Json(value)))
        conn.commit()
