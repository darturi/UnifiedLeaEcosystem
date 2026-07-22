"""FastAPI app construction + wiring only (D2). Endpoints live in `routes/`,
split by resource; this module builds the app, registers the routers, and mounts
the bundled frontend last so every `/api/*` route takes priority."""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from .db import init_db
from .routes import projects, runs, search, sessions, settings, skills, subagents
from . import store

app = FastAPI(title="Lea Interface API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup() -> None:
    init_db()
    # No runner threads survive a restart, so any run row still marked active is
    # an orphan whose derived session status would read 'thinking' forever.
    store.fail_stale_active_runs()


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


app.include_router(sessions.router)
app.include_router(runs.router)
app.include_router(settings.router)
app.include_router(projects.router)
app.include_router(search.router)
app.include_router(skills.router)
app.include_router(subagents.router)


# --- Static frontend (bundled / single-container deploy) --------------------
# In dev, Vite (:5173) serves the UI and proxies /api here, so this is skipped
# (LEA_WEB_DIST is unset). In the Docker image LEA_WEB_DIST points at the built
# `dist/`; the adapter then serves it on :8001 with SPA fallback. Registered LAST,
# so every /api/* route above takes priority over this catch-all.
_WEB_DIST = os.environ.get("LEA_WEB_DIST")
if _WEB_DIST and Path(_WEB_DIST).is_dir():
    _web_root = Path(_WEB_DIST).resolve()

    @app.get("/{full_path:path}")
    async def serve_frontend(full_path: str):
        # API paths are handled by the routers above; never hand them index.html.
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")
        # Serve a real built asset when it exists and stays inside the dist root.
        candidate = (_web_root / full_path).resolve()
        if full_path and candidate.is_file() and candidate.is_relative_to(_web_root):
            return FileResponse(candidate)
        # Otherwise hand back index.html for the SPA / client-side routing.
        return FileResponse(_web_root / "index.html")
