import os
import time
from pathlib import Path

from dotenv import load_dotenv
from kiteconnect import KiteConnect

import db

load_dotenv(Path(__file__).resolve().parent / ".env", override=True)

# Kite credentials live in the app_settings table. Environment variables are
# only a fallback for keys that have never been saved to the database.
KEYS = ("KITE_API_KEY", "KITE_API_SECRET", "KITE_ACCESS_TOKEN")

_CACHE_TTL = 60
_cache = {"at": 0.0, "status": None}


def _settings():
    stored = db.get_settings(KEYS)
    return {key: stored.get(key, os.environ.get(key, "")) for key in KEYS}


def _client(settings=None):
    settings = settings or _settings()
    kite = KiteConnect(api_key=settings["KITE_API_KEY"])
    if settings["KITE_ACCESS_TOKEN"]:
        kite.set_access_token(settings["KITE_ACCESS_TOKEN"])
    return kite


def trading_client():
    """Authenticated KiteConnect client for data jobs."""
    settings = _settings()
    if not settings["KITE_API_KEY"] or not settings["KITE_ACCESS_TOKEN"]:
        raise RuntimeError("Kite API key and access token are required. Connect Kite first.")
    return _client(settings)


def status(force=False):
    """Check the access token with a profile call; cached to avoid hammering Kite."""
    if not force and _cache["status"] and time.time() - _cache["at"] < _CACHE_TTL:
        return _cache["status"]
    settings = _settings()
    if not settings["KITE_API_KEY"] or not settings["KITE_ACCESS_TOKEN"]:
        result = {"connected": False, "error": "KITE_API_KEY / KITE_ACCESS_TOKEN not set"}
    else:
        try:
            profile = _client(settings).profile()
            result = {"connected": True, "user_id": profile.get("user_id"), "user_name": profile.get("user_name")}
        except Exception as exc:
            result = {"connected": False, "error": f"{type(exc).__name__}: {exc}"}
    result["checked_at"] = int(time.time())
    _cache.update(at=time.time(), status=result)
    return result


def login_url():
    return _client().login_url()


def credentials():
    """API key is shown masked; the secret is never returned."""
    settings = _settings()
    key = settings["KITE_API_KEY"]
    return {
        "api_key": f"{key[:4]}…{key[-2:]}" if len(key) > 6 else ("set" if key else ""),
        "has_api_key": bool(key),
        "has_api_secret": bool(settings["KITE_API_SECRET"]),
    }


def save_credentials(api_key=None, api_secret=None):
    updates = {}
    if api_key:
        if api_key != _settings()["KITE_API_KEY"]:
            # A new key invalidates the old access token.
            updates["KITE_ACCESS_TOKEN"] = ""
        updates["KITE_API_KEY"] = api_key
    if api_secret:
        updates["KITE_API_SECRET"] = api_secret
    if updates:
        db.set_settings(updates)
    _cache["status"] = None
    return credentials()


def create_session(request_token):
    """Exchange a request_token for an access token and store it in the database."""
    settings = _settings()
    if not settings["KITE_API_SECRET"]:
        raise RuntimeError("API secret is not set. Save it under API credentials first.")
    data = _client(settings).generate_session(request_token, api_secret=settings["KITE_API_SECRET"])
    db.set_settings({"KITE_ACCESS_TOKEN": data["access_token"]})
    return status(force=True)


def reveal_credentials():
    """Full API key and secret. Only reachable by a logged-in user."""
    settings = _settings()
    return {"api_key": settings["KITE_API_KEY"], "api_secret": settings["KITE_API_SECRET"]}
