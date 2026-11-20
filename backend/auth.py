"""User login: password + Google Authenticator (TOTP), signed sessions, and the request gate.

Sign-in is two steps. The password step returns a short-lived signed challenge; the second step
takes a 6-digit authenticator code (or, the first time, enrols the authenticator from a QR code).
Only then is a session issued.

A session is a JWT (HS256, signed with JWT_SECRET from the environment) in an httponly cookie. It
lasts a week: it expires at 06:00 IST seven days after sign-in (SESSION_DAYS), so the sign-in is
weekly, not daily (the Kite login stays daily). Each JWT also has a server-side row (sessions, keyed by a hash of its jti), so logging out
or changing the password revokes it at once.
"""

import asyncio
import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from datetime import datetime, time as clock, timedelta
from http.cookies import SimpleCookie
from zoneinfo import ZoneInfo

import jwt
import pyotp
import segno

import db
from db import schema_once

COOKIE_NAME = "yt_session"
MIN_PASSWORD_LENGTH = 8
IST = ZoneInfo("Asia/Kolkata")
EXPIRES_AT = clock(6, 0)  # sessions end at 06:00 IST ...
SESSION_DAYS = 7  # ... seven days after sign-in
CHALLENGE_SECONDS = 5 * 60  # time to type the authenticator code after the password
TOTP_ISSUER = "YoraTrader"

# Paths reachable without a session. Everything else under /api/ and /ws/ needs one.
PUBLIC_PATHS = {"/api/health", "/api/auth/login", "/api/auth/totp", "/api/auth/logout"}

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

@schema_once
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
    cursor.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT")  # set once enrolled
    cursor.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending TEXT")  # shown as a QR, not yet confirmed
    cursor.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step BIGINT NOT NULL DEFAULT 0")  # no code reuse
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


def reset_totp(username):
    """Forget the user's authenticator (a lost phone); the next sign-in enrols a new one. Used by manage_user.py."""
    n = _query("UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_last_step = 0, updated_at = NOW() WHERE username = %s",
               (_clean_username(username),))
    if not n:
        raise ValueError("No such user ID.")
    _query("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = %s)", (_clean_username(username),))


# ---------- signing ----------

def _secret():
    secret = os.environ.get("JWT_SECRET", "")
    if len(secret) < 32:
        raise RuntimeError("JWT_SECRET (32+ characters) must be set in the environment.")
    return secret


def _sign(claims):
    return jwt.encode(claims, _secret(), algorithm="HS256")


def _decode(token, typ):
    try:
        claims = jwt.decode(token, _secret(), algorithms=["HS256"], options={"require": ["exp", "sub", "typ"]})
    except jwt.PyJWTError:
        return None
    return claims if claims.get("typ") == typ else None


def next_expiry(now=None):
    """06:00 IST, SESSION_DAYS days on: the next 06:00 (today's if still ahead, else tomorrow's) plus SESSION_DAYS - 1 days."""
    now = now or datetime.now(IST)
    at = datetime.combine(now.date(), EXPIRES_AT, IST)
    return (at if at > now else at + timedelta(days=1)) + timedelta(days=SESSION_DAYS - 1)


# ---------- login ----------

class LoginLocked(Exception):
    pass


def _locked(key):
    entry = _failures.get(key)
    if entry and entry["locked_until"] > time.time():
        raise LoginLocked("Too many failed attempts. Try again in a few minutes.")


def _fail(key):
    entry = _failures.setdefault(key, {"count": 0, "locked_until": 0})
    entry["count"] += 1
    if entry["count"] >= MAX_FAILURES:
        entry.update(count=0, locked_until=time.time() + LOCK_SECONDS)


def login(username, password):
    """Step 1. A wrong user ID or password returns None; else the challenge for step 2:
    {"challenge", "enroll"} plus, when the authenticator isn't set up yet, its QR code."""
    username = _clean_username(username)
    key = username.lower()
    _locked(key)

    row = _query("SELECT id, password_hash, totp_secret FROM users WHERE username = %s", (username,), fetch="one")
    password_ok = verify_password(password or "", row[1] if row else _DUMMY_HASH)
    if not row or not password_ok:
        _fail(key)
        return None

    user_id, enrolled = row[0], bool(row[2])
    out = {"enroll": not enrolled}
    if not enrolled:
        # A new secret for each attempt until one is confirmed with a code
        secret = pyotp.random_base32()
        _query("UPDATE users SET totp_pending = %s WHERE id = %s", (secret, user_id))
        uri = pyotp.TOTP(secret).provisioning_uri(name=username, issuer_name=TOTP_ISSUER)
        out.update(secret=secret, qr_svg=segno.make(uri, error="m").svg_inline(scale=5, dark="#0f1720", light="#ffffff", border=2))
    now = int(time.time())
    out["challenge"] = _sign({"typ": "mfa", "sub": str(user_id), "iat": now, "exp": now + CHALLENGE_SECONDS, "enroll": not enrolled})
    return out


