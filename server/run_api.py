from __future__ import annotations

import sys

print("[startup] importing uvicorn", flush=True)
import uvicorn

print("[startup] importing app.main", flush=True)
from app.main import app

print("[startup] creating uvicorn config", flush=True)
config = uvicorn.Config(
    app,
    host="127.0.0.1",
    port=8000,
    loop="asyncio",
    http="h11",
    log_level="debug",
)

print("[startup] starting server", flush=True)
try:
    uvicorn.Server(config).run()
except Exception as exc:
    print(f"[startup] failed: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
    raise

