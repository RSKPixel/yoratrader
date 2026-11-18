"""Angel One SmartAPI credentials and login (read-only use: historical data tests; nothing here places orders).

Credentials live in app_settings, like Kite's: ANGEL_API_KEY (the SmartAPI app's key), ANGEL_CLIENT_CODE
(the Angel One client ID), ANGEL_PIN (the login PIN) and, optionally, ANGEL_TOTP_SECRET (the authenticator
secret; without it a login needs the 6-digit code typed in). A login gives a JWT kept in memory only.
"""

import base64
import hashlib
import hmac
import struct
import time

import requests

import db

KEYS = ("ANGEL_API_KEY", "ANGEL_CLIENT_CODE", "ANGEL_PIN", "ANGEL_TOTP_SECRET")
BASE = "https://apiconnect.angelone.in"
_session = {"jwt": None, "at": None, "name": None}


def _settings():
    s = db.get_settings(KEYS)
    return {k: s.get(k) or "" for k in KEYS}


def _mask(v, keep=4):
    return f"{'•' * max(0, min(8, len(v) - keep))}{v[-keep:]}" if v else ""


def credentials():
    s = _settings()
    return {"api_key": _mask(s["ANGEL_API_KEY"]), "client_code": s["ANGEL_CLIENT_CODE"],
            "has_pin": bool(s["ANGEL_PIN"]), "has_totp_secret": bool(s["ANGEL_TOTP_SECRET"]),
            "logged_in": bool(_session["jwt"]), "logged_in_at": _session["at"], "name": _session["name"]}


def save_credentials(api_key=None, client_code=None, pin=None, totp_secret=None):
    """Store the non-empty fields (an empty field keeps what's stored)."""
    updates = {}
    for key, v in (("ANGEL_API_KEY", api_key), ("ANGEL_CLIENT_CODE", client_code), ("ANGEL_PIN", pin), ("ANGEL_TOTP_SECRET", totp_secret)):
        v = (v or "").strip()
        if v:
            if key == "ANGEL_TOTP_SECRET":
                v = v.replace(" ", "").upper()
                base64.b32decode(v + "=" * (-len(v) % 8))  # raises if it isn't a base32 authenticator secret
            updates[key] = v
    if updates:
        db.set_settings(updates)
        _session.update(jwt=None, at=None, name=None)
    return credentials()


def _totp(secret, at=None):
    """The 6-digit code an authenticator app shows (RFC 6238: SHA-1, 30 s)."""
    key = base64.b32decode(secret + "=" * (-len(secret) % 8))
    counter = int((at or time.time()) // 30)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    o = digest[-1] & 0x0F
    return f"{(struct.unpack('>I', digest[o:o + 4])[0] & 0x7FFFFFFF) % 1_000_000:06d}"


def _headers(api_key, jwt=None):
    h = {"Content-Type": "application/json", "Accept": "application/json", "X-UserType": "USER", "X-SourceID": "WEB",
         "X-ClientLocalIP": "127.0.0.1", "X-ClientPublicIP": "127.0.0.1", "X-MACAddress": "00:00:00:00:00:00",
         "X-PrivateKey": api_key}
    if jwt:
        h["Authorization"] = f"Bearer {jwt}"
    return h


def login(otp=None):
    """Log in with the stored credentials (the TOTP secret, or `otp` typed in); the JWT stays in memory."""
    s = _settings()
    missing = [k for k in ("ANGEL_API_KEY", "ANGEL_CLIENT_CODE", "ANGEL_PIN") if not s[k]]
    if missing:
        raise ValueError("Missing: " + ", ".join(m.replace("ANGEL_", "").replace("_", " ").lower() for m in missing))
    code = (otp or "").strip() or (_totp(s["ANGEL_TOTP_SECRET"]) if s["ANGEL_TOTP_SECRET"] else "")
    if not code:
        raise ValueError("No TOTP secret stored: enter the 6-digit code from your authenticator")
    r = requests.post(f"{BASE}/rest/auth/angelbroking/user/v1/loginByPassword", headers=_headers(s["ANGEL_API_KEY"]),
                      json={"clientcode": s["ANGEL_CLIENT_CODE"], "password": s["ANGEL_PIN"], "totp": code}, timeout=20)
    body = r.json() if r.content else {}
    if not body.get("status") or not (body.get("data") or {}).get("jwtToken"):
        raise ValueError(body.get("message") or f"Login failed (HTTP {r.status_code})")
    jwt = body["data"]["jwtToken"]
    name = None
    try:
        p = requests.get(f"{BASE}/rest/secure/angelbroking/user/v1/getProfile", headers=_headers(s["ANGEL_API_KEY"], jwt), timeout=20).json()
        name = (p.get("data") or {}).get("name")
    except Exception:
        pass
    _session.update(jwt=jwt, at=time.strftime("%Y-%m-%d %H:%M"), name=name)
    return credentials()


def get(path, payload):
    """A logged-in SmartAPI POST (e.g. historical candles), for the data tests."""
    if not _session["jwt"]:
        login()
    s = _settings()
    r = requests.post(f"{BASE}{path}", headers=_headers(s["ANGEL_API_KEY"], _session["jwt"]), json=payload, timeout=30)
    return r.json() if r.content else {"status": False, "message": f"HTTP {r.status_code}"}
