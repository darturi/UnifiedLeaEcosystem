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

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from lea.interface import check as interface_check, verify as interface_verify

from ..config import load_config
from .. import projects, store

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

    step = store.add_code_step(session_id, None, request.path, commit_sha=sha, author="user")
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
