import os
import re
import time
from pathlib import Path

from dotenv import load_dotenv
from kiteconnect import KiteConnect

ENV_PATH = Path(__file__).resolve().parent / ".env"
load_dotenv(ENV_PATH, override=True)

_CACHE_TTL = 60
_cache = {"at": 0.0, "status": None}


def _client():
    kite = KiteConnect(api_key=os.environ.get("KITE_API_KEY", ""))
    token = os.environ.get("KITE_ACCESS_TOKEN", "")
    if token:
        kite.set_access_token(token)
    return kite


def status(force=False):
    """Check the access token with a profile call; cached to avoid hammering Kite."""
    if not force and _cache["status"] and time.time() - _cache["at"] < _CACHE_TTL:
        return _cache["status"]
    if not os.environ.get("KITE_API_KEY") or not os.environ.get("KITE_ACCESS_TOKEN"):
        result = {"connected": False, "error": "KITE_API_KEY / KITE_ACCESS_TOKEN not set"}
    else:
        try:
            profile = _client().profile()
            result = {"connected": True, "user_id": profile.get("user_id"), "user_name": profile.get("user_name")}
        except Exception as exc:
            result = {"connected": False, "error": f"{type(exc).__name__}: {exc}"}
    result["checked_at"] = int(time.time())
    _cache.update(at=time.time(), status=result)
    return result


def login_url():
    return _client().login_url()


def _save_env(key, value):
    """Set key=value in os.environ and persist it to backend/.env."""
    os.environ[key] = value
    text = ENV_PATH.read_text() if ENV_PATH.exists() else ""
    line = f"{key}={value}"
    pattern = rf"^{re.escape(key)}=.*$"
    if re.search(pattern, text, flags=re.M):
        text = re.sub(pattern, lambda _: line, text, flags=re.M)
    else:
        text = text.rstrip("\n") + f"\n{line}\n"
    ENV_PATH.write_text(text)


def credentials():
    """API key is shown masked; the secret is never returned."""
    key = os.environ.get("KITE_API_KEY", "")
    return {
        "api_key": f"{key[:4]}…{key[-2:]}" if len(key) > 6 else ("set" if key else ""),
        "has_api_key": bool(key),
        "has_api_secret": bool(os.environ.get("KITE_API_SECRET")),
    }


def save_credentials(api_key=None, api_secret=None):
    if api_key:
        if api_key != os.environ.get("KITE_API_KEY"):
            # A new key invalidates the old access token.
            _save_env("KITE_ACCESS_TOKEN", "")
        _save_env("KITE_API_KEY", api_key)
    if api_secret:
        _save_env("KITE_API_SECRET", api_secret)
    _cache["status"] = None
    return credentials()


def create_session(request_token):
    """Exchange a request_token for an access token and persist it to .env."""
    secret = os.environ.get("KITE_API_SECRET", "")
    if not secret:
        raise RuntimeError("API secret is not set. Save it under API credentials first.")
    data = _client().generate_session(request_token, api_secret=secret)
    token = data["access_token"]
    _save_env("KITE_ACCESS_TOKEN", token)
    return status(force=True)
