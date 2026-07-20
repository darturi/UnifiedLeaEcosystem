"""Session + stats endpoints.

The canvas read path used to live here: the DB stored each code_step as a git
*pointer* (commit_sha + path), so on reload the route **hydrated** every step by
shelling out to `git show <sha>:<path>`. As of v2.3 SQL owns the content (C1/D7
inverted) and `store.session_detail` returns each step's bytes directly, so there
is no hydrate step and no composition over a second store — a read that can't
half-succeed. A failed hydrate used to degrade to `code: ""`, i.e. a proof
silently rendering as an empty canvas.
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

from lea.interface import check as interface_check, rebuild as interface_rebuild, verify as interface_verify

from ..artifacts import classify_lean_artifact
from ..config import load_config
from .. import filesystem as fs_service, lsp_proxy, projects, store

router = APIRouter()
logger = logging.getLogger("lea-interface.sessions")


class PathRequest(BaseModel):
    # which file in the session to act on; defaults to the latest code_step's path
    path: str | None = None
    # Optional: attribute this check as its own new code_step instead of
    # back-filling the existing latest one. Used by the Overleaf lean pane's
    # cascade re-verification (docs/FEATURE-overleaf-lean-pane-manual-edit.md):
    # when a manual edit to one declaration may have broken another target
    # that imports it, the companion re-checks the *unchanged* dependent file
    # and wants that verdict recorded as its own timeline entry -- 'cascade',
    # a third convention value alongside code_steps.author's existing
    # 'agent' | 'user' (D9, apps/lea-standalone/design/v2-architecture.md).
    # Omitted (the default) preserves the original back-fill-only behavior
    # exactly, so the standalone UI's existing calls are unaffected.
    author: str | None = None
    summary: str | None = None


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
    return detail


@router.post("/api/sessions/{session_id}/file")
def write_file_session(session_id: str, request: FileWriteRequest) -> dict:
    """Write the canvas (a human edit) to the session's working copy and commit it
    as a first-class run-less step (P2 / D9). The edit lands on disk
    (filesystem-canonical, D3), is committed `author=user`, and becomes a
    code_step with `run_id=NULL`. An optional `note` rides as a linked `edit_note`
    message (D11). A no-op save (no actual change) creates no step.

    The edit is stored, not committed: the step holds the file's bytes (D7 inverted,
    v2.3)."""
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

    # A no-op save (auto-save fires on a debounce, not on a change) creates no step.
    # This used to ask git whether the commit moved HEAD; now it compares the bytes
    # directly against the stored step — the same question, without a second store
    # having to agree. `before` is the stored content, not the file on disk: the disk
    # is about to be overwritten either way, and the step is what history shows.
    latest = store.latest_code_step_for_path(session_id, request.path)
    if latest and not latest.get("content_lost") and latest["code"] == request.content:
        return {"unchanged": True, "code_step": None, "note": None}

    abs_path.parent.mkdir(parents=True, exist_ok=True)
    abs_path.write_text(request.content)

    # Coalesce rapid auto-saves into one 'your edit' timeline step (D62) — see
    # store.upsert_user_code_step.
    step = store.upsert_user_code_step(session_id, request.path, content=request.content)
    # A human edit changes the proof, so any prior SafeVerify verdict is stale.
    store.set_session_safe_verify(session_id, None, None)
    note_message = None
    if request.note and request.note.strip():
        note_message = store.add_message(
            session_id, "user", request.note.strip(), None, kind="edit_note",
        )
    return {"unchanged": False, "code_step": step, "note": note_message}


@router.post("/api/sessions/{session_id}/lean-check")
def lean_check_session(session_id: str, request: PathRequest) -> dict:
    """Standalone `lean_check` on a session's working file (LSP fast path, no run,
    D2). Back-fills the verdict onto that file's latest code_step so the canvas +
    derived session status reflect it.

    When `request.author` is set (e.g. `"cascade"`), the verdict is recorded as
    a *new* code_step instead of back-filling the latest one -- the file on
    disk hasn't changed, so the new step holds the same content as the latest
    step (one blob, by content address); it exists to give the re-check its own
    timeline entry
    (who/why/when), not new content. See the `PathRequest.author` docstring.

    A `"cascade"` check always runs immediately after a `POST .../rebuild` of
    some *other* module in the project (the Overleaf lean pane's manual-edit
    flow, docs/FEATURE-overleaf-lean-pane-manual-edit.md, "Cascade
    verification"). It deliberately still goes through the normal (warm) path
    here, NOT `interface_check(..., cold=True)`: a live end-to-end test found
    the cold subprocess path (`tools.lean_check_cold`, `lake env lean <file>`
    one-shot) did NOT reliably see a just-rebuilt project-local module's fresh
    `.olean` either -- a real Lean/Lake quirk still under investigation, not
    something to build correctness on. Trusting the warm path here instead
    works, and was confirmed by that same test: `rebuild_session_module`
    (below) calls `lsp_daemon.mark_stale` on every successful build, which
    runs strictly before this call in the cascade's own request order, so the
    daemon has already restarted (discarding whatever it had cached for the
    rebuilt module) by the time this check reaches it.
    """
    abs_path, rel = _resolve_proof_path(session_id, request.path)
    result = interface_check(abs_path)
    artifact_kind = classify_lean_artifact(Path(abs_path).read_text()) if result.status == "ok" else None
    step = store.latest_code_step_for_path(session_id, rel)
    if request.author and step:
        new_step = store.add_code_step(
            session_id,
            None,
            rel,
            # The file is unchanged, so this is the same content — and because blobs
            # are content-addressed, the re-check's step shares the existing blob
            # rather than duplicating the proof.
            content=step["code"],
            author=request.author,
            summary=request.summary,
            check_status=result.status,
            check_detail=result.detail,
            artifact_kind=artifact_kind,
        )
        return {"path": rel, "status": result.status, "detail": result.detail, "code_step": new_step}
    if step:
        store.set_code_step_check(step["id"], result.status, result.detail, artifact_kind=artifact_kind)
    return {"path": rel, "status": result.status, "detail": result.detail}


@router.post("/api/sessions/{session_id}/rebuild")
def rebuild_session_module(session_id: str, request: PathRequest) -> dict:
    """Force a real `lake build` of a session's working file's module (D2-adjacent
    standalone capability, no agent run), so any *other* session's file that
    `import`s it resolves against a fresh `.olean` instead of a stale one.

    Why this exists: `lean-check` above (and `check_via_lsp`/`lea/lsp_daemon.py`
    it delegates to) is fast precisely because it never touches this file's
    compiled `.olean` -- fine when a session is only ever checking its own file,
    but a project-mate session's `lean-check` of a *dependent* file silently
    resolves its `import` against whatever `.olean` was last built, indefinitely,
    no matter how many times either file is rechecked. The Overleaf lean pane's
    manual-edit cascade (docs/FEATURE-overleaf-lean-pane-manual-edit.md, "Cascade
    verification") calls this once per edited module, before re-checking any of
    its dependents, so a dependent's "still valid" is never a caching artifact.
    """
    abs_path, rel = _resolve_proof_path(session_id, request.path)
    try:
        result = interface_rebuild(abs_path)
    except Exception as exc:  # noqa: BLE001 -- an unexpected failure here must
        # surface as "can't verify" (the companion's cascade already treats a
        # non-2xx/non-"ok" response this way), never as a raw 500 that leaves
        # the caller unable to distinguish "the module doesn't compile" from
        # "the rebuild itself crashed." Whatever this is, it's genuinely a
        # verdict of "unknown," not silent success.
        logger.exception("rebuild failed unexpectedly for session=%s path=%s", session_id, abs_path)
        return {"path": rel, "status": "error", "detail": f"rebuild crashed: {exc}"}
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


