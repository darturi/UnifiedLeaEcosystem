import asyncio

import pytest
from fastapi import HTTPException

import app.main as main
from app import db, store
from app.config import LeaConfig


def test_run_endpoint_streams_react_compatible_events(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    monkeypatch.setattr(
        main,
        "load_config",
        lambda: LeaConfig(
            model="o4-mini",
            max_turns=2,
            lea_api_base_url="http://127.0.0.1:8000",
        ),
    )

    def fake_run_lea(context):
        context.events.put({"type": "status", "payload": {"message": "fake run started"}})
        context.events.put({"type": "assistant_delta", "payload": {"text": "done"}})
        step = store.add_code_step(
            context.session_id,
            context.run_id,
            "workspace/proofs/demo.lean",
            "theorem demo : True := by\n  trivial",
        )
        context.events.put({"type": "code_step", "payload": step})
        message = store.add_message(context.session_id, "assistant", "done", context.run_id)
        store.update_run(context.run_id, "success", final_text="done")
        store.touch_session(context.session_id, "success")
        context.events.put({"type": "message", "payload": message})
        context.events.put({"type": "done", "payload": {"status": "success"}})

    monkeypatch.setattr(main, "run_lea", fake_run_lea)

    created = main.create_run(main.RunRequest(message="prove True"))
    response = asyncio.run(main.run_events(created["run_id"]))
    body = asyncio.run(_read_stream(response.body_iterator))
    detail = store.session_detail(created["session_id"])

    assert "event: status" in body
    assert "event: assistant_delta" in body
    assert "event: code_step" in body
    assert "event: message" in body
    assert "event: done" in body
    assert detail["status"] == "success"
    assert detail["code_steps"][0]["path"] == "workspace/proofs/demo.lean"


def test_stats_endpoint_returns_usage_rollups(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()

    session = store.create_session("stats endpoint")
    run = store.create_run(session["id"], "o4-mini", None, 2)
    store.add_message(session["id"], "user", "prove True", run["id"])
    store.update_run(run["id"], "success", input_tokens=50, output_tokens=20, cost_usd=0.03)

    body = main.stats()

    assert body["global"]["session_count"] == 1
    assert body["global"]["total_tokens"] == 70
    assert body["sessions"][0]["primary_model"] == "o4-mini"
    assert body["models"][0]["cost_usd"] == 0.03


def test_run_endpoint_blocks_when_max_spend_reached(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    monkeypatch.setattr(
        main,
        "load_config",
        lambda: LeaConfig(
            model="o4-mini",
            max_turns=2,
            max_spend_usd=0,
            lea_api_base_url="http://127.0.0.1:8000",
        ),
    )

    with pytest.raises(HTTPException) as exc:
        main.create_run(main.RunRequest(message="prove True"))

    assert exc.value.status_code == 402


def test_approval_endpoint_forwards_decision_to_upstream_run(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    monkeypatch.setattr(
        main,
        "load_config",
        lambda: LeaConfig(
            model="o4-mini",
            max_turns=2,
            lea_api_base_url="http://127.0.0.1:8000",
        ),
    )
    seen = {}

    class FakeLeaApiClient:
        def __init__(self, config):
            seen["config"] = config

        def resolve_approval(self, api_run_id, approval_id, decision, feedback=None):
            seen["approval"] = (api_run_id, approval_id, decision, feedback)
            return {"run_id": api_run_id, "approval_id": approval_id, "decision": decision}

    monkeypatch.setattr(main, "LeaApiClient", FakeLeaApiClient)

    session = store.create_session("approve")
    run = store.create_run(session["id"], "o4-mini", None, 2)
    store.set_run_api_run_id(run["id"], "api-run-1")

    response = main.resolve_approval(
        run["id"],
        "ap-1",
        main.ApprovalDecisionRequest(decision="reject", feedback="wrong domain"),
    )

    assert response == {"run_id": "api-run-1", "approval_id": "ap-1", "decision": "reject"}
    assert seen["approval"] == ("api-run-1", "ap-1", "reject", "wrong domain")


def test_approval_endpoint_reject_requires_feedback(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    session = store.create_session("approve")
    run = store.create_run(session["id"], "o4-mini", None, 2)
    store.set_run_api_run_id(run["id"], "api-run-1")

    with pytest.raises(HTTPException) as exc:
        main.resolve_approval(
            run["id"],
            "ap-1",
            main.ApprovalDecisionRequest(decision="reject"),
        )

    assert exc.value.status_code == 422


async def _read_stream(iterator):
    chunks = []
    async for chunk in iterator:
        chunks.append(chunk.decode("utf-8") if isinstance(chunk, bytes) else chunk)
    return "".join(chunks)
