from __future__ import annotations

import asyncio
import json
from queue import Empty, Queue
from threading import Thread

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .config import load_config
from .db import init_db
from .runner import RunnerContext, run_lea
from . import store


app = FastAPI(title="Lea Interface API")

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


@app.on_event("startup")
def startup() -> None:
    init_db()


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.get("/api/sessions")
def sessions() -> dict:
    return {"sessions": store.list_sessions()}


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
    if request.session_id:
        session = store.get_session(request.session_id)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
    else:
        session = store.create_session(message)

    run = store.create_run(session["id"], config.model, config.provider, config.max_turns)
    user_message = store.add_message(session["id"], "user", message, run["id"])
    return {
        "session_id": session["id"],
        "run_id": run["id"],
        "message": user_message,
    }


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