def verify_totp(challenge, code):
    """Step 2: the challenge from login() and a 6-digit code. Returns (token, expires) or None."""
    claims = _decode(challenge or "", "mfa")
    if not claims:
        raise PermissionError("The sign-in expired. Enter your password again.")
    user_id = int(claims["sub"])
    key = f"totp:{user_id}"
    _locked(key)
    row = _query("SELECT totp_secret, totp_pending, totp_last_step FROM users WHERE id = %s", (user_id,), fetch="one")
    secret = row and (row[1] if claims.get("enroll") else row[0])
    if not secret:
        raise PermissionError("The sign-in expired. Enter your password again.")

    code = "".join(ch for ch in (code or "") if ch.isdigit())
    totp, now = pyotp.TOTP(secret), time.time()
    # Accept the current 30-second step or one either side (clock drift), never a step already used
    step = next((int(now // 30) + d for d in (0, -1, 1) if len(code) == 6 and hmac.compare_digest(totp.at(now + 30 * d), code)), None)
    if step is None or step <= row[2]:
        _fail(key)
        return None
    _failures.pop(key, None)
    if claims.get("enroll"):
        _query("UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_last_step = %s, updated_at = NOW() WHERE id = %s",
               (step, user_id))
    else:
        _query("UPDATE users SET totp_last_step = %s WHERE id = %s", (step, user_id))
    return _new_session(user_id)


def check_code(user_id, code):
    """A signed-in user's 6-digit authenticator code (to unlock something): True / False. Same rules as sign-in:
    the current 30-second step or one either side, never a step already used, locked after repeated failures."""
    key = f"totp:{user_id}"
    _locked(key)
    row = _query("SELECT totp_secret, totp_last_step FROM users WHERE id = %s", (user_id,), fetch="one")
    if not row or not row[0]:
        raise PermissionError("No authenticator set up for this user")
    code = "".join(ch for ch in (code or "") if ch.isdigit())
    totp, now = pyotp.TOTP(row[0]), time.time()
    step = next((int(now // 30) + d for d in (0, -1, 1) if len(code) == 6 and hmac.compare_digest(totp.at(now + 30 * d), code)), None)
    if step is None or step <= row[1]:
        _fail(key)
        return False
    _failures.pop(key, None)
    _query("UPDATE users SET totp_last_step = %s WHERE id = %s", (step, user_id))
    return True


def _new_session(user_id):
    jti = secrets.token_urlsafe(24)
    expires = next_expiry()
    _query("DELETE FROM sessions WHERE expires_at < NOW()")
    _query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (%s, %s, %s)", (_token_hash(jti), user_id, expires))
    token = _sign({"typ": "session", "sub": str(user_id), "jti": jti, "iat": int(time.time()), "exp": int(expires.timestamp())})
    return token, expires


def session_user(token):
    """Return {"id", "username", "display_name", "expires_at"} for a valid, unrevoked session JWT, else None."""
    claims = _decode(token or "", "session")
    if not claims or not claims.get("jti"):
        return None
    row = _query(
        """
        SELECT u.id, u.username, u.display_name FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = %s AND s.expires_at > NOW() AND u.id = %s
        """,
        (_token_hash(claims["jti"]), int(claims["sub"])),
        fetch="one",
    )
    if not row:
        return None
    return {"id": row[0], "username": row[1], "display_name": row[2],
            "expires_at": datetime.fromtimestamp(claims["exp"], IST).isoformat(timespec="minutes")}


def _jti(token):
    claims = _decode(token or "", "session")
    return (claims or {}).get("jti") or ""


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
    jti = _jti(token)
    if jti:
        _query("DELETE FROM sessions WHERE token_hash = %s", (_token_hash(jti),))


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
        (user_id, _token_hash(_jti(keep_token))),
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
