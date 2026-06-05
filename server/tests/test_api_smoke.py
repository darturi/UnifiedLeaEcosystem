import asyncio

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


async def _read_stream(iterator):
    chunks = []
    async for chunk in iterator:
        chunks.append(chunk.decode("utf-8") if isinstance(chunk, bytes) else chunk)
    return "".join(chunks)
