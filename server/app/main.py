from __future__ import annotations

import asyncio
import json
import logging
from queue import Empty, Queue
from threading import Thread

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .config import load_config
from .db import init_db
from .lea_api_client import LeaApiClient, LeaApiError
from .runner import RunnerContext, run_lea
from . import settings as settings_service
from . import store


app = FastAPI(title="Lea Interface API")
logger = logging.getLogger("lea-interface.settings")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class RunRequest(BaseModel):
    message: str
    session_id: str | None = None


class ApprovalDecisionRequest(BaseModel):
    decision: str
    feedback: str | None = None


class ApiKeyUpdateRequest(BaseModel):
    value: str | None = None
    clear: bool = False


class SettingsRequest(BaseModel):
    model: str | None = None
    permission_tier: str | None = None
    max_turns: int | None = None
    max_spend_usd: float | None = None
    api_keys: dict[str, ApiKeyUpdateRequest] | None = None


@app.on_event("startup")
def startup() -> None:
    init_db()


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.get("/api/sessions")
def sessions() -> dict:
    return {"sessions": store.list_sessions()}


@app.get("/api/stats")
def stats() -> dict:
    return store.usage_stats()


@app.get("/api/settings")
def settings() -> dict:
    return settings_service.settings_payload()


@app.put("/api/settings")
def update_settings(request: SettingsRequest) -> dict:
    try:
        return settings_service.update_settings(request.dict(exclude_unset=True))
    except settings_service.SettingsValidationError as exc:
        logger.warning("Settings validation failed: field=%s message=%s", exc.field, str(exc))
        raise HTTPException(status_code=422, detail={"message": str(exc), "field": exc.field}) from exc
    except ValueError as exc:
        logger.warning("Settings update failed: %s", str(exc))
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/api/sessions/{session_id}")
def session_detail(session_id: str) -> dict:
    detail = store.session_detail(session_id)
    if not detail:
        raise HTTPException(status_code=404, detail="Session not found")
    return detail


@app.post("/api/runs")
def create_run(request: RunRequest) -> dict:
    message = request.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="Message is required")

    config = load_config()
    if settings_service.spend_limit_reached(config.max_spend_usd):
        raise HTTPException(status_code=402, detail="Max spend limit has been reached.")
    if request.session_id:
        session = store.get_session(request.session_id)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
    else:
        session = store.create_session(message)

    run = store.create_run(session["id"], config.model, None, config.max_turns)
    user_message = store.add_message(session["id"], "user", message, run["id"])
    return {
        "session_id": session["id"],
        "run_id": run["id"],
        "message": user_message,
    }


@app.post("/api/runs/{run_id}/approvals/{approval_id}")
def resolve_approval(run_id: str, approval_id: str, request: ApprovalDecisionRequest) -> dict:
    if request.decision not in {"accept", "reject"}:
        raise HTTPException(status_code=422, detail="decision must be 'accept' or 'reject'")
    feedback = request.feedback.strip() if request.feedback is not None else None
    if request.decision == "reject" and not feedback:
        raise HTTPException(status_code=422, detail="feedback is required when rejecting an approval")

    run = store.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    api_run_id = run.get("api_run_id")
    if not api_run_id:
        raise HTTPException(status_code=409, detail="Run is not ready for approval")

    try:
        return LeaApiClient(load_config()).resolve_approval(
            str(api_run_id),
            approval_id,
            request.decision,
            feedback if request.decision == "reject" else None,
        )
    except LeaApiError as exc:
        status_code = exc.status if exc.status in {400, 401, 403, 404, 409, 422} else 502
        raise HTTPException(status_code=status_code, detail=str(exc)) from exc


def sse(event_type: str, payload: dict) -> str:
    return f"event: {event_type}\ndata: {json.dumps(payload)}\n\n"


@app.get("/api/runs/{run_id}/events")
async def run_events(run_id: str) -> StreamingResponse:
    run = store.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    if run["status"] not in {"pending", "running"}:
        raise HTTPException(status_code=409, detail="Run has already completed")

    queue: Queue[dict] = Queue()
    session = store.session_detail(run["session_id"])
    if not session or not session["messages"]:
        raise HTTPException(status_code=404, detail="Run task not found")

    task = next(
        (message["content"] for message in reversed(session["messages"]) if message["run_id"] == run_id and message["role"] == "user"),
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
