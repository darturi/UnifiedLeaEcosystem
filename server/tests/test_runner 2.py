from pathlib import Path
from queue import Queue

from app.config import LeaConfig
from app.runner import (
    RunnerContext,
    _emit_file_snapshot,
    _emit_no_code_step,
    _parse_tool_call,
    _resolve_lea_path,
)
from app import db, store


def test_snapshot_emits_code_step_for_lean_write(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    lea_root = tmp_path / "lea"
    proof = lea_root / "workspace" / "proofs" / "demo.lean"
    proof.parent.mkdir(parents=True)
    proof.write_text("theorem demo : True := by\n  trivial")

    session = store.create_session("demo")
    run = store.create_run(session["id"], "gpt-4o", "openai", 2)
    events: Queue = Queue()
    context = RunnerContext(
        session_id=session["id"],
        run_id=run["id"],
        task="demo",
        config=LeaConfig(provider="openai", model="gpt-4o", max_turns=2, lea_root=lea_root),
        events=events,
    )

    _emit_file_snapshot(context=context, path=proof, emitted=set())

    item = events.get_nowait()
    detail = store.session_detail(session["id"])

    assert item["type"] == "code_step"
    assert item["payload"]["path"] == "workspace/proofs/demo.lean"
    assert detail["code_steps"][0]["code"].startswith("theorem demo")


def test_parse_tool_call_for_write_file():
    parsed = _parse_tool_call("  -> write_file({'path': 'proofs/demo.lean', 'content': 'abc'})")

    assert parsed == ("write_file", {"path": "proofs/demo.lean", "content": "abc"})


def test_resolve_lea_paths(tmp_path):
    lea_root = tmp_path / "lea"
    repo_relative = _resolve_lea_path("proofs/demo.lean", lea_root)
    workspace_relative = _resolve_lea_path("workspace/proofs/demo.lean", lea_root)
    absolute = _resolve_lea_path(str(tmp_path / "abs.lean"), lea_root)

    assert repo_relative == lea_root / "proofs" / "demo.lean"
    assert workspace_relative == lea_root / "workspace" / "proofs" / "demo.lean"
    assert absolute == tmp_path / "abs.lean"


def test_duplicate_snapshot_suppression(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    lea_root = tmp_path / "lea"
    proof = lea_root / "workspace" / "proofs" / "demo.lean"
    proof.parent.mkdir(parents=True)
    proof.write_text("theorem demo : True := by\n  trivial")

    session = store.create_session("demo")
    run = store.create_run(session["id"], "gpt-4o", "openai", 2)
    context = RunnerContext(
        session_id=session["id"],
        run_id=run["id"],
        task="demo",
        config=LeaConfig(provider="openai", model="gpt-4o", max_turns=2, lea_root=lea_root),
        events=Queue(),
    )
    emitted = set()

    _emit_file_snapshot(context=context, path=proof, emitted=emitted)
    _emit_file_snapshot(context=context, path=proof, emitted=emitted)

    detail = store.session_detail(session["id"])
    assert len(detail["code_steps"]) == 1


def test_no_code_turn_emits_timeline_step(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    lea_root = tmp_path / "lea"

    session = store.create_session("demo")
    run = store.create_run(session["id"], "gpt-4o", "openai", 2)
    events: Queue = Queue()
    context = RunnerContext(
        session_id=session["id"],
        run_id=run["id"],
        task="demo",
        config=LeaConfig(provider="openai", model="gpt-4o", max_turns=2, lea_root=lea_root),
        events=events,
    )

    step = _emit_no_code_step(
        context=context,
        turn=3,
        had_tool_call=False,
        latest_path="workspace/proofs/demo.lean",
        latest_code="theorem demo : True := by\n  trivial",
    )

    item = events.get_nowait()
    detail = store.session_detail(session["id"])

    assert item["type"] == "code_step"
    assert step["kind"] == "no_code"
    assert step["turn"] == 3
    assert "no tool calls" in step["summary"]
    assert detail["code_steps"][0]["kind"] == "no_code"
