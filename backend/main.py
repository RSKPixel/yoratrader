import asyncio
import json
import os
import threading
import uuid

import uvicorn
from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, RedirectResponse, StreamingResponse
from pydantic import BaseModel

from contracts import list_contracts
from db import fetch_candles, fetch_kbdt_signals, fetch_ut_rows, ut_bar_counts
from eod import download_eod
from kbdt_scan import scan_kbdt
from ut_data import build_ut_data
import kite_auth
import ws_hub

jobs = {}

app = FastAPI(title="YoraTrader")


@app.on_event("startup")
async def startup():
    ws_hub.set_loop(asyncio.get_running_loop())


def _cors_origins():
    raw = os.environ.get(
        "CORS_ORIGINS",
        "http://127.0.0.1:5180,http://localhost:5180,http://127.0.0.1:8007,http://localhost:8007",
    )
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


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
):
    try:
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
    uvicorn.run("main:app", host="127.0.0.1", port=8091, reload=True)
