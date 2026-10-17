import asyncio
from typing import Any

_ws_clients: set = set()
_sse_queues: set[asyncio.Queue] = set()
_loop: asyncio.AbstractEventLoop | None = None


def set_loop(loop: asyncio.AbstractEventLoop):
    global _loop
    _loop = loop


async def register(client):
    _ws_clients.add(client)


async def unregister(client):
    _ws_clients.discard(client)


async def register_sse(queue: asyncio.Queue):
    _sse_queues.add(queue)


async def unregister_sse(queue: asyncio.Queue):
    _sse_queues.discard(queue)


async def _broadcast(message: dict[str, Any]):
    dead_ws = []
    for client in list(_ws_clients):
        try:
            await client.send_json(message)
        except Exception:
            dead_ws.append(client)
    for client in dead_ws:
        _ws_clients.discard(client)

    dead_sse = []
    for queue in list(_sse_queues):
        try:
            queue.put_nowait(message)
        except Exception:
            dead_sse.append(queue)
    for queue in dead_sse:
        _sse_queues.discard(queue)


def notify(message: dict[str, Any]):
    if _loop is None or not _loop.is_running():
        return
    asyncio.run_coroutine_threadsafe(_broadcast(message), _loop)


def client_counts():
    return {"websocket": len(_ws_clients), "sse": len(_sse_queues)}
