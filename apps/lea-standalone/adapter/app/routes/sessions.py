"""Session + stats endpoints.

`session_detail` is also where the canvas read path lives: the DB stores each
code_step as a git *pointer* (commit_sha + path; git owns the content, C1/D7), so
on reload we **hydrate** every step with its proof text via `GitStore.snapshot`
(`git show <sha>:<path>`). The live SSE stream attaches `code` as steps happen;
this gives a reopened session the same content. The store stays git-free — the
route is the composition layer over DB + git.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from lea.interface import check as interface_check, verify as interface_verify

from ..config import load_config
from .. import filesystem as fs_service, lsp_proxy, projects, store

router = APIRouter()
logger = logging.getLogger("lea-interface.sessions")


class PathRequest(BaseModel):
    # which file in the session to act on; defaults to the latest code_step's path
    path: str | None = None


class FileWriteRequest(BaseModel):
    path: str
    content: str
    note: str | None = None  # optional explanation of the edit (D11)


@router.get("/api/sessions")
def list_sessions() -> dict:
    return {"sessions": store.list_sessions()}


# How often the sessions feed re-checks the digest, and how long one connection
# lives before the browser EventSource transparently reconnects (~3h).
_SESSIONS_POLL_SECONDS = 1.0
_SESSIONS_MAX_TICKS = 10800


@router.get("/api/sessions/events")
async def session_list_events() -> StreamingResponse:
    """SSE feed that fires `sessions_changed` whenever the session list changes —
    a session is created/touched or a run enters/leaves the active set. The UI
    subscribes once and re-fetches `/api/sessions` on each event, so a run started
    from anywhere (including an Overleaf-driven formalization, which the companion
    creates via this adapter's own `POST /api/runs`) appears live without a manual
    refresh.

    Implemented as a capped digest poll (the same passive-observer shape as
    `/api/runs/{id}/events`): the cheap `store.sessions_digest()` runs each tick and
    the expensive list query only re-runs client-side when the digest actually
    moves. One long-lived connection per client instead of the UI polling the full
    list on a timer."""

    async def stream():
        last_digest: str | None = None
        for _ in range(_SESSIONS_MAX_TICKS):
            try:
                digest = store.sessions_digest()
            except Exception:  # pragma: no cover - defensive; never wedge the stream
                logger.exception("sessions_digest failed")
                digest = last_digest
            if digest != last_digest:
                last_digest = digest
                yield f"event: sessions_changed\ndata: {json.dumps({})}\n\n"
            else:
                # Comment line doubles as a keep-alive so idle connections (and any
                # proxy in between) don't time out between real changes.
                yield ": keep-alive\n\n"
            await asyncio.sleep(_SESSIONS_POLL_SECONDS)

    return StreamingResponse(stream(), media_type="text/event-stream")


@router.get("/api/stats")
def stats() -> dict:
    return store.usage_stats()


@router.get("/api/sessions/{session_id}")
def session_detail(session_id: str) -> dict:
    detail = store.session_detail(session_id)
    if not detail:
        raise HTTPException(status_code=404, detail="Session not found")
    _hydrate_code(session_id, detail.get("code_steps") or [])
    return detail


@router.post("/api/sessions/{session_id}/file")
def write_file_session(session_id: str, request: FileWriteRequest) -> dict:
    """Write the canvas (a human edit) to the session's working copy and commit it
    as a first-class run-less step (P2 / D9). The edit lands on disk
    (filesystem-canonical, D3), is committed `author=user`, and becomes a
    code_step with `run_id=NULL`. An optional `note` rides as a linked `edit_note`
    message (D11). A no-op save (no actual change) creates no step."""
    config = load_config()
    if config.lea_root is None:
        raise HTTPException(status_code=422, detail="lea_root is not configured")
    if not request.path:
        raise HTTPException(status_code=400, detail="path is required")

    # Modal lock (D62): the agent and the human never write the same file at once.
    # The live editor already goes read-only during a run; this is the server-side
    # backstop so a stray/racing write is refused rather than clobbering agent state.
    if store.has_active_run(session_id):
        raise HTTPException(status_code=409, detail="A run is active — editing is locked until it finishes.")

    resolved = projects.resolve_git(session_id, config.lea_root / "workspace" / "proofs")
    if resolved is None:
        raise HTTPException(status_code=404, detail="Session not found")
    gs, repo_key = resolved  # D24: project session → the shared repo; loose → its own
    repo = gs.init_session(repo_key)
    abs_path = (repo / request.path).resolve()
    try:
        abs_path.relative_to(repo.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="path escapes the session directory") from exc

    before = gs.head(repo_key)
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    abs_path.write_text(request.content)
    sha = gs.commit_write(repo_key, turn=None, author="user", tool="edit")
    if sha == before:
        return {"unchanged": True, "code_step": None, "note": None}

    # Coalesce rapid auto-saves into one 'your edit' timeline step (D62) — see
    # store.upsert_user_code_step. Git still records every commit.
    step = store.upsert_user_code_step(session_id, request.path, commit_sha=sha)
    # A human edit changes the proof, so any prior SafeVerify verdict is stale.
    store.set_session_safe_verify(session_id, None, None)
    note_message = None
    if request.note and request.note.strip():
        note_message = store.add_message(
            session_id, "user", request.note.strip(), None, kind="edit_note", commit_sha=sha,
        )
    return {"unchanged": False, "code_step": {**step, "code": request.content}, "note": note_message}


@router.post("/api/sessions/{session_id}/lean-check")
def lean_check_session(session_id: str, request: PathRequest) -> dict:
    """Standalone `lean_check` on a session's working file (LSP fast path, no run,
    D2). Back-fills the verdict onto that file's latest code_step so the canvas +
    derived session status reflect it."""
    abs_path, rel = _resolve_proof_path(session_id, request.path)
    result = interface_check(abs_path)
    step = store.latest_code_step_for_path(session_id, rel)
    if step:
        store.set_code_step_check(step["id"], result.status, result.detail)
    return {"path": rel, "status": result.status, "detail": result.detail}


@router.post("/api/sessions/{session_id}/verify")
def verify_session(session_id: str, request: PathRequest) -> dict:
    """Standalone SafeVerify on a session's working file (kernel replay + axiom
    audit, no run, D2). status: ok | rejected | error | unavailable."""
    abs_path, rel = _resolve_proof_path(session_id, request.path)
    result = interface_verify(abs_path)
    # Persist the verdict so it survives reload (surfaced as session_detail.safe_verify).
    store.set_session_safe_verify(session_id, result.status, result.detail)
    return {"path": rel, "status": result.status, "detail": result.detail}


@router.get("/api/sessions/{session_id}/lsp-info")
def lsp_info(session_id: str) -> dict:
    """What the live editor (v2.2) needs to open a file: `fileName` is the proof's
    path **relative to the Lake root** — the URI the browser opens the Monaco model
    as, so the WS proxy's `file://`-prefix rewrite (D60/D64) lands it on the real
    file — plus the current on-disk `content` (the read-only Phase-1 buffer)."""
    abs_path, rel = _resolve_proof_path(session_id, None)
    try:
        lake_root, file_name = lsp_proxy.resolve_target(abs_path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    try:
        content = Path(abs_path).read_text()
    except OSError:
        content = ""
    return {"fileName": file_name, "content": content, "path": rel}


@router.websocket("/api/sessions/{session_id}/lsp")
async def lsp_socket(websocket: WebSocket, session_id: str) -> None:
    """Bridge the browser's Monaco/Lean LSP to a per-connection `lake serve`
    (v2.2 · D60/D61). Bare JSON per WS frame ⇄ Content-Length-framed stdio, with
    `file://` URI rewriting between the browser's virtual path and the real file.
    The process is spawned on connect and killed on disconnect (idle-reap)."""
    await websocket.accept()
    try:
        abs_path, _ = _resolve_proof_path(session_id, None)
        lake_root, _file_name = lsp_proxy.resolve_target(abs_path)
    except HTTPException as exc:
        await websocket.close(code=1011, reason=str(exc.detail)[:120])
        return
    except FileNotFoundError as exc:
        await websocket.close(code=1011, reason=str(exc)[:120])
        return

    proxy = lsp_proxy.LspProxy(lake_root, str(lake_root))
    try:
        await proxy.start()
    except FileNotFoundError:
        await websocket.close(code=1011, reason="lake not found on PATH")
        return
    try:
        await proxy.pump(websocket)
    except WebSocketDisconnect:
        await proxy.stop()


@router.get("/api/sessions/{session_id}/export")
def export_session(session_id: str) -> Response:
    """Stream a zip of a session's files (#14). A loose session has its own repo
    (``proofs/<session-id>``) with no other download path — this fills that gap,
    reusing the project export's zip plumbing (source + ``.lea`` assets; ``.git``/
    ``.lake`` excluded). A project session resolves to its shared project repo (the
    project's own Export is the primary path; this stays consistent). 404 if the
    session is unknown or has written no files yet."""
    session = store.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    config = load_config()
    if config.lea_root is None:
        raise HTTPException(status_code=422, detail="lea_root is not configured")
    proofs_root = config.lea_root / "workspace" / "proofs"
    project = store.get_project(session["project_id"]) if session.get("project_id") else None
    repo = projects.repo_for_session(session, proofs_root, project)
    if not repo.exists():
        raise HTTPException(status_code=404, detail="This session has no files to download yet.")
    data = fs_service.export_zip(repo)
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{_session_zip_name(session)}"'},
    )


def _session_zip_name(session: dict) -> str:
    """A friendly zip filename from the session title, e.g. 'Prove √2 irrational' →
    'prove-2-irrational.zip'. Falls back to the session id when the title is empty
    or slugifies to nothing."""
    slug = re.sub(r"[^a-z0-9]+", "-", (session.get("title") or "").lower()).strip("-")[:60]
    return f"{slug or 'session-' + str(session['id'])[:8]}.zip"


def _resolve_proof_path(session_id: str, path: str | None) -> tuple[str, str]:
    """(absolute on-disk path, repo-relative path) for the file to check/verify.

    Defaults to the session's latest code_step path. Filesystem-canonical (D3): the
    on-disk file is what the agent, the user, and lean_check/SafeVerify all touch."""
    config = load_config()
    if config.lea_root is None:
        raise HTTPException(status_code=422, detail="lea_root is not configured")
    rel = path or _latest_proof_path(session_id)
    if not rel:
        raise HTTPException(status_code=404, detail="No proof file in this session yet")
    resolved = projects.resolve_git(session_id, config.lea_root / "workspace" / "proofs")
    if resolved is None:
        raise HTTPException(status_code=404, detail="Session not found")
    gs, repo_key = resolved
    repo = gs.session_repo(repo_key)
    return str(repo / rel), rel


def _latest_proof_path(session_id: str) -> str | None:
    detail = store.session_detail(session_id)
    steps = (detail or {}).get("code_steps") or []
    return steps[-1]["path"] if steps else None


def _hydrate_code(session_id: str, code_steps: list[dict]) -> None:
    """Fill each pointer-only code_step with its content from git (in place)."""
    config = load_config()
    lea_root = config.lea_root
    if lea_root is None:
        return
    resolved = projects.resolve_git(session_id, lea_root / "workspace" / "proofs")
    if resolved is None:
        return
    gs, repo_key = resolved
    for step in code_steps:
        sha, path = step.get("commit_sha"), step.get("path")
        if not sha or not path:
            step["code"] = ""
            continue
        try:
            step["code"] = gs.snapshot(repo_key, sha, path)
        except Exception:  # noqa: BLE001 — a missing repo/blob shouldn't 500 the read
            logger.debug("Could not hydrate code for %s @ %s:%s", session_id, sha, path, exc_info=True)
            step["code"] = ""
