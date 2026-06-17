from queue import Queue
import json

import app.runner as runner
from app import db, recorder, store
from app.config import LeaConfig
from app.runner import RunnerContext, record_run


class FakeLeaApiClient:
    def __init__(self, events=None, status=None, transcript=None):
        self.events = events or []
        self.status = status or {"status": "completed"}
        self.transcript = transcript

    def stream_events(self, api_run_id, from_seq=0, timeout=None):
        for event in self.events:
            yield event

    def get_run(self, api_run_id):
        return self.status

    def get_transcript(self, api_run_id, transcript_url=None):
        return self.transcript


def make_config(tmp_path, **overrides):
    return LeaConfig(
        model=overrides.get("model", "o4-mini"),
        max_turns=overrides.get("max_turns", 2),
        lea_api_base_url=overrides.get("lea_api_base_url", "http://127.0.0.1:8000"),
        lea_root=overrides.get("lea_root", tmp_path / "lea"),
    )


def _setup(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    monkeypatch.setattr(runner, "RAW_EVENT_LOG_DIR", tmp_path / "event-logs")
    monkeypatch.setattr(store, "RAW_EVENT_LOG_DIR", tmp_path / "event-logs")
    db.init_db()


def test_record_run_persists_overleaf_session(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    proof = tmp_path / "lea" / "workspace" / "proofs" / "demo.lean"
    proof.parent.mkdir(parents=True)
    proof.write_text("theorem demo : True := by\n  trivial")

    session = store.create_session("theorem-demo", origin="overleaf", external_ref={"overleaf_project_id": "p1"})
    run = store.create_run(session["id"], "o4-mini", None, 2, origin="overleaf")
    store.add_message(session["id"], "user", "Prove demo", run["id"])

    client = FakeLeaApiClient(
        events=[
            {"seq": 0, "type": "assistant_text_delta", "text": "Proving it."},
            {
                "seq": 1,
                "type": "tool_called",
                "name": "write_file",
                "args": {"path": "workspace/proofs/demo.lean", "content": "theorem demo : True := by\n  trivial"},
            },
            {"seq": 2, "type": "tool_resulted", "name": "write_file", "content": "Wrote 37 bytes"},
            {"seq": 3, "type": "tool_called", "name": "lean_check", "args": {"path": "workspace/proofs/demo.lean"}},
            {"seq": 4, "type": "tool_resulted", "name": "lean_check", "content": "OK - no errors, no warnings."},
            {"seq": 5, "type": "usage_updated", "input_tokens": 100, "output_tokens": 40, "cost": 0.003},
            {"seq": 6, "type": "finished", "reason": "completed", "final_text": "Done."},
        ]
    )
    context = RunnerContext(
        session_id=session["id"],
        run_id=run["id"],
        task="Prove demo",
        config=make_config(tmp_path),
        events=Queue(),
        client=client,
    )

    status = record_run(context, "run_overleaf_1")

    detail = store.session_detail(session["id"])
    stored_run = store.get_run(run["id"])
    assert status == "success"
    assert stored_run["status"] == "success"
    assert stored_run["api_run_id"] == "run_overleaf_1"
    assert stored_run["input_tokens"] == 100
    assert detail["origin"] == "overleaf"
    assert detail["external_ref"] == {"overleaf_project_id": "p1"}
    assert detail["code_steps"][0]["path"] == "workspace/proofs/demo.lean"
    assert any(m["role"] == "assistant" and m["content"] == "Proving it." for m in detail["messages"])
    assert (tmp_path / "event-logs" / f"{run['id']}.jsonl").exists()


def test_record_run_records_approval_events(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    proof = tmp_path / "lea" / "workspace" / "proofs" / "demo.lean"
    proof.parent.mkdir(parents=True)
    proof.write_text("theorem demo : True := by\n  trivial")

    session = store.create_session("theorem-demo", origin="overleaf")
    run = store.create_run(session["id"], "o4-mini", None, 2, origin="overleaf")
    client = FakeLeaApiClient(
        events=[
            {
                "seq": 0,
                "type": "approval_requested",
                "approval_id": "ap-1",
                "tier": "theorem_translation",
                "candidate": 1,
                "lean_code": "import Mathlib\n\ntheorem demo : True := by sorry",
                "theorem_name": "demo",
            },
            {"seq": 1, "type": "approval_resolved", "approval_id": "ap-1", "decision": "accept"},
            {
                "seq": 2,
                "type": "tool_called",
                "name": "write_file",
                "args": {"path": "workspace/proofs/demo.lean", "content": "theorem demo : True := by\n  trivial"},
            },
            {"seq": 3, "type": "tool_resulted", "name": "write_file", "content": "Wrote 37 bytes"},
            {"seq": 4, "type": "tool_called", "name": "lean_check", "args": {"path": "workspace/proofs/demo.lean"}},
            {"seq": 5, "type": "tool_resulted", "name": "lean_check", "content": "OK - no errors, no warnings."},
            {"seq": 6, "type": "finished", "reason": "completed", "final_text": "done"},
        ]
    )
    context = RunnerContext(
        session_id=session["id"],
        run_id=run["id"],
        task="Prove demo",
        config=make_config(tmp_path),
        events=Queue(),
        client=client,
    )

    record_run(context, "run_overleaf_2")

    detail = store.session_detail(session["id"])
    assert len(detail["approval_events"]) == 1
    assert detail["approval_events"][0]["approval_id"] == "ap-1"
    assert detail["approval_events"][0]["decision"] == "accept"


def test_recorder_cli_creates_linked_overleaf_session(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    monkeypatch.setenv("LEA_API_BASE_URL", "http://127.0.0.1:8000")

    captured = {}

    def fake_record_run(context, api_run_id, **kwargs):
        captured["api_run_id"] = api_run_id
        captured["session_id"] = context.session_id
        captured["run_id"] = context.run_id
        captured["project"] = context.project
        store.update_run(context.run_id, "success")
        store.touch_session(context.session_id, "success")
        return "success"

    monkeypatch.setattr(recorder, "record_run", fake_record_run)

    result = recorder.run(
        [
            "--api-run-id", "run_cli_1",
            "--task", "Prove the lemma",
            "--title", "lemma-1",
            "--origin", "overleaf",
            "--project-slug", "myproj",
            "--project-title", "My Project",
            "--external-ref", '{"overleaf_project_id": "abc", "theorem_label": "lemma-1"}',
        ]
    )

    assert result["status"] == "success"
    assert captured["api_run_id"] == "run_cli_1"
    detail = store.session_detail(result["session_id"])
    assert detail["origin"] == "overleaf"
    assert detail["external_ref"]["overleaf_project_id"] == "abc"
    assert detail["messages"][0]["role"] == "user"
    assert detail["messages"][0]["content"] == "Prove the lemma"
    project = store.get_project_by_slug("myproj")
    assert project is not None
    assert detail["project"]["slug"] == "myproj"
    assert store.get_run(result["run_id"])["origin"] == "overleaf"


def test_recorder_emits_session_link_before_recording_when_requested(tmp_path, monkeypatch, capsys):
    _setup(tmp_path, monkeypatch)
    monkeypatch.setenv("LEA_API_BASE_URL", "http://127.0.0.1:8000")

    captured = {}

    def fake_record_run(context, api_run_id, **kwargs):
        captured["stdout_before_record"] = capsys.readouterr().out
        store.update_run(context.run_id, "success")
        store.touch_session(context.session_id, "success")
        return "success"

    monkeypatch.setattr(recorder, "record_run", fake_record_run)

    result = recorder.run([
        "--api-run-id", "run_cli_link",
        "--task", "Prove the link",
        "--title", "linked-lemma",
        "--origin", "overleaf",
        "--emit-session-link",
    ])

    line = json.loads(captured["stdout_before_record"].strip())
    assert line["type"] == "session_link"
    assert line["session_id"] == result["session_id"]
    assert line["run_id"] == result["run_id"]


def test_recorder_main_still_prints_final_result_json(tmp_path, monkeypatch, capsys):
    _setup(tmp_path, monkeypatch)
    monkeypatch.setenv("LEA_API_BASE_URL", "http://127.0.0.1:8000")

    def fake_record_run(context, api_run_id, **kwargs):
        store.update_run(context.run_id, "success")
        store.touch_session(context.session_id, "success")
        return "success"

    monkeypatch.setattr(recorder, "record_run", fake_record_run)

    exit_code = recorder.main([
        "--api-run-id", "run_cli_final",
        "--task", "Prove final output",
        "--title", "final-lemma",
        "--origin", "overleaf",
    ])

    output = json.loads(capsys.readouterr().out.strip())
    assert exit_code == 0
    assert output["session_id"]
    assert output["run_id"]
    assert output["status"] == "success"
