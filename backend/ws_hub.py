import asyncio
from typing import Any

_clients: set = set()
_loop: asyncio.AbstractEventLoop | None = None


def set_loop(loop: asyncio.AbstractEventLoop):
    global _loop
    _loop = loop


async def register(client):
    _clients.add(client)


async def unregister(client):
    _clients.discard(client)


async def _broadcast(message: dict[str, Any]):
    dead = []
    for client in list(_clients):
        try:
            await client.send_json(message)
        except Exception:
            dead.append(client)
    for client in dead:
        _clients.discard(client)


def notify(message: dict[str, Any]):
    if _loop is None or not _loop.is_running():
        return
    asyncio.run_coroutine_threadsafe(_broadcast(message), _loop)
