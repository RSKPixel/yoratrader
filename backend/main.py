from datetime import date as _date
import asyncio
import json
import os
import threading
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
import connors
import vbo
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
        gapwatch.start_scheduler()


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


class NameRequest(BaseModel):
    display_name: str = ""


class PasswordRequest(BaseModel):
    current_password: str
    new_password: str


@app.post("/api/auth/login")
def auth_login(req: LoginRequest, response: Response):
    try:
        token = auth.login(req.username, req.password)
    except auth.LoginLocked as exc:
        raise HTTPException(status_code=429, detail=str(exc))
    if not token:
        if auth.user_count() == 0:
            raise HTTPException(status_code=401, detail="No user set up yet. Run backend/manage_user.py on the server.")
        raise HTTPException(status_code=401, detail="Incorrect user ID or password.")
    response.set_cookie(value=token, max_age=auth.SESSION_DAYS * 86400, **auth.cookie_kwargs())
    return {"user": auth.session_user(token)}


@app.post("/api/auth/logout")
def auth_logout(request: Request, response: Response):
    auth.logout(request.cookies.get(auth.COOKIE_NAME))
    response.delete_cookie(**auth.cookie_kwargs())
    return {"ok": True}


@app.get("/api/auth/me")
def auth_me(request: Request):
    return {"user": request.state.user}


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


class EodRequest(BaseModel):
    symbols: list[str]


@app.post("/api/eod")
def eod(body: EodRequest):
    job_id = uuid.uuid4().hex
    total = len(body.symbols)
    jobs[job_id] = {
        "status": "running",
        "done": 0,
        "total": total,
        "symbol": "",
        "candles": 0,
        "errors": [],
    }
    ws_hub.notify(
        {
            "type": "status",
            "level": "info",
            "message": f"EOD download started for {total} symbols",
            "job_id": job_id,
        }
    )

    def on_progress(state):
        jobs[job_id] = state
        ws_hub.notify({"type": "eod_progress", "job_id": job_id, **state})
        if state.get("status") == "running" and state.get("symbol"):
            ws_hub.notify(
                {
                    "type": "status",
                    "level": "info",
                    "message": (
                        f"Downloading EOD {state['done'] + 1}/{state['total']}: "
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
                        f"EOD download complete. Saved {state.get('candles', 0)} candles{suffix}"
                    ),
                    "job_id": job_id,
                }
            )

    def run():
        try:
            download_eod(body.symbols, on_progress)
        except Exception as error:
            print("Error downloading EOD:", error)
            state = {
                "status": "error",
                "message": str(error),
                "done": 0,
                "total": total,
                "symbol": "",
                "candles": 0,
                "errors": [],
            }
            jobs[job_id] = state
            ws_hub.notify({"type": "eod_progress", "job_id": job_id, **state})
            ws_hub.notify(
                {
                    "type": "status",
                    "level": "error",
                    "message": f"EOD download failed: {error}",
                    "job_id": job_id,
                }
            )

    threading.Thread(target=run, daemon=True).start()
    return {"status": "success", "job_id": job_id}


@app.post("/api/idata")
def idata(body: EodRequest):
    job_id = uuid.uuid4().hex
    total = len(body.symbols)
    jobs[job_id] = {"status": "running", "done": 0, "total": total, "symbol": "", "candles": 0, "errors": []}
    ws_hub.notify(
        {"type": "status", "level": "info", "message": f"iData (15m) download started for {total} symbols", "job_id": job_id}
    )

    def on_progress(state):
        jobs[job_id] = state
        ws_hub.notify({"type": "idata_progress", "job_id": job_id, **state})
        if state.get("status") == "running" and state.get("symbol"):
            message = f"Downloading iData {state['done'] + 1}/{state['total']}: {state['symbol']}"
            ws_hub.notify({"type": "status", "level": "info", "message": message, "job_id": job_id})
        elif state.get("status") == "completed":
            failed = len(state.get("errors") or [])
            suffix = f" ({failed} failed)" if failed else ""
            ws_hub.notify(
                {
                    "type": "status",
                    "level": "success" if failed == 0 else "info",
                    "message": f"iData download complete. Saved {state.get('candles', 0)} 15m candles{suffix}",
                    "job_id": job_id,
                }
            )

    def run():
        try:
            download_intraday(body.symbols, on_progress)
        except Exception as error:
            print("Error downloading iData:", error)
            state = {"status": "error", "message": str(error), "done": 0, "total": total, "symbol": "", "candles": 0, "errors": []}
            jobs[job_id] = state
            ws_hub.notify({"type": "idata_progress", "job_id": job_id, **state})
            ws_hub.notify({"type": "status", "level": "error", "message": f"iData download failed: {error}", "job_id": job_id})

    threading.Thread(target=run, daemon=True).start()
    return {"status": "success", "job_id": job_id}


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


PORTFOLIO_MODELS = {"xsmr": xsmr, "pairs": pairs, "xsmom": xsmom, "qmom": qmom, "connors": connors, "vbo": vbo}


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
        if model in ("xsmom", "qmom", "connors", "vbo"):
            extra = {"variant": variant} if model in ("connors", "vbo") else {}
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
        if model in ("xsmom", "qmom", "connors", "vbo"):
            return {"status": "success", "days": module.month_days(variant, dataset, month, slippage / 100, lots=lots)}
        return {"status": "success", "days": xsmr.month_days(variant, dataset, month, slippage / 100, lots=lots)}
    except Exception as error:
        print("Portfolio month failed:", error)
        return {"status": "error", "message": str(error)}


@app.get("/api/backtest/portfolio/day")
def backtest_portfolio_day(day: str = Query(..., pattern=r"^\d{4}-\d{2}-\d{2}$"), variant: str = Query("intraday-0915"),
                           dataset: str = Query("fno"), model: str = Query("xsmr")):
    """Every stock position of a cross-sectional book (mean reversion or momentum) on one day."""
    if model not in ("xsmr", "xsmom", "qmom", "connors", "vbo"):
        raise HTTPException(status_code=400, detail="unknown model")
    module, _ = _portfolio_check(model, variant, dataset)
    try:
        return {"status": "success", "trades": module.day_trades(variant, dataset, _date.fromisoformat(day))}
    except Exception as error:
        print("Portfolio day failed:", error)
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


@app.get("/api/connors/paper")
def connors_paper(slippage: float = Query(0.02, ge=0, le=1)):
    """Short-term mean reversion paper trading: open positions, closed trades, days."""
    try:
        return {"status": "success", **connorswatch.paper(slippage / 100)}
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
