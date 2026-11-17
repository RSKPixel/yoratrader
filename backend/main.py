from datetime import date as _date, timezone
import asyncio
import json
import os
import threading
import time
import uuid

import uvicorn
from fastapi import FastAPI, HTTPException, Query, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, RedirectResponse, StreamingResponse
from pydantic import BaseModel

from contracts import list_contracts
from db import stored_lot_sizes, fetch_candles, fetch_intraday_candles, fetch_kbdt_signals, fetch_ut_rows, ut_bar_counts
from eod import download_eod
from intraday import download_intraday
from kbdt_scan import scan_kbdt
from ut_data import build_ut_data
import auth
import backtest
import gapwatch
import kite_auth
import fib
import kbdtfib
import orb
import ws_hub
import pairs
import xsmr
import xsmom
import qmom
import v2gap
import v2kbdt
import v2xsmr
import v2pairs
import v2xsmom
import v2qmom
import v2connors
import v2paper
import v2data
import v2dashboard
import v2live
import v2pnl
import v2oops
import v2tom
import v2ltlv
import livetrade
import oopswatch
import usersettings
import modelstatus
import connors
import xsmrwatch
import connorswatch

jobs = {}

app = FastAPI(title="YoraTrader")


@app.on_event("startup")
async def startup():
    ws_hub.set_loop(asyncio.get_running_loop())
    # Buy-on-gap paper trading records picks at the open and exits after 15:15 on its own, but
    # only in production: dev shares the database and would record everything twice.
    if os.environ.get("APP_ENV") == "production" or os.environ.get("GAP_SCHEDULER") == "1":
        gapwatch.start_scheduler(after_close=scheduled_live_download)
    v2xsmr.warm()  # the cross-sectional page's 15m prices (~40 s), so the first visit is quick
    v2oops.warm()  # the Oops backtest's fills from the 1-minute candles (~1-2 min)
    v2dashboard.models()  # the dashboard's strategy table, built in the background


def _cors_origins():
    raw = os.environ.get(
        "CORS_ORIGINS",
        "http://127.0.0.1:3001,http://localhost:3001,http://127.0.0.1:8007,http://localhost:8007",
    )
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


app.add_middleware(auth.AuthMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "app": "yoratrader",
        "ws": "/ws/events",
        "sse": "/api/events/stream",
        "clients": ws_hub.client_counts(),
        "env": os.environ.get("APP_ENV", "development"),
    }


class KiteSessionRequest(BaseModel):
    request_token: str


class KiteCredentialsRequest(BaseModel):
    api_key: str = ""
    api_secret: str = ""


class LoginRequest(BaseModel):
    username: str
    password: str


class SettingsRequest(BaseModel):
    values: dict


class TotpRequest(BaseModel):
    challenge: str
    code: str


class NameRequest(BaseModel):
    display_name: str = ""


class PasswordRequest(BaseModel):
    current_password: str
    new_password: str


@app.post("/api/auth/login")
def auth_login(req: LoginRequest):
    """Step 1: the password. Returns a challenge for the authenticator code (and a QR code the first time)."""
    try:
        step = auth.login(req.username, req.password)
    except auth.LoginLocked as exc:
        raise HTTPException(status_code=429, detail=str(exc))
    if not step:
        if auth.user_count() == 0:
            raise HTTPException(status_code=401, detail="No user set up yet. Run backend/manage_user.py on the server.")
        raise HTTPException(status_code=401, detail="Incorrect user ID or password.")
    return step


@app.post("/api/auth/totp")
def auth_totp(req: TotpRequest, response: Response):
    """Step 2: the 6-digit Google Authenticator code. Sets the session cookie (valid until the next 06:00 IST)."""
    try:
        issued = auth.verify_totp(req.challenge, req.code)
    except auth.LoginLocked as exc:
        raise HTTPException(status_code=429, detail=str(exc))
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc))
    if not issued:
        raise HTTPException(status_code=401, detail="Incorrect code. Check the time on your phone and try the current code.")
    token, expires = issued
    response.set_cookie(value=token, expires=expires.astimezone(timezone.utc), **auth.cookie_kwargs())
    return {"user": auth.session_user(token)}


@app.post("/api/auth/logout")
def auth_logout(request: Request, response: Response):
    auth.logout(request.cookies.get(auth.COOKIE_NAME))
    response.delete_cookie(**auth.cookie_kwargs())
    return {"ok": True}


@app.get("/api/auth/me")
def auth_me(request: Request):
    return {"user": request.state.user}


class ModelStatusRequest(BaseModel):
    model: str
    status: str


@app.get("/api/v2/models/status")
def models_status():
    """Every model's status (research when not listed): testing, live or archived."""
    return {"status": "success", "statuses": modelstatus.all_statuses()}


@app.put("/api/v2/models/status")
def models_status_put(req: ModelStatusRequest, request: Request):
    try:
        return {"status": "success", "model": req.model,
                "model_status": modelstatus.set_status(req.model, req.status, request.state.user.get("username"))}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/settings")
def settings_get(request: Request):
    """The signed-in user's settings (theme, page parameters...): none are kept in the browser."""
    return {"settings": usersettings.get_all(request.state.user["id"])}


@app.put("/api/settings")
def settings_put(req: SettingsRequest, request: Request):
    try:
        usersettings.put(request.state.user["id"], req.values)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"ok": True}


