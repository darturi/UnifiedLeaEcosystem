"""Run endpoints: start a run, stream its events (SSE), interrupt it, and answer
a per-tool approval. One run streams at a time (enforced in the bridge)."""

from __future__ import annotations

import asyncio
import json
from queue import Empty, Queue
from threading import Thread

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..config import load_config
from .. import bridge
from ..bridge import RunnerContext, run_lea, request_stop
from .. import projects
from .. import settings as settings_service
from .. import store

router = APIRouter()


class RunRequest(BaseModel):
    message: str
    session_id: str | None = None
    # Autonomous run (D19): when true the run uses no per-tool approval gate and the
    # non-interactive `default` prompt variant, so it formalizes end-to-end with zero
    # human interaction (the Overleaf path). Defaults false → the interactive UI
    # behavior (gated tools + collaborator prompt) is unchanged.
    autonomous: bool = False
    # Project namespace (the Overleaf document slug). When present, a new session is
    # tagged with a project of this slug (created on first use) so per-document usage
    # can be aggregated for the Overleaf popover's "This project" total. Absent for
    # the interactive UI path, which stays project-less.
    project_slug: str | None = None
    project_title: str | None = None
    # Session origin / providence. 'overleaf' (with `origin_url` = the canonical
    # Overleaf document URL) marks a formalization spawned from the Overleaf
    # extension, so the UI can show an origin indicator and open/focus the source
    # document. Omitted for the interactive UI path → the session defaults to 'ui'.
    # Independent of `project_slug` (usage namespacing) by design.
    origin: str | None = None
    origin_url: str | None = None


class ApprovalDecisionRequest(BaseModel):
    decision: str


def sse(event_type: str, payload: dict) -> str:
    return f"event: {event_type}\ndata: {json.dumps(payload)}\n\n"


@router.post("/api/runs")
def create_run(request: RunRequest) -> dict:
    message = request.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="Message is required")

    config = load_config()
    if settings_service.spend_limit_reached(config.max_spend_usd):
        raise HTTPException(status_code=402, detail="Max spend limit has been reached.")

    # Resolve the project namespace (Overleaf path) so the session + run are tagged
    # and per-document usage can be summed. Invalid slugs are ignored rather than
    # failing the run (best-effort association).
    project_id: str | None = None
    if request.project_slug:
        # Provision identically to a UI project (D25): get-or-create the row AND seed the
        # on-disk repo's .lea/{instructions,memory,blueprint}.md if missing, so an
        # Overleaf-originated project isn't left doc-less. Best-effort + idempotent.
        proofs_root = (config.lea_root / "workspace" / "proofs") if config.lea_root else None
        try:
            project = projects.ensure_project(
                request.project_slug, proofs_root, title=request.project_title
            )
            project_id = project["id"]
        except ValueError:
            project_id = None

    if request.session_id:
        session = store.get_session(request.session_id)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        # Backfill the project on an existing session that has none yet (e.g. the
        # first tagged run for a session created project-less).
        if project_id and not session.get("project_id"):
            store.assign_session_project(session["id"], project_id)
        # A UI project session (D23) already carries its project_id; tag the run with
        # it so usage rolls up per project even without an Overleaf slug.
        if project_id is None and session.get("project_id"):
            project_id = session["project_id"]
    else:
        session = store.create_session(
            message,
            project_id=project_id,
            origin=(request.origin or "ui"),
            origin_url=request.origin_url,
        )

    run = store.create_run(session["id"], config.model, None, config.max_turns,
                           project_id=project_id, autonomous=request.autonomous)
    user_message = store.add_message(session["id"], "user", message, run["id"])
    project = store.get_project(project_id) if project_id else None
    return {
        "session_id": session["id"],
        "run_id": run["id"],
        "message": user_message,
        "project_id": project_id,
        "project_slug": project["slug"] if project else None,
        "project_namespace": project["namespace"] if project else None,
    }


