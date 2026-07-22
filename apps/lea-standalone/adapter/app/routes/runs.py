"""Run endpoints: enqueue, observe over SSE, interrupt, and approve tools.

POST enqueues into the bridge's capacity-aware FIFO dispatcher. GET /events is
a pure observer: pending runs announce their queue position, live runs replay
and tail their rejoinable broker, and terminal runs synthesize ``done`` when the
in-memory broker has already been retired.
"""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..config import load_config, permission_tier
from .. import bridge
from ..bridge import request_stop
from .. import projects
from .. import runbroker
from .. import runregistry
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
    project_namespace: str | None = None
    # Session origin / providence. 'overleaf' (with `origin_url` = the canonical
    # Overleaf document URL) marks a formalization spawned from the Overleaf
    # extension, so the UI can show an origin indicator and open/focus the source
    # document. Omitted for the interactive UI path → the session defaults to 'ui'.
    # Independent of `project_slug` (usage namespacing) by design.
    origin: str | None = None
    origin_url: str | None = None


class ApprovalDecisionRequest(BaseModel):
    decision: str


def sse(event_type: str, payload: dict, seq: int | None = None) -> str:
    # A monotonic `id:` lets the browser's native EventSource reconnect resume via
    # `Last-Event-ID` (no re-replay). Manual reattach omits it and replays from 0.
    prefix = f"id: {seq}\n" if seq is not None else ""
    return f"{prefix}event: {event_type}\ndata: {json.dumps(payload)}\n\n"


def _request_cursor(request: Request) -> int:
    """Where to resume the broker stream from.

    Native EventSource reconnects send ``Last-Event-ID``; manual reattach may
    pass ``?since=N``. Otherwise replay the broker from its first event.
    """
    last = request.headers.get("last-event-id")
    if last and last.isdigit():
        return int(last)
    since = request.query_params.get("since")
    return int(since) if since and since.isdigit() else 0


def _done_payload(run: dict) -> dict:
    payload = {"status": run["status"]}
    if run.get("result_kind"):
        payload["result_kind"] = run["result_kind"]
    if run.get("result_detail"):
        payload["result_detail"] = run["result_detail"]
    return payload


async def _subscribe(broker: runbroker.RunBroker, cursor: int):
    """Replay after ``cursor`` and follow a live broker through ``done``."""
    while True:
        pending = broker.events_after(cursor)
        for event in pending:
            cursor = event["seq"]
            yield sse(event["type"], event["payload"], seq=event["seq"])
            if event["type"] == "done":
                return
        if broker.closed and not broker.events_after(cursor):
            return
        await asyncio.sleep(0.08)


async def _passive_done(run_id: str):
    """Settle an observer when the broker was retired just before attachment."""
    for _ in range(36000):  # ~3h at 0.3s/iter; the client may reconnect sooner
        current = store.get_run(run_id)
        if not current:
            yield sse("done", {"status": "failed"})
            return
        if current["status"] not in {"pending", "running"}:
            yield sse("done", _done_payload(current))
            return
        await asyncio.sleep(0.3)
    yield sse("done", {"status": "running"})


@router.post("/api/runs")
def create_run(request: RunRequest) -> dict:
    message = request.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="Message is required")

    config = load_config()
    if settings_service.spend_limit_reached(config.max_spend_usd):
        raise HTTPException(status_code=402, detail="Max spend limit has been reached.")

    project_id: str | None = None
    if request.project_slug:
        proofs_root = (config.lea_root / "workspace" / "proofs") if config.lea_root else None
        try:
            project = projects.ensure_project(
                request.project_slug,
                proofs_root,
                title=request.project_title,
                namespace=request.project_namespace,
            )
            project_id = project["id"]
        except ValueError:
            project_id = None

    if request.session_id:
        session = store.get_session(request.session_id)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        if project_id and not session.get("project_id"):
            store.assign_session_project(session["id"], project_id)
        if project_id is None and session.get("project_id"):
            project_id = session["project_id"]
    else:
        session = store.create_session(
            message,
            project_id=project_id,
            origin=(request.origin or "ui"),
            origin_url=request.origin_url,
        )

    autonomous = request.autonomous or (permission_tier() == "none")
    run = store.create_run(
        session["id"], config.model, None, config.max_turns,
        project_id=project_id, autonomous=autonomous,
    )
    user_message = store.add_message(session["id"], "user", message, run["id"])
    bridge.enqueue_run(run["id"])
    project = store.get_project(project_id) if project_id else None
    return {
        "session_id": session["id"],
        "run_id": run["id"],
        "message": user_message,
        "project_id": project_id,
        "project_slug": project["slug"] if project else None,
        "project_namespace": project["namespace"] if project else None,
        "queue_position": store.queue_position(run["id"]),
    }


@router.get("/api/runs/{run_id}")
def get_run_row(run_id: str) -> dict:
    """Return the cheap lifecycle/result columns used by reconnect polling."""
    row = store.get_run_status(run_id)
    if not row:
        raise HTTPException(status_code=404, detail="Run not found")
    return row


@router.post("/api/runs/{run_id}/approvals/{approval_id}")
def resolve_approval(run_id: str, approval_id: str, request: ApprovalDecisionRequest) -> dict:
    if request.decision not in {"allow", "deny", "always_session"}:
        raise HTTPException(
            status_code=422,
            detail="decision must be 'allow', 'deny', or 'always_session'",
        )
    if not bridge.resolve_approval(run_id, approval_id, request.decision):
        raise HTTPException(
            status_code=409,
            detail="No pending approval matches this run/approval id",
        )
    return {"status": "resolved", "decision": request.decision}


@router.post("/api/runs/{run_id}/interrupt")
def interrupt_run(run_id: str) -> dict:
    run = store.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    if run["status"] not in {"pending", "running"}:
        raise HTTPException(status_code=409, detail="Run is not active")
    request_stop(run_id)
    # A queued run has no driver to read the stop flag. If it won the admission
    # race, is_active is true and the cooperative path owns finalization.
    if run["status"] == "pending" and not runregistry.registry.is_active(run_id):
        store.update_run(
            run_id,
            "failed",
            result_kind="failed",
            result_detail="Interrupted before the run started.",
        )
        bridge.publish_terminal_from_row(run_id)
        return {"status": "interrupted"}
    return {"status": "interrupting"}


@router.get("/api/runs/{run_id}/events")
async def run_events(run_id: str, request: Request) -> StreamingResponse:
    """Observe a queued, live, or terminal run without affecting admission."""
    run = store.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")

    cursor = _request_cursor(request)
    broker = runbroker.get(run_id)
    if broker is None:
        # Terminal rows normally land here because run_lea retires the broker.
        # The same fallback also closes the tiny running/drop race cleanly.
        return StreamingResponse(_passive_done(run_id), media_type="text/event-stream")

    queue_position = store.queue_position(run_id)

    async def stream_events():
        if queue_position is not None and cursor == 0:
            yield sse("queued", {"run_id": run_id, "position": queue_position})
        async for frame in _subscribe(broker, cursor):
            yield frame

    return StreamingResponse(stream_events(), media_type="text/event-stream")
