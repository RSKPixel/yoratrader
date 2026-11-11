"""User login: password hashing, sessions, and the request gate."""

import asyncio
import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from http.cookies import SimpleCookie

import db

COOKIE_NAME = "yt_session"
SESSION_DAYS = 30
MIN_PASSWORD_LENGTH = 8

# Paths reachable without a session. Everything else under /api/ and /ws/ needs one.
PUBLIC_PATHS = {"/api/health", "/api/auth/login", "/api/auth/logout"}

# Lock a user ID after repeated failures to slow down password guessing.
MAX_FAILURES = 10
LOCK_SECONDS = 15 * 60
_failures = {}

_SCRYPT = {"n": 2**14, "r": 8, "p": 1}


# ---------- password hashing ----------

def hash_password(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, dklen=32, **_SCRYPT)
    b64 = lambda raw: base64.b64encode(raw).decode()
    return f"scrypt${_SCRYPT['n']}${_SCRYPT['r']}${_SCRYPT['p']}${b64(salt)}${b64(digest)}"


def verify_password(password, stored):
    try:
        _, n, r, p, salt, digest = stored.split("$")
        expected = base64.b64decode(digest)
        actual = hashlib.scrypt(
            password.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p), dklen=len(expected)
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


# Used when the user ID doesn't exist, so a miss takes as long as a wrong password.
_DUMMY_HASH = hash_password(secrets.token_hex(16))


# ---------- storage ----------

def _ensure_tables(cursor):
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    cursor.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT ''")
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ NOT NULL
        )
        """
    )


def _query(sql, params=(), fetch=None):
    with db.connect() as conn:
        with conn.cursor() as cursor:
            _ensure_tables(cursor)
            cursor.execute(sql, params)
            if fetch == "one":
                return cursor.fetchone()
            if fetch == "all":
                return cursor.fetchall()
            return cursor.rowcount


def _token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def _clean_username(username):
    return (username or "").strip()


def _check_new_password(password):
    if len(password or "") < MIN_PASSWORD_LENGTH:
        raise ValueError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters.")


def user_count():
    return _query("SELECT COUNT(*) FROM users", fetch="one")[0]


def set_user(username, password):
    """Create the user, or reset its password if it exists. Used by manage_user.py."""
    username = _clean_username(username)
    if not username:
        raise ValueError("User ID is required.")
    _check_new_password(password)
    _query(
        """
        INSERT INTO users (username, password_hash) VALUES (%s, %s)
        ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = NOW()
        """,
        (username, hash_password(password)),
    )
    # A reset password signs out every existing session for that user.
    _query("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = %s)", (username,))


# ---------- login / sessions ----------

class LoginLocked(Exception):
    pass


def login(username, password):
    """Return a new session token, or None for a wrong user ID or password."""
    username = _clean_username(username)
    key = username.lower()
    entry = _failures.get(key)
    if entry and entry["locked_until"] > time.time():
        raise LoginLocked("Too many failed attempts. Try again in a few minutes.")

    row = _query("SELECT id, password_hash FROM users WHERE username = %s", (username,), fetch="one")
    password_ok = verify_password(password or "", row[1] if row else _DUMMY_HASH)
    if not row or not password_ok:
        entry = _failures.setdefault(key, {"count": 0, "locked_until": 0})
        entry["count"] += 1
        if entry["count"] >= MAX_FAILURES:
            entry.update(count=0, locked_until=time.time() + LOCK_SECONDS)
        return None

    _failures.pop(key, None)
    return _new_session(row[0])


def _new_session(user_id):
    token = secrets.token_urlsafe(32)
    _query("DELETE FROM sessions WHERE expires_at < NOW()")
    _query(
        "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (%s, %s, NOW() + %s * INTERVAL '1 day')",
        (_token_hash(token), user_id, SESSION_DAYS),
    )
    return token


def session_user(token):
    """Return {"id", "username", "display_name"} for a valid session token, else None."""
    if not token:
        return None
    row = _query(
        """
        SELECT u.id, u.username, u.display_name FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = %s AND s.expires_at > NOW()
        """,
        (_token_hash(token),),
        fetch="one",
    )
    return {"id": row[0], "username": row[1], "display_name": row[2]} if row else None


MAX_DISPLAY_NAME = 80


def set_display_name(user_id, display_name):
    name = " ".join((display_name or "").split())
    if len(name) > MAX_DISPLAY_NAME:
        raise ValueError(f"Name must be at most {MAX_DISPLAY_NAME} characters.")
    _query("UPDATE users SET display_name = %s, updated_at = NOW() WHERE id = %s", (name, user_id))
    return _user(user_id)


def _user(user_id):
    row = _query("SELECT id, username, display_name FROM users WHERE id = %s", (user_id,), fetch="one")
    return {"id": row[0], "username": row[1], "display_name": row[2]}


def logout(token):
    if token:
        _query("DELETE FROM sessions WHERE token_hash = %s", (_token_hash(token),))


def change_password(user_id, current_password, new_password, keep_token=None):
    """Change the password after checking the current one. The user ID never changes."""
    row = _query("SELECT password_hash FROM users WHERE id = %s", (user_id,), fetch="one")
    if not row or not verify_password(current_password or "", row[0]):
        raise PermissionError("Current password is incorrect.")
    _check_new_password(new_password)
    _query(
        "UPDATE users SET password_hash = %s, updated_at = NOW() WHERE id = %s",
        (hash_password(new_password), user_id),
    )
    # Sign out every other session; keep the one making this change.
    _query(
        "DELETE FROM sessions WHERE user_id = %s AND token_hash <> %s",
        (user_id, _token_hash(keep_token or "")),
    )
    return _user(user_id)


def cookie_kwargs():
    return {
        "key": COOKIE_NAME,
        "httponly": True,
        "samesite": "lax",
        "secure": os.environ.get("COOKIE_SECURE", "").lower() == "true",
        "path": "/",
    }


# ---------- request gate ----------

def _cookie_token(scope):
    for name, value in scope.get("headers", []):
        if name == b"cookie":
            cookie = SimpleCookie()
            try:
                cookie.load(value.decode("latin-1"))
            except Exception:
                return None
            morsel = cookie.get(COOKIE_NAME)
            return morsel.value if morsel else None
    return None


class AuthMiddleware:
    """Require a valid session for /api/* (except PUBLIC_PATHS) and /ws/*."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)

        path = scope.get("path", "")
        guarded = (path.startswith("/api/") and path not in PUBLIC_PATHS) or path.startswith("/ws/")
        if not guarded:
            return await self.app(scope, receive, send)

        user = await asyncio.to_thread(session_user, _cookie_token(scope))
        if user:
            scope.setdefault("state", {})["user"] = user
            return await self.app(scope, receive, send)

        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 4401})
            return
        body = json.dumps({"detail": "Not logged in"}).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 401,
                "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
            }
        )
        await send({"type": "http.response.body", "body": body})