@app.post("/api/auth/name")
def auth_name(req: NameRequest, request: Request):
    try:
        return {"user": auth.set_display_name(request.state.user["id"], req.display_name)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/auth/password")
def auth_password(req: PasswordRequest, request: Request):
    try:
        user = auth.change_password(
            request.state.user["id"],
            req.current_password,
            req.new_password,
            keep_token=request.cookies.get(auth.COOKIE_NAME),
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"user": user}


@app.get("/api/kite/credentials/reveal")
def kite_reveal_credentials():
    return kite_auth.reveal_credentials()


@app.get("/api/kite/credentials")
def kite_credentials():
    return kite_auth.credentials()


@app.post("/api/kite/credentials")
def kite_save_credentials(req: KiteCredentialsRequest):
    return kite_auth.save_credentials(req.api_key.strip() or None, req.api_secret.strip() or None)


@app.get("/api/kite/status")
def kite_status(refresh: bool = False):
    return kite_auth.status(force=refresh)


@app.get("/api/kite/login")
def kite_login():
    return RedirectResponse(kite_auth.login_url())


@app.get("/api/kite/callback")
def kite_callback(request_token: str = "", status: str = ""):
    """Kite redirect URL target: set the app's redirect URL to this endpoint."""
    try:
        result = kite_auth.create_session(request_token)
    except Exception as exc:
        return HTMLResponse(f"<p>Kite login failed: {exc}</p>", status_code=400)
    ws_hub.notify({"type": "kite", **result})
    return HTMLResponse("<p>Kite connected. You can close this tab.</p>" if result["connected"] else f"<p>Kite login failed: {result.get('error')}</p>")


@app.post("/api/kite/session")
def kite_session(req: KiteSessionRequest):
    try:
        return kite_auth.create_session(req.request_token.strip())
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/events/stream")
async def events_stream(request: Request):
    """SSE live updates — works through reverse proxies that block WebSockets."""
    queue: asyncio.Queue = asyncio.Queue(maxsize=64)
    await ws_hub.register_sse(queue)
    client = request.client.host if request.client else "unknown"
    print(f"SSE connect from {client}")

    async def generate():
        try:
            hello = {
                "type": "status",
                "level": "info",
                "message": "Connected for live updates (SSE)",
                "transport": "sse",
            }
            yield f"data: {json.dumps(hello)}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    message = await asyncio.wait_for(queue.get(), timeout=20)
                    yield f"data: {json.dumps(message)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            await ws_hub.unregister_sse(queue)
            print(f"SSE disconnect from {client}")

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/contracts")
def contracts(exchange: str = Query("ALL")):
    try:
        rows = list_contracts(exchange)
        counts = ut_bar_counts()
        for row in rows:
            row["ut_bars"] = counts.get((row["exchange"], row["name"]), 0)
    except Exception as error:
        print("Error fetching contracts:", error)
        return {"status": "error", "message": str(error), "data": []}

    return {"status": "success", "data": rows}


@app.get("/api/candles")
def candles(
    exchange: str = Query(...),
    symbol: str = Query(...),
    enrich: bool = Query(False),
    tf: str = Query("D"),
):
    try:
        if tf == "15m":
            rows = fetch_intraday_candles(exchange.upper(), symbol.upper())
        else:
            rows = fetch_candles(exchange.upper(), symbol.upper(), enrich=enrich)
    except Exception as error:
        print("Error fetching candles:", error)
        return {"status": "error", "message": str(error), "data": []}

    return {"status": "success", "data": rows}


@app.websocket("/ws/events")
async def events_ws(websocket: WebSocket):
    client = f"{websocket.client.host}:{websocket.client.port}" if websocket.client else "unknown"
    print(f"WebSocket connect from {client}")
    await websocket.accept()
    await ws_hub.register(websocket)
    try:
        while True:
            message = await websocket.receive_text()
            if message in {"hello", "ping", "diag"}:
                await websocket.send_json(
                    {
                        "type": "status",
                        "level": "info",
                        "message": "pong" if message == "ping" else "Connected for live updates",
                    }
                )
    except WebSocketDisconnect as error:
        print(f"WebSocket disconnect from {client}: code={getattr(error, 'code', None)}")
    except Exception as error:
        print(f"WebSocket error from {client}: {error}")
    finally:
        await ws_hub.unregister(websocket)
        print(f"WebSocket unregistered {client}")


# The latest live-futures download (the Data page resumes its progress line from it).
data_job = {"id": None, "kind": None, "started_at": None}


class EodRequest(BaseModel):
    symbols: list[str]
    full: bool = False  # EOD only: continuous daily history from 2010 instead of the last 30 days


LABELS = {"eod": "EOD", "full": "Full EOD history", "idata": "iData (15m)"}


def _run_data_job(kind, symbols, job_id=None):
    """One live-futures download (eod: the last 30 days; full: from 2010; idata: 15m from the
    previous expiry), with the progress the Data page shows. Runs in the calling thread."""
    job_id = job_id or uuid.uuid4().hex
    data_job.update(id=job_id, kind=kind, started_at=int(time.time()))
    total = len(symbols)
    event = "idata_progress" if kind == "idata" else "eod_progress"
    label = LABELS[kind]
    jobs[job_id] = {"status": "running", "done": 0, "total": total, "symbol": "", "candles": 0, "errors": []}
    ws_hub.notify({"type": "status", "level": "info", "message": f"{label} download started for {total} symbols", "job_id": job_id})

    def on_progress(state):
        jobs[job_id] = state
        ws_hub.notify({"type": event, "job_id": job_id, **state})
        if state.get("status") == "running" and state.get("symbol"):
            message = f"Downloading {label} {state['done'] + 1}/{state['total']}: {state['symbol']}"
            ws_hub.notify({"type": "status", "level": "info", "message": message, "job_id": job_id})
        elif state.get("status") == "completed":
            failed = len(state.get("errors") or [])
            suffix = f" ({failed} failed)" if failed else ""
            ws_hub.notify({"type": "status", "level": "success" if failed == 0 else "info",
                           "message": f"{label} download complete. Saved {state.get('candles', 0)} candles{suffix}", "job_id": job_id})

    try:
        if kind == "idata":
            download_intraday(symbols, on_progress)
        else:
            download_eod(symbols, on_progress, full=kind == "full")
    except Exception as error:
        print(f"Error downloading {label}:", error)
        state = {"status": "error", "message": str(error), "done": 0, "total": total, "symbol": "", "candles": 0, "errors": []}
        jobs[job_id] = state
        ws_hub.notify({"type": event, "job_id": job_id, **state})
        ws_hub.notify({"type": "status", "level": "error", "message": f"{label} download failed: {error}", "job_id": job_id})
    return jobs[job_id]


def _start_data_job(kind, symbols):
    if data_job["id"] and (jobs.get(data_job["id"]) or {}).get("status") == "running":
        raise HTTPException(status_code=409, detail="A download is already running.")
    job_id = uuid.uuid4().hex
    threading.Thread(target=_run_data_job, args=(kind, symbols, job_id), daemon=True).start()
    return {"status": "success", "job_id": job_id}


@app.post("/api/eod")
def eod(body: EodRequest):
    return _start_data_job("full" if body.full else "eod", body.symbols)


@app.post("/api/idata")
def idata(body: EodRequest):
    return _start_data_job("idata", body.symbols)


def scheduled_live_download():
    """After the close (the production scheduler, 15:50): every live future's last 30 days of daily
    candles, then its 15m candles from the previous expiry. Skipped if a download is already running."""
    if data_job["id"] and (jobs.get(data_job["id"]) or {}).get("status") == "running":
        return {"ran": False, "reason": "a download is already running"}
    symbols = sorted({row["name"] for row in list_contracts("ALL")})
    out = {}
    for kind in ("eod", "idata"):
        state = _run_data_job(kind, symbols)
        out[kind] = {"status": state.get("status"), "candles": state.get("candles"), "errors": len(state.get("errors") or [])}
    print("Live futures download:", out)
    return {"ran": True, **out}


MODELS = {"orb": orb, "fib": fib, "kbdtfib": kbdtfib}


def with_lot_sizes(trades):
    """Attach the contract lot size to each trade (Kite reports 1 for MCX lots)."""
    lots = stored_lot_sizes()
    for trade in trades:
        trade["lot_size"] = lots.get((trade["exchange"], trade["symbol"]))
    return trades


@app.get("/api/models/{model}")
def model_trades(
    model: str,
    exchange: str = Query(""),
    symbol: str = Query(""),
    universe: str = Query("index"),
    max_per_day: int = Query(3, ge=0),
):
    """Intraday model trades (orb / fib / kbdtfib); one symbol for the chart, or a universe for the page."""
    engine = MODELS.get(model)
    if engine is None:
        return {"status": "error", "message": f"unknown model {model}", "data": [], "summary": {}}
    if universe not in orb.UNIVERSES:
        return {"status": "error", "message": f"universe must be one of {', '.join(orb.UNIVERSES)}", "data": [], "summary": {}}
    try:
        trades = engine.scan(exchange.upper() or None, symbol.upper() or None, universe)
        if not symbol:
            trades = orb.cap_per_day(trades, max_per_day)
    except Exception as error:
        print(f"Error running {model}:", error)
        return {"status": "error", "message": str(error), "data": [], "summary": {}}
    return {"status": "success", "data": with_lot_sizes(trades), "summary": orb.summarize(trades)}


@app.post("/api/models/{model}/refresh")
def model_refresh(model: str, universe: str = Query("index"), max_per_day: int = Query(3, ge=0)):
    """Download today's 15m bars for the universe, then rescan with the model."""
    if model not in MODELS:
        return {"status": "error", "message": f"unknown model {model}", "data": [], "summary": {}}
    if universe not in orb.UNIVERSES:
        return {"status": "error", "message": f"universe must be one of {', '.join(orb.UNIVERSES)}", "data": [], "summary": {}}
    try:
        rows = [row for row in list_contracts("ALL") if orb._in_universe(row["exchange"], row["name"], universe)]
        exchange = universe.upper() if universe in ("nse", "mcx") else None
        result = download_intraday([row["name"] for row in rows], today_only=True, exchange=exchange)
        trades = orb.cap_per_day(MODELS[model].scan(universe=universe), max_per_day)
    except Exception as error:
        print(f"Error refreshing {model}:", error)
        return {"status": "error", "message": str(error), "data": [], "summary": {}}
    return {
        "status": "success",
        "data": with_lot_sizes(trades),
        "summary": orb.summarize(trades),
        "download": {"symbols": result["symbols"], "candles": result["candles"], "errors": result["errors"]},
    }


backtest_job = {"id": None}


@app.post("/api/backtest/orb/download")
def backtest_download():
    """Download or top up the backtest data (F&O indices and stocks from 2015, Nifty 50 5 years), then rerun the backtests."""
    current = jobs.get(backtest_job["id"]) if backtest_job["id"] else None
    if current and current.get("status") == "running":
        return {"status": "success", "job_id": backtest_job["id"]}
    job_id = uuid.uuid4().hex
    backtest_job["id"] = job_id
    jobs[job_id] = {"status": "running", "phase": "download", "done": 0, "total": 56, "symbol": "", "candles": 0, "errors": []}
    ws_hub.notify({"type": "status", "level": "info", "message": "Backtest data download started", "job_id": job_id})

    def on_progress(state):
        jobs[job_id] = state
        if state.get("status") == "running" and state.get("symbol"):
            if state.get("phase") == "download":
                message = f"Backtest data {state['done'] + 1}/{state['total']}: {state['symbol']}"
            else:
                message = "Running the KBDT backtest: all settings"
            ws_hub.notify({"type": "status", "level": "info", "message": message, "job_id": job_id})
        elif state.get("status") == "completed":
            failed = len(state.get("errors") or [])
            suffix = f" ({failed} failed)" if failed else ""
            ws_hub.notify({"type": "status", "level": "success" if not failed else "info",
                           "message": f"Backtest updated. Saved {state.get('candles', 0)} 15m candles{suffix}",
                           "job_id": job_id})

    def run():
        try:
            backtest.download(on_progress)
        except Exception as error:
            print("Backtest download failed:", error)
            jobs[job_id] = {"status": "error", "message": str(error), "phase": "download", "done": 0, "total": 0,
                            "symbol": "", "candles": 0, "errors": []}
            ws_hub.notify({"type": "status", "level": "error", "message": f"Backtest download failed: {error}",
                           "job_id": job_id})

    threading.Thread(target=run, daemon=True).start()
    return {"status": "success", "job_id": job_id}


@app.get("/api/backtest/orb/job")
def backtest_job_status():
    job = jobs.get(backtest_job["id"]) if backtest_job["id"] else None
    return {"status": "success", "job": job}


def _backtest_params(dataset, slippage, model=None, variant=None):
    if dataset not in backtest.DATASETS:
        raise HTTPException(status_code=400, detail=f"dataset must be one of {', '.join(backtest.DATASETS)}")
    if model is not None and variant not in backtest.VARIANTS.get(model, {}):
        raise HTTPException(status_code=400, detail=f"unknown model/variant {model}/{variant}")
    # slippage arrives as percent per side (0.02 = 0.02%)
    return slippage / 100


@app.get("/api/backtest/orb")
def backtest_results(model: str = Query(backtest.DEFAULT_MODEL), variant: str = Query(backtest.DEFAULT_VARIANT),
                     dataset: str = Query("indices"), max_per_day: int = Query(3, ge=0),
                     slippage: float = Query(0.02, ge=0, le=1)):
    slip = _backtest_params(dataset, slippage, model, variant)
    try:
        return {"status": "success", **backtest.results(model, variant, dataset, max_per_day, slip)}
    except Exception as error:
        print("Backtest results failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/backtest/orb/trades")
def backtest_trades(month: str = Query(..., pattern=r"^\d{4}-\d{2}$"), model: str = Query(backtest.DEFAULT_MODEL),
                    variant: str = Query(backtest.DEFAULT_VARIANT), dataset: str = Query("indices"),
                    max_per_day: int = Query(3, ge=0), slippage: float = Query(0.02, ge=0, le=1)):
    slip = _backtest_params(dataset, slippage, model, variant)
    return {"status": "success", "data": backtest.month_trades(model, variant, dataset, month, max_per_day, slip)}


@app.get("/api/backtest/orb/compare")
def backtest_compare(dataset: str = Query("indices"), max_per_day: int = Query(3, ge=0),
                     slippage: float = Query(0.02, ge=0, le=1), model: str = Query("")):
    slip = _backtest_params(dataset, slippage)
    try:
        return {"status": "success", "data": backtest.compare(dataset, max_per_day, slip, model or None)}
    except Exception as error:
        print("Backtest compare failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/backtest/kbdt/signals")
def backtest_kbdt_signals(exit: str = Query("5d", pattern=r"^[135]d$"), stop_mode: str = Query("model"),
                          stop_pct: float = Query(0.75, gt=0, le=5), slippage: float = Query(0.02, ge=0, le=1),
                          days: int = Query(0, ge=0, le=400)):
    """KBDT signals on the index futures: all available days (days=0) or the last N trading days."""
    if stop_mode not in ("model", "fixed", "cap"):
        raise HTTPException(status_code=400, detail="stop_mode must be model, fixed or cap")
    try:
        data = backtest.recent_kbdt_signals(int(exit[0]), stop_mode, None if stop_mode == "model" else stop_pct,
                                            slippage / 100, days or None)
        return {"status": "success", **data}
    except Exception as error:
        print("KBDT signals failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/kbdt/setups")
def kbdt_next_setups():
    """KBDT setups for the next session on the index futures."""
    try:
        return {"status": "success", "data": backtest.kbdt_setups()}
    except Exception as error:
        print("KBDT setups failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/kbdt/ltp")
def kbdt_ltp():
    """Live last traded price of the index futures (current contracts)."""
    try:
        from datetime import datetime as _dt
        return {"status": "success", "data": backtest.index_futures_ltp(), "at": _dt.now().strftime("%H:%M:%S")}
    except Exception as error:
        print("LTP failed:", error)
        return {"status": "error", "message": str(error)}


PORTFOLIO_MODELS = {"xsmr": xsmr, "pairs": pairs, "xsmom": xsmom, "qmom": qmom, "connors": connors}


def _portfolio_check(model, variant, dataset):
    """Validates a portfolio-model request; returns (module, take)."""
    module = PORTFOLIO_MODELS.get(model)
    if module is None:
        raise HTTPException(status_code=400, detail="unknown model")
    try:
        _, take = module.parse_variant(variant)
    except ValueError:
        raise HTTPException(status_code=400, detail="unknown variant")
    if model != "pairs" and dataset not in module.DATASETS:
        raise HTTPException(status_code=400, detail="unknown dataset")
    return module, take


@app.get("/api/backtest/portfolio")
def backtest_portfolio(model: str = Query("xsmr"), variant: str = Query("intraday-0915"), dataset: str = Query("fno"),
                       slippage: float = Query(0.02, ge=0, le=1), lots: bool = Query(False)):
    """Portfolio-return backtests (cross-sectional mean reversion, pairs): one variant, plus all to compare."""
    module, take = _portfolio_check(model, variant, dataset)
    try:
        if model == "pairs":
            return {"status": "success", **pairs.results(variant, slippage / 100), "compare": pairs.compare(slippage / 100, take)}
        if model in ("xsmom", "qmom", "connors"):
            extra = {"variant": variant} if model in ("connors", "qmom") else {}
            return {"status": "success", **module.results(variant, dataset, slippage / 100, lots=lots),
                    "compare": module.compare(dataset, slippage / 100, take, lots=lots, **extra)}
        return {"status": "success", **xsmr.results(variant, dataset, slippage / 100, lots=lots),
                "compare": xsmr.compare(dataset, slippage / 100, take, lots=lots)}
    except Exception as error:
        print("Portfolio backtest failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/backtest/portfolio/month")
def backtest_portfolio_month(month: str = Query(..., pattern=r"^\d{4}-\d{2}$"), model: str = Query("xsmr"),
                             variant: str = Query("intraday-0915"), dataset: str = Query("fno"),
                             slippage: float = Query(0.02, ge=0, le=1), lots: bool = Query(False)):
    """What one month cell adds up: the days (cross-sectional) or the trades closed (pairs)."""
    module, _ = _portfolio_check(model, variant, dataset)
    try:
        if model == "pairs":
            return {"status": "success", "trades": pairs.month_trades(variant, month, slippage / 100)}
        if model in ("xsmom", "qmom", "connors"):
            return {"status": "success", "days": module.month_days(variant, dataset, month, slippage / 100, lots=lots)}
        return {"status": "success", "days": xsmr.month_days(variant, dataset, month, slippage / 100, lots=lots)}
    except Exception as error:
        print("Portfolio month failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/backtest/portfolio/day")
def backtest_portfolio_day(day: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"), variant: str = Query("intraday-0915"),
                           dataset: str = Query("fno"), model: str = Query("xsmr")):
    """Every stock position of a cross-sectional book (mean reversion or momentum) on one day."""
    if model not in ("xsmr", "xsmom", "qmom", "connors"):
        raise HTTPException(status_code=400, detail="unknown model")
    module, _ = _portfolio_check(model, variant, dataset)
    try:
        return {"status": "success", "trades": module.day_trades(variant, dataset, _date.fromisoformat(day))}
    except Exception as error:
        print("Portfolio day failed:", error)
        return {"status": "error", "message": str(error)}


def _v2gap_args(dataset, side, stop, max_open, slippage):
    if dataset not in v2gap.DATASETS or side not in v2gap.SIDES or stop not in v2gap.STOPS:
        raise HTTPException(status_code=400, detail="unknown dataset, side or stop")
    return dict(dataset=dataset, side=side, stop=stop, max_open=max_open, slippage=slippage / 100)


def _v2oops_args(stop, trend, max_open, slippage):
    if stop not in ("low", "none") or trend not in ("any", "up"):
        raise HTTPException(status_code=400, detail="unknown stop or trend")
    return dict(stop=stop, trend=trend, max_open=max_open, slippage=slippage / 100)


@app.get("/api/v2/backtest/oops")
def v2_backtest_oops(stop: str = Query("none"), trend: str = Query("any"), max_open: int = Query(3, ge=0, le=v2oops.MAX_OPEN),
                     slippage: float = Query(0.02, ge=0, le=1)):
    """Oops gap reversal (v2 page): the day's first N fills on 15-minute candles, capital / N each."""
    args = _v2oops_args(stop, trend, max_open, slippage)
    try:
        return {"status": "success", **v2oops.results(**args)}
    except Exception as error:
        print("v2 oops backtest failed:", error)
        return {"status": "error", "message": str(error)}


def _v2tom_args(index, window, slippage):
    if index not in v2tom.INDICES or window not in v2tom.WINDOWS:
        raise HTTPException(status_code=400, detail="unknown index or window")
    return dict(index=index, window=window, slippage=slippage / 100)


class LiveOrderRequest(BaseModel):
    side: str
    tradingsymbol: str
    lots: int
    price: float


class LivePriceRequest(BaseModel):
    price: float


@app.get("/api/v2/trade/tom")
def v2_trade_tom():
    try:
        return {"status": "success", **livetrade.state()}
    except Exception as error:
        print("Live trading state failed:", error)
        return {"status": "error", "message": str(error)}


@app.post("/api/v2/trade/tom/order")
def v2_trade_tom_order(req: LiveOrderRequest, request: Request):
    """A REAL order on the Kite account (the page confirms first)."""
    try:
        return {"status": "success", **livetrade.place(req.side, req.tradingsymbol, req.lots, req.price, request.state.user.get("username"))}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


class LiveStopRequest(BaseModel):
    tradingsymbol: str
    trigger: float | None = None


@app.post("/api/v2/trade/tom/stop")
def v2_trade_tom_stop(req: LiveStopRequest, request: Request):
    """Set (trigger given) or remove (no trigger) the GTT stop on a held call: REAL, on the Kite account."""
    try:
        user = request.state.user.get("username")
        r = livetrade.set_stop(req.tradingsymbol, req.trigger, user) if req.trigger else livetrade.remove_stop(req.tradingsymbol, user)
        return {"status": "success", **r}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/v2/trade/order/{order_id}/modify")
def v2_trade_modify(order_id: str, req: LivePriceRequest, request: Request):
    try:
        return {"status": "success", **livetrade.modify(order_id, req.price, request.state.user.get("username"))}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/v2/trade/order/{order_id}/cancel")
def v2_trade_cancel(order_id: str, request: Request):
    try:
        return {"status": "success", **livetrade.cancel(order_id, request.state.user.get("username"))}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


def _v2ltlv_args(max_open, trail, slippage, instrument):
    if trail not in v2ltlv.TRAILS or instrument not in v2ltlv.INSTRUMENTS:
        raise HTTPException(status_code=400, detail="unknown trailing stop or instrument")
    return dict(max_open=max_open, trail=trail, slippage=slippage / 100, instrument=instrument)


@app.get("/api/v2/backtest/ltlv")
def v2_backtest_ltlv(max_open: int = Query(10, ge=0, le=10), trail: str = Query("20"), slippage: float = Query(0.02, ge=0, le=1),
                     instrument: str = Query("cash")):
    args = _v2ltlv_args(max_open, trail, slippage, instrument)
    try:
        return {"status": "success", **v2ltlv.results(**args)}
    except Exception as error:
        print("v2 low volatility backtest failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/v2/backtest/ltlv/month")
def v2_backtest_ltlv_month(month: str = Query(..., pattern=r"^\d{4}-\d{2}$"), max_open: int = Query(10, ge=0, le=10), trail: str = Query("20"),
                           slippage: float = Query(0.02, ge=0, le=1), instrument: str = Query("cash")):
    args = _v2ltlv_args(max_open, trail, slippage, instrument)
    try:
        return {"status": "success", "trades": v2ltlv.month_trades(month, **args)}
    except Exception as error:
        print("v2 low volatility month failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/v2/backtest/tom")
def v2_backtest_tom(index: str = Query("nifty"), window: str = Query("4"), slippage: float = Query(0.02, ge=0, le=1)):
    args = _v2tom_args(index, window, slippage)
    try:
        return {"status": "success", **v2tom.results(**args)}
    except Exception as error:
        print("v2 turn of the month backtest failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/v2/backtest/tom/month")
def v2_backtest_tom_month(month: str = Query(..., pattern=r"^\d{4}-\d{2}$"), index: str = Query("nifty"), window: str = Query("4"),
                          slippage: float = Query(0.02, ge=0, le=1)):
    args = _v2tom_args(index, window, slippage)
    try:
        return {"status": "success", "trades": v2tom.month_trades(month, **args)}
    except Exception as error:
        print("v2 turn of the month month failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/v2/backtest/oops/month")
def v2_backtest_oops_month(month: str = Query(..., pattern=r"^\d{4}-\d{2}$"), stop: str = Query("none"), trend: str = Query("any"),
                           max_open: int = Query(3, ge=0, le=v2oops.MAX_OPEN), slippage: float = Query(0.02, ge=0, le=1)):
    args = _v2oops_args(stop, trend, max_open, slippage)
    try:
        return {"status": "success", "trades": v2oops.month_trades(month, **args)}
    except Exception as error:
        print("v2 oops month failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/v2/backtest/gap")
def v2_backtest_gap(dataset: str = Query("fno"), side: str = Query("long"), stop: str = Query("none"),
                    max_open: int = Query(5, ge=0, le=v2gap.MAX_OPEN), slippage: float = Query(0.02, ge=0, le=1)):
    """Buy on gap (v2 page): the stored trades sized by capital and max open, as fractions of capital."""
    args = _v2gap_args(dataset, side, stop, max_open, slippage)
    try:
        return {"status": "success", **v2gap.results(**args)}
    except Exception as error:
        print("v2 gap backtest failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/v2/backtest/gap/month")
def v2_backtest_gap_month(month: str = Query(..., pattern=r"^\d{4}-\d{2}$"), dataset: str = Query("fno"),
                          side: str = Query("long"), stop: str = Query("none"),
                          max_open: int = Query(5, ge=0, le=v2gap.MAX_OPEN), slippage: float = Query(0.02, ge=0, le=1)):
    args = _v2gap_args(dataset, side, stop, max_open, slippage)
    try:
        return {"status": "success", "trades": v2gap.month_trades(month, **args)}
    except Exception as error:
        print("v2 gap month failed:", error)
        return {"status": "error", "message": str(error)}


def _v2kbdt_args(dataset, hold, stop_mode, stop_pct, max_open, slippage):
    if dataset not in v2kbdt.DATASETS or hold not in v2kbdt.HOLDS or stop_mode not in v2kbdt.STOP_MODES \
            or (stop_mode != "model" and stop_pct not in v2kbdt.STOP_PCTS):
        raise HTTPException(status_code=400, detail="unknown dataset, hold or stop")
    return dict(dataset=dataset, hold=hold, stop_mode=stop_mode, stop_pct=stop_pct, max_open=max_open, slippage=slippage / 100)


@app.get("/api/v2/backtest/kbdt")
def v2_backtest_kbdt(dataset: str = Query("indices"), hold: str = Query("5d"), stop_mode: str = Query("model"),
                     stop_pct: float = Query(1.0), max_open: int = Query(5, ge=0, le=v2kbdt.MAX_OPEN),
                     slippage: float = Query(0.02, ge=0, le=1)):
    """Key Breakout Dow Theory (v2 page): the stored trades sized by capital and max open."""
    args = _v2kbdt_args(dataset, hold, stop_mode, stop_pct, max_open, slippage)
    try:
        return {"status": "success", **v2kbdt.results(**args)}
    except Exception as error:
        print("v2 KBDT backtest failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/v2/backtest/kbdt/month")
def v2_backtest_kbdt_month(month: str = Query(..., pattern=r"^\d{4}-\d{2}$"), dataset: str = Query("indices"),
                           hold: str = Query("5d"), stop_mode: str = Query("model"), stop_pct: float = Query(1.0),
                           max_open: int = Query(5, ge=0, le=v2kbdt.MAX_OPEN), slippage: float = Query(0.02, ge=0, le=1)):
    args = _v2kbdt_args(dataset, hold, stop_mode, stop_pct, max_open, slippage)
    try:
        return {"status": "success", "trades": v2kbdt.month_trades(month, **args)}
    except Exception as error:
        print("v2 KBDT month failed:", error)
        return {"status": "error", "message": str(error)}


def _v2xsmr_args(dataset, version, entry, stop, max_open, pairs, slippage):
    if dataset not in v2xsmr.DATASETS or version not in ("intraday", "daily") or entry not in v2xsmr.ENTRIES \
            or stop not in ("none", "1sd"):
        raise HTTPException(status_code=400, detail="unknown dataset, version, entry or stop")
    return dict(dataset=dataset, version=version, entry=entry, stop=stop, max_open=max_open, pairs=pairs, slippage=slippage / 100)


@app.get("/api/v2/backtest/xsmr")
def v2_backtest_xsmr(dataset: str = Query("fno"), version: str = Query("intraday"), entry: str = Query("0915"),
                     stop: str = Query("none"), max_open: int = Query(6, ge=0, le=v2xsmr.MAX_OPEN),
                     pairs: int = Query(3, ge=1, le=5), slippage: float = Query(0.02, ge=0, le=1)):
    """Cross-sectional mean reversion (v2 page): k long + k short within max open (or every stock), as fractions of capital."""
    args = _v2xsmr_args(dataset, version, entry, stop, max_open, pairs, slippage)
    try:
        return {"status": "success", **v2xsmr.results(**args)}
    except Exception as error:
        print("v2 xsmr backtest failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/v2/backtest/xsmr/month")
def v2_backtest_xsmr_month(month: str = Query(..., pattern=r"^\d{4}-\d{2}$"), dataset: str = Query("fno"),
                           version: str = Query("intraday"), entry: str = Query("0915"), stop: str = Query("none"),
                           max_open: int = Query(6, ge=0, le=v2xsmr.MAX_OPEN), pairs: int = Query(3, ge=1, le=5),
                           slippage: float = Query(0.02, ge=0, le=1)):
    args = _v2xsmr_args(dataset, version, entry, stop, max_open, pairs, slippage)
    try:
        return {"status": "success", "trades": v2xsmr.month_trades(month, **args)}
    except Exception as error:
        print("v2 xsmr month failed:", error)
        return {"status": "error", "message": str(error)}


def _v2pairs_args(method, fill, max_open, pairs, slippage):
    if method not in v2pairs.METHODS or fill not in ("close", "next"):
        raise HTTPException(status_code=400, detail="unknown method or fill")
    return dict(method=method, fill=fill, max_open=max_open, pairs=pairs, slippage=slippage / 100)


@app.get("/api/v2/backtest/pairs")
def v2_backtest_pairs(method: str = Query("bollinger"), fill: str = Query("close"), max_open: int = Query(6, ge=0, le=v2pairs.MAX_OPEN),
                      pairs: int = Query(3, ge=1, le=5), slippage: float = Query(0.02, ge=0, le=1)):
    """Pairs trading (v2 page): k pairs at a time within max open (or every selected pair), as fractions of capital."""
    args = _v2pairs_args(method, fill, max_open, pairs, slippage)
    try:
        return {"status": "success", **v2pairs.results(**args)}
    except Exception as error:
        print("v2 pairs backtest failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/v2/backtest/pairs/month")
def v2_backtest_pairs_month(month: str = Query(..., pattern=r"^\d{4}-\d{2}$"), method: str = Query("bollinger"),
                            fill: str = Query("close"), max_open: int = Query(6, ge=0, le=v2pairs.MAX_OPEN),
                            pairs: int = Query(3, ge=1, le=5), slippage: float = Query(0.02, ge=0, le=1)):
    args = _v2pairs_args(method, fill, max_open, pairs, slippage)
    try:
        return {"status": "success", "trades": v2pairs.month_trades(month, **args)}
    except Exception as error:
        print("v2 pairs month failed:", error)
        return {"status": "error", "message": str(error)}


def _v2xsmom_args(dataset, fill, max_open, pairs, slippage):
    if dataset not in v2xsmom.DATASETS or fill not in ("close", "next"):
        raise HTTPException(status_code=400, detail="unknown dataset or fill")
    return dict(dataset=dataset, fill=fill, max_open=max_open, pairs=pairs, slippage=slippage / 100)


@app.get("/api/v2/backtest/xsmom")
def v2_backtest_xsmom(dataset: str = Query("fno"), fill: str = Query("close"), max_open: int = Query(6, ge=0, le=v2xsmom.MAX_OPEN),
                      pairs: int = Query(3, ge=1, le=5), slippage: float = Query(0.02, ge=0, le=1)):
    """Cross-sectional momentum (v2 page): k strongest + k weakest re-ranked every 25 days, or Chan's book."""
    args = _v2xsmom_args(dataset, fill, max_open, pairs, slippage)
    try:
        return {"status": "success", **v2xsmom.results(**args)}
    except Exception as error:
        print("v2 xsmom backtest failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/v2/backtest/xsmom/month")
def v2_backtest_xsmom_month(month: str = Query(..., pattern=r"^\d{4}-\d{2}$"), dataset: str = Query("fno"),
                            fill: str = Query("close"), max_open: int = Query(6, ge=0, le=v2xsmom.MAX_OPEN),
                            pairs: int = Query(3, ge=1, le=5), slippage: float = Query(0.02, ge=0, le=1)):
    args = _v2xsmom_args(dataset, fill, max_open, pairs, slippage)
    try:
        return {"status": "success", "trades": v2xsmom.month_trades(month, **args)}
    except Exception as error:
        print("v2 xsmom month failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/v2/backtest/gapmom")
def v2_backtest_gapmom(dataset: str = Query("indices"), side: str = Query("both"), stop: str = Query("none"),
                       max_open: int = Query(5, ge=0, le=v2gap.MAX_OPEN), slippage: float = Query(0.02, ge=0, le=1)):
    """Opening gap momentum (v2 page): the stored trades sized by capital and max open."""
    if dataset not in v2gap.GAPMOM_DATASETS:
        raise HTTPException(status_code=400, detail="unknown dataset")
    args = _v2gap_args(dataset, side, stop, max_open, slippage)
    try:
        return {"status": "success", **v2gap.results(**args, model="gapmom")}
    except Exception as error:
        print("v2 gapmom backtest failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/v2/backtest/gapmom/month")
def v2_backtest_gapmom_month(month: str = Query(..., pattern=r"^\d{4}-\d{2}$"), dataset: str = Query("indices"),
                             side: str = Query("both"), stop: str = Query("none"),
                             max_open: int = Query(5, ge=0, le=v2gap.MAX_OPEN), slippage: float = Query(0.02, ge=0, le=1)):
    if dataset not in v2gap.GAPMOM_DATASETS:
        raise HTTPException(status_code=400, detail="unknown dataset")
    args = _v2gap_args(dataset, side, stop, max_open, slippage)
    try:
        return {"status": "success", "trades": v2gap.month_trades(month, **args, model="gapmom")}
    except Exception as error:
        print("v2 gapmom month failed:", error)
        return {"status": "error", "message": str(error)}


def _v2qmom_args(dataset, version, hedge, max_open, slippage):
    if dataset not in v2qmom.DATASETS or version not in v2qmom.VERSIONS or hedge not in ("none", "nifty"):
        raise HTTPException(status_code=400, detail="unknown dataset, version or hedge")
    return dict(dataset=dataset, version=version, hedge=hedge, max_open=max_open, slippage=slippage / 100)


@app.get("/api/v2/backtest/qmom")
def v2_backtest_qmom(dataset: str = Query("fno"), version: str = Query("book"), hedge: str = Query("none"),
                     max_open: int = Query(5, ge=0, le=v2qmom.MAX_OPEN), slippage: float = Query(0.02, ge=0, le=1)):
    """Quantitative momentum (v2 page): holdings per rebalance period, sized by capital and max open."""
    args = _v2qmom_args(dataset, version, hedge, max_open, slippage)
    try:
        return {"status": "success", **v2qmom.results(**args)}
    except Exception as error:
        print("v2 qmom backtest failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/v2/backtest/qmom/month")
def v2_backtest_qmom_month(month: str = Query(..., pattern=r"^\d{4}-\d{2}$"), dataset: str = Query("fno"),
                           version: str = Query("book"), hedge: str = Query("none"),
                           max_open: int = Query(5, ge=0, le=v2qmom.MAX_OPEN), slippage: float = Query(0.02, ge=0, le=1)):
    args = _v2qmom_args(dataset, version, hedge, max_open, slippage)
    try:
        return {"status": "success", "trades": v2qmom.month_trades(month, **args)}
    except Exception as error:
        print("v2 qmom month failed:", error)
        return {"status": "error", "message": str(error)}


def _v2connors_args(dataset, setup, hold, max_open, stop, timing, take, slippage, side="long"):
    if dataset not in v2connors.DATASETS or setup not in v2connors.SETUPS or hold not in v2connors.HOLDS \
            or stop not in v2connors.STOPS or timing not in v2connors.TIMINGS or take not in v2connors.TAKES \
            or side not in v2connors.SIDES:
        raise HTTPException(status_code=400, detail="unknown setting")
    return dict(dataset=dataset, setup=setup, hold=hold, max_open=max_open, stop=stop, timing=timing, take=take,
                slippage=slippage / 100, side=side)


@app.get("/api/v2/backtest/connors")
def v2_backtest_connors(dataset: str = Query("fno"), setup: str = Query("rsi2"), hold: str = Query("5d"),
                        max_open: int = Query(3, ge=0, le=v2connors.MAX_OPEN), stop: str = Query("none"),
                        timing: str = Query("close"), take: str = Query("all"), slippage: float = Query(0.02, ge=0, le=1),
                        side: str = Query("long")):
    """Short-term mean reversion (v2 page): connors' trades, max open slots or the book."""
    args = _v2connors_args(dataset, setup, hold, max_open, stop, timing, take, slippage, side)
    try:
        return {"status": "success", **v2connors.results(**args)}
    except Exception as error:
        print("v2 connors backtest failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/v2/backtest/connors/month")
def v2_backtest_connors_month(month: str = Query(..., pattern=r"^\d{4}-\d{2}$"), dataset: str = Query("fno"),
                              setup: str = Query("rsi2"), hold: str = Query("5d"),
                              max_open: int = Query(3, ge=0, le=v2connors.MAX_OPEN), stop: str = Query("none"),
                              timing: str = Query("close"), take: str = Query("all"), slippage: float = Query(0.02, ge=0, le=1),
                              side: str = Query("long")):
    args = _v2connors_args(dataset, setup, hold, max_open, stop, timing, take, slippage, side)
    try:
        return {"status": "success", "trades": v2connors.month_trades(month, **args)}
    except Exception as error:
        print("v2 connors month failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/v2/paper/gap")
def v2_paper_gap(side: str = Query("long"), stop: str = Query("none"), max_open: int = Query(5, ge=0, le=10),
                 slippage: float = Query(0.02, ge=0, le=1)):
    """Buy/Sell on gap paper trading (v2 page): the recorded picks sized by capital and max open."""
    if side not in ("long", "both") or stop not in ("none", "1sd"):
        raise HTTPException(status_code=400, detail="unknown side or stop")
    try:
        return {"status": "success", **v2paper.gap(side, stop, max_open, slippage / 100)}
    except Exception as error:
        print("v2 gap paper failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/v2/paper/{model}/pnl")
def v2_paper_pnl(model: str, day: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"), side: str = Query("long"), stop: str = Query("none"),
                 pairs: int = Query(5, ge=1, le=5), max_open: int = Query(5, ge=0, le=10), slippage: float = Query(0.02, ge=0, le=1),
                 meta: bool = False):
    """A paper day's P&L every 15 minutes (the page's positions, one lot each; meta: at the meta-sizing's lots)."""
    if model not in ("gap", "xsmr", "oops") or side not in ("long", "both") or stop not in ("none", "1sd"):
        raise HTTPException(status_code=400, detail="unknown model, side or stop")
    try:
        if model == "oops":
            data = oopswatch.paper(slippage / 100)
        else:
            data = v2paper.gap(side, stop, max_open, slippage / 100) if model == "gap" else v2paper.xsmr_(pairs, stop, max_open, slippage / 100)
        d = next((x for x in data["days"] if x["day"] == day), None)
        if d is None:
            return {"status": "success", "points": [], "positions": 0}
        size = (d.get("meta") or {}).get("size", 1) if meta else 1
        return {"status": "success", "size": size, **v2pnl.curve(day, d["picks"], xsmr.cost_per_side(slippage / 100), size)}
    except Exception as error:
        print("v2 paper pnl failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/v2/paper/oops")
def v2_paper_oops(slippage: float = Query(0.02, ge=0, le=1)):
    """Oops gap reversal paper trading: today's watchlist and positions, the days."""
    try:
        return {"status": "success", **oopswatch.paper(slippage / 100)}
    except Exception as error:
        print("v2 oops paper failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/v2/paper/oops/settings")
def v2_paper_oops_settings():
    return {"status": "success", "max_open": oopswatch.max_open(), "max_open_limit": oopswatch.MAX_OPEN_LIMIT,
            "universe": "fno", "universes": ["fno"], "stop": oopswatch.stop_mode()}


class OopsStopRequest(BaseModel):
    stop: str


@app.post("/api/v2/paper/oops/stop")
def v2_paper_oops_stop(req: OopsStopRequest):
    try:
        return {"status": "success", "stop": oopswatch.set_stop_mode(req.stop)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


class OopsMaxOpenRequest(BaseModel):
    max_open: int


@app.post("/api/v2/paper/oops/max_open")
def v2_paper_oops_max_open(req: OopsMaxOpenRequest):
    try:
        return {"status": "success", "max_open": oopswatch.set_max_open(req.max_open)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/v2/paper/xsmr")
def v2_paper_xsmr(pairs: int = Query(5, ge=1, le=5), stop: str = Query("none"), max_open: int = Query(10, ge=0, le=10),
                  slippage: float = Query(0.02, ge=0, le=1)):
    """Cross-sectional mean reversion paper trading (v2 page): the recorded 5 + 5, k + k of them by capital and max open."""
    if stop not in ("none", "1sd"):
        raise HTTPException(status_code=400, detail="unknown stop")
    try:
        return {"status": "success", **v2paper.xsmr_(pairs, stop, max_open, slippage / 100)}
    except Exception as error:
        print("v2 xsmr paper failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/v2/data/job")
def v2_data_job():
    """The latest live-futures download and its state (so the page can show it after you come back)."""
    job = jobs.get(data_job["id"]) if data_job["id"] else None
    return {"status": "success", "job": {**data_job, "state": job} if job else None}


@app.get("/api/v2/data/symbols")
def v2_data_symbols(source: str = Query("backtest"), refresh: bool = Query(False)):
    """Every stored symbol with its daily / 15m / 1m coverage (v2 Data page)."""
    if source not in ("backtest", "live"):
        raise HTTPException(status_code=400, detail="unknown source")
    try:
        return {"status": "success", **v2data.symbols(source, refresh)}
    except Exception as error:
        print("v2 data symbols failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/v2/data/candles")
def v2_data_candles(symbol: str = Query(..., min_length=1, max_length=40), interval: str = Query("day"),
                    source: str = Query("backtest"), exchange: str = Query("NSE"), days: int = Query(365, ge=0, le=20000)):
    if interval not in ("day", "15m") or source not in ("backtest", "live", "kite") or exchange not in ("NSE", "MCX"):
        raise HTTPException(status_code=400, detail="unknown interval, source or exchange")
    try:
        if source == "kite":  # the stock straight from Kite, today's candles included (paper pages)
            return {"status": "success", "candles": v2data.kite_candles(symbol, interval, days)}
        return {"status": "success", "candles": v2data.candles(symbol, interval, source, exchange, days)}
    except Exception as error:
        print("v2 data candles failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/v2/dashboard")
def v2_dashboard(gap_max_open: int = Query(5, ge=0, le=v2gap.MAX_OPEN), xsmr_max_open: int = Query(10, ge=0, le=v2xsmr.MAX_OPEN)):
    """Today at a glance: market status, Kite, the scheduler's steps, indices, paper trading (at the
    paper pages' max open), data freshness."""
    try:
        return {"status": "success", **v2dashboard.overview(gap_max_open, xsmr_max_open)}
    except Exception as error:
        print("v2 dashboard failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/v2/live")
def v2_live(refresh: bool = False):
    """The real Kite account, read-only: funds, positions, today's orders and trades, holdings."""
    try:
        return {"status": "success", **v2live.account(force=refresh)}
    except Exception as error:
        print("v2 live failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/v2/dashboard/models")
def v2_dashboard_models():
    """Every backtest at its default settings (built in the background, cached)."""
    try:
        return {"status": "success", **v2dashboard.models()}
    except Exception as error:
        print("v2 dashboard models failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/backtest/pairs/year")
def backtest_pairs_year(year: int = Query(..., ge=2000, le=2100), variant: str = Query("bollinger"),
                        slippage: float = Query(0.02, ge=0, le=1)):
    """The pairs traded in one year with their formation statistics and result."""
    _portfolio_check("pairs", variant, "fno")
    try:
        return {"status": "success", "pairs": pairs.pairs_year(variant, year, slippage / 100)}
    except Exception as error:
        print("Pairs year failed:", error)
        return {"status": "error", "message": str(error)}


gap_job = {"id": None}


@app.get("/api/gap/paper")
def gap_paper(slippage: float = Query(0.02, ge=0, le=1)):
    """Buy-on-gap paper trading: today's picks (live R), next session's watchlist and the log."""
    try:
        return {"status": "success", **gapwatch.paper(slippage / 100)}
    except Exception as error:
        print("Gap paper failed:", error)
        return {"status": "error", "message": str(error)}


@app.post("/api/gap/record")
def gap_record():
    """Record today's picks now (the scheduler does this at 09:15 in production), then close any due."""
    try:
        result = gapwatch.record_open()
        result["closed"] = gapwatch.finalize()
        return {"status": "success", **result}
    except Exception as error:
        print("Gap record failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/xsmr/paper")
def xsmr_paper(slippage: float = Query(0.02, ge=0, le=1), stop: bool = Query(False)):
    """Cross-sectional mean reversion paper trading: today's book, the daily log, the backtest reference."""
    try:
        return {"status": "success", **xsmrwatch.paper(slippage / 100, stop=stop)}
    except Exception as error:
        print("Cross-sectional paper failed:", error)
        return {"status": "error", "message": str(error)}


def _connors_book(book):
    if book not in connorswatch.BOOKS:
        raise HTTPException(status_code=400, detail="unknown book")
    return book


@app.get("/api/connors/paper/pnl")
def connors_paper_pnl(slippage: float = Query(0.02, ge=0, le=1), book: str = Query("rsi2")):
    """A short-term mean reversion book's open positions marked every 15 minutes since the earliest buy (stock prices, one lot each)."""
    _connors_book(book)
    try:
        data = connorswatch.paper(slippage / 100, book)
        rows = [{**t, "qty": t.get("stock_qty")} for t in data["open"]]
        return {"status": "success", "size": 1, **v2pnl.held_curve(rows, xsmr.cost_per_side(slippage / 100))}
    except Exception as error:
        print("Connors paper pnl failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/connors/paper/watchlist")
def connors_paper_watchlist(book: str = Query("rsi2")):
    """Today's short-term mean reversion candidates for a book, live (what 15:15 would buy if it were now)."""
    _connors_book(book)
    try:
        return {"status": "success", **connorswatch.watchlist(book)}
    except Exception as error:
        print("Connors watchlist failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/connors/paper/settings")
def connors_paper_settings(book: str = Query("rsi2")):
    """A book's live settings, read by the 15:15 run: universe and max open."""
    _connors_book(book)
    return {"status": "success", "universe": connorswatch.universe(book), "universes": list(connorswatch.UNIVERSES),
            "max_open": connorswatch.max_open(book), "max_open_limit": connorswatch.MAX_OPEN_LIMIT}


class ConnorsMaxOpenRequest(BaseModel):
    max_open: int


class ConnorsUniverseRequest(BaseModel):
    universe: str


@app.post("/api/connors/paper/universe")
def connors_paper_universe(req: ConnorsUniverseRequest, book: str = Query("rsi2")):
    """A book's universe for the 15:15 run (from the next run)."""
    _connors_book(book)
    try:
        return {"status": "success", "universe": connorswatch.set_universe(req.universe, book)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/connors/paper/max_open")
def connors_paper_max_open(req: ConnorsMaxOpenRequest, book: str = Query("rsi2")):
    """How many positions a book's 15:15 run may hold (from the next run)."""
    _connors_book(book)
    try:
        return {"status": "success", "max_open": connorswatch.set_max_open(req.max_open, book)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/api/connors/paper")
def connors_paper(slippage: float = Query(0.02, ge=0, le=1), book: str = Query("rsi2")):
    """A short-term mean reversion paper book: open positions, closed trades, days."""
    _connors_book(book)
    try:
        return {"status": "success", **connorswatch.paper(slippage / 100, book)}
    except Exception as error:
        print("Connors paper failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/xsmr/preopen")
def xsmr_preopen(slippage: float = Query(0.02, ge=0, le=1)):
    """Pre-open test: picks from the futures' 09:06 / 09:07 auction prices against the futures open."""
    try:
        return {"status": "success", **xsmrwatch.preopen(slippage / 100)}
    except Exception as error:
        print("Pre-open test failed:", error)
        return {"status": "error", "message": str(error)}


@app.post("/api/xsmr/record")
def xsmr_record():
    """Record today's book now (the scheduler does this at 09:15:01 in production), then close any due."""
    try:
        result = xsmrwatch.record_open()
        result["closed"] = xsmrwatch.finalize()
        return {"status": "success", **result}
    except Exception as error:
        print("Cross-sectional record failed:", error)
        return {"status": "error", "message": str(error)}


@app.post("/api/gap/refresh")
def gap_refresh():
    """Top up the F&O stocks' daily candles in the background (for the next session's levels)."""
    current = jobs.get(gap_job["id"]) if gap_job["id"] else None
    if current and current.get("status") == "running":
        return {"status": "success", "job_id": gap_job["id"]}
    job_id = uuid.uuid4().hex
    gap_job["id"] = job_id
    jobs[job_id] = {"status": "running", "done": 0, "total": 0, "symbol": ""}

    def run():
        try:
            result = gapwatch.refresh_daily(lambda state: jobs[job_id].update(state))
            jobs[job_id] = {"status": "completed", **result}
        except Exception as error:
            jobs[job_id] = {"status": "error", "message": str(error)}

    threading.Thread(target=run, daemon=True).start()
    return {"status": "success", "job_id": job_id}


@app.get("/api/gap/refresh")
def gap_refresh_status():
    job = jobs.get(gap_job["id"]) if gap_job["id"] else None
    return {"status": "success", "job": job}


@app.get("/api/eod/{job_id}")
def eod_status(job_id: str):
    job = jobs.get(job_id)
    if job is None:
        return {"status": "error", "message": "Download not found"}
    return job


class UtDataRequest(BaseModel):
    symbols: list[str]


@app.post("/api/ut-data")
def ut_data(body: UtDataRequest):
    job_id = uuid.uuid4().hex
    total = len(body.symbols)
    jobs[job_id] = {
        "status": "running",
        "done": 0,
        "total": total,
        "symbol": "",
        "candles": 0,
        "errors": [],
        "kind": "ut",
    }
    ws_hub.notify(
        {
            "type": "status",
            "level": "info",
            "message": f"UT data update started for {total} symbols",
            "job_id": job_id,
        }
    )

    def on_progress(state):
        state = {**state, "kind": "ut"}
        jobs[job_id] = state
        ws_hub.notify({"type": "ut_progress", "job_id": job_id, **state})
        if state.get("status") == "running" and state.get("symbol"):
            ws_hub.notify(
                {
                    "type": "status",
                    "level": "info",
                    "message": (
                        f"Updating UT data {state['done'] + 1}/{state['total']}: "
                        f"{state['symbol']}"
                    ),
                    "job_id": job_id,
                }
            )
        elif state.get("status") == "completed":
            failed = len(state.get("errors") or [])
            suffix = f" ({failed} failed)" if failed else ""
            ws_hub.notify(
                {
                    "type": "status",
                    "level": "success" if failed == 0 else "info",
                    "message": (
                        f"UT data update complete. Saved {state.get('candles', 0)} bars{suffix}"
                    ),
                    "job_id": job_id,
                }
            )

    def run():
        try:
            build_ut_data(body.symbols, on_progress)
        except Exception as error:
            print("Error building UT data:", error)
            state = {
                "status": "error",
                "message": str(error),
                "done": 0,
                "total": total,
                "symbol": "",
                "candles": 0,
                "errors": [],
                "kind": "ut",
            }
            jobs[job_id] = state
            ws_hub.notify({"type": "ut_progress", "job_id": job_id, **state})
            ws_hub.notify(
                {
                    "type": "status",
                    "level": "error",
                    "message": f"UT data update failed: {error}",
                    "job_id": job_id,
                }
            )

    threading.Thread(target=run, daemon=True).start()
    return {"status": "success", "job_id": job_id}


@app.get("/api/ut-data")
def ut_data_rows(exchange: str = Query(...), symbol: str = Query(...)):
    try:
        rows = fetch_ut_rows(exchange.upper(), symbol.upper())
    except Exception as error:
        print("Error fetching UT data:", error)
        return {"status": "error", "message": str(error), "data": []}

    return {"status": "success", "data": rows}


class KbdtScanRequest(BaseModel):
    symbols: list[str] | None = None
    history_bars: int = 40


@app.get("/api/kbdt/signals")
def kbdt_signals():
    try:
        rows = fetch_kbdt_signals()
    except Exception as error:
        print("Error fetching KBDT signals:", error)
        return {"status": "error", "message": str(error), "data": []}
    return {"status": "success", "data": rows}


@app.post("/api/kbdt/scan")
def kbdt_scan(body: KbdtScanRequest):
    job_id = uuid.uuid4().hex
    symbols = body.symbols or []
    total = len(symbols) if symbols else 0
    jobs[job_id] = {
        "status": "running",
        "done": 0,
        "total": total,
        "symbol": "",
        "signals": 0,
        "errors": [],
        "kind": "kbdt",
    }
    ws_hub.notify(
        {
            "type": "status",
            "level": "info",
            "message": "KBDT signal scan started",
            "job_id": job_id,
        }
    )

    def on_progress(state):
        state = {**state, "kind": "kbdt"}
        jobs[job_id] = state
        ws_hub.notify({"type": "kbdt_progress", "job_id": job_id, **state})
        if state.get("status") == "running" and state.get("symbol"):
            ws_hub.notify(
                {
                    "type": "status",
                    "level": "info",
                    "message": (
                        f"Scanning KBDT {state['done'] + 1}/{state['total']}: "
                        f"{state['symbol']}"
                    ),
                    "job_id": job_id,
                }
            )
        elif state.get("status") == "completed":
            failed = len(state.get("errors") or [])
            suffix = f" ({failed} failed)" if failed else ""
            ws_hub.notify(
                {
                    "type": "status",
                    "level": "success" if failed == 0 else "info",
                    "message": (
                        f"KBDT scan complete. {state.get('signals', 0)} signals{suffix}"
                    ),
                    "job_id": job_id,
                }
            )

    def run():
        try:
            scan_kbdt(
                symbols=body.symbols or None,
                history_bars=body.history_bars,
                on_progress=on_progress,
            )
        except Exception as error:
            print("Error scanning KBDT:", error)
            state = {
                "status": "error",
                "message": str(error),
                "done": 0,
                "total": total,
                "symbol": "",
                "signals": 0,
                "errors": [],
                "kind": "kbdt",
            }
            jobs[job_id] = state
            ws_hub.notify({"type": "kbdt_progress", "job_id": job_id, **state})
            ws_hub.notify(
                {
                    "type": "status",
                    "level": "error",
                    "message": f"KBDT scan failed: {error}",
                    "job_id": job_id,
                }
            )

    threading.Thread(target=run, daemon=True).start()
    return {"status": "success", "job_id": job_id}


if __name__ == "__main__":
    uvicorn.run("main:app", host="127.0.0.1", port=4001, reload=True)