@router.post("/api/runs/{run_id}/approvals/{approval_id}")
def resolve_approval(run_id: str, approval_id: str, request: ApprovalDecisionRequest) -> dict:
    """Answer a per-tool approval (D19): the human's allow / deny / always_session
    decision for a gated tool call (bash / write_file / edit_file). The bridge
    `.send()`s it into the paused run. 409 if the approval is stale/unknown (the
    run already moved on, e.g. a Stop bailed it)."""
    if request.decision not in {"allow", "deny", "always_session"}:
        raise HTTPException(status_code=422, detail="decision must be 'allow', 'deny', or 'always_session'")
    if not bridge.resolve_approval(run_id, approval_id, request.decision):
        raise HTTPException(status_code=409, detail="No pending approval matches this run/approval id")
    return {"status": "resolved", "decision": request.decision}


@router.post("/api/runs/{run_id}/interrupt")
def interrupt_run(run_id: str) -> dict:
    """Request a clean cooperative stop (D18). The agent checks the flag at the
    next turn boundary and ends with a committed file + accurate canvas — not a
    hard kill. Idempotent: setting an already-set flag is a no-op."""
    run = store.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    if run["status"] not in {"pending", "running"}:
        raise HTTPException(status_code=409, detail="Run is not active")
    request_stop(run_id)
    return {"status": "interrupting"}


@router.get("/api/runs/{run_id}/events")
async def run_events(run_id: str) -> StreamingResponse:
    run = store.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    if run["status"] not in {"pending", "running"}:
        raise HTTPException(status_code=409, detail="Run has already completed")

    # A second connection for a run already being driven (e.g. the lea-standalone
    # UI opening an Overleaf run the companion is driving) must NOT spawn a second
    # runner — that competitor loses the single-run lock and emits run_error +
    # done(failed), which the UI's reconcile→reattach cycle turns into a request
    # storm. Instead, attach as a passive viewer: tail the run's status and emit a
    # single terminal `done` once it actually finishes. The run keeps making
    # progress under its real driver; this connection just observes.
    active_run_id = bridge.current_active_run_id()
    if active_run_id is not None and active_run_id != run_id:
        # A different run holds the single-run slot. Reject up front (409) instead
        # of spawning a runner that loses the lock and emits done(failed) — the
        # latter drives the UI's reconcile→reattach loop into a request storm.
        raise HTTPException(status_code=409, detail="Another Lea run is already active.")

    if active_run_id == run_id:
        async def passive_view():
            # Cap the wait so a wedged run can't hold the connection forever; the
            # browser EventSource simply reconnects (and re-tails) if we time out.
            for _ in range(36000):  # ~3h at 0.3s/iter
                current = store.get_run(run_id)
                if not current:
                    yield sse("done", {"status": "failed"})
                    return
                if current["status"] not in {"pending", "running"}:
                    yield sse("done", {"status": current["status"]})
                    return
                await asyncio.sleep(0.3)
            yield sse("done", {"status": "running"})

        return StreamingResponse(passive_view(), media_type="text/event-stream")

    queue: Queue[dict] = Queue()
    session = store.session_detail(run["session_id"])
    if not session or not session["messages"]:
        raise HTTPException(status_code=404, detail="Run task not found")

    task = next(
        (m["content"] for m in reversed(session["messages"])
         if m["run_id"] == run_id and m["role"] == "user"),
        None,
    )
    if not task:
        raise HTTPException(status_code=404, detail="Run task not found")

    context = RunnerContext(
        session_id=run["session_id"],
        run_id=run_id,
        task=task,
        config=load_config(),
        events=queue,
        autonomous=bool(run.get("autonomous")),
    )
    thread = Thread(target=run_lea, args=(context,), daemon=True)
    thread.start()

    async def stream_events():
        while True:
            try:
                item = queue.get_nowait()
            except Empty:
                if not thread.is_alive():
                    break
                await asyncio.sleep(0.1)
                continue
            yield sse(item["type"], item["payload"])
            if item["type"] == "done":
                break

    return StreamingResponse(stream_events(), media_type="text/event-stream")
