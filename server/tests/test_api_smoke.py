import asyncio

import pytest
from fastapi import HTTPException

import app.main as main
import app.project_unassignment as project_unassignment
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


def test_project_crud_and_run_selection(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    monkeypatch.setattr(
        main,
        "load_config",
        lambda: LeaConfig(
            model="o4-mini",
            max_turns=2,
            lea_api_base_url="http://127.0.0.1:8000",
            lea_root=tmp_path / "lea",
        ),
    )

    project = main.create_project(main.ProjectRequest(slug="epsilon", title="Epsilon"))
    assert project["path"] == "workspace/projects/epsilon.md"
    assert main.projects()["projects"][0]["slug"] == "epsilon"

    created = main.create_run(main.RunRequest(message="prove True", project_id=project["id"]))
    detail = store.session_detail(created["session_id"])

    assert detail["project"]["slug"] == "epsilon"
    assert detail["active_run"]["project_id"] == project["id"]


def test_project_theorem_unassign_safe_move(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    lea_root = tmp_path / "lea"
    _write_project_fixture(
        lea_root,
        {
            "solo": "import Mathlib\n\nnamespace Lea.Epsilon\n\ntheorem solo : True := by\n  trivial\n\nend Lea.Epsilon\n",
        },
    )
    monkeypatch.setattr(
        main,
        "load_config",
        lambda: LeaConfig(model="o4-mini", max_turns=2, lea_api_base_url="http://127.0.0.1:8000", lea_root=lea_root),
    )
    monkeypatch.setattr(project_unassignment, "_verify_lean_file", lambda config, path: None)
    project = main.create_project(main.ProjectRequest(slug="epsilon", title="Epsilon"))

    checked = main.project_theorem_unassignment_check(project["id"], "solo")
    result = main.project_theorem_unassign(project["id"], "solo")

    assert checked["status"] == "safe"
    assert result["status"] == "unassigned"
    assert result["move"]["to_path"] == "workspace/proofs/Lea/Misc/solo.lean"
    assert not (lea_root / "workspace" / "proofs" / "Lea" / "Epsilon" / "solo.lean").exists()
    moved = lea_root / "workspace" / "proofs" / "Lea" / "Misc" / "solo.lean"
    assert "namespace Lea.Misc" in moved.read_text()
    assert "end Lea.Misc" in moved.read_text()
    assert "## Theorem: solo" not in (lea_root / "workspace" / "projects" / "epsilon.md").read_text()


def test_project_theorem_unassign_blocks_when_used_by_other_project_theorem(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    lea_root = tmp_path / "lea"
    _write_project_fixture(
        lea_root,
        {
            "even_square_of_even": (
                "import Mathlib\n\nnamespace Lea.Epsilon\n\n"
                "theorem even_square_of_even : True := by\n  trivial\n\nend Lea.Epsilon\n"
            ),
            "even_square_of_double_plus_double": (
                "import Mathlib\nimport Lea.Epsilon.even_square_of_even\n\nnamespace Lea.Epsilon\n\n"
                "theorem even_square_of_double_plus_double : True := by\n  exact even_square_of_even\n\nend Lea.Epsilon\n"
            ),
        },
    )
    monkeypatch.setattr(
        main,
        "load_config",
        lambda: LeaConfig(model="o4-mini", max_turns=2, lea_api_base_url="http://127.0.0.1:8000", lea_root=lea_root),
    )
    project = main.create_project(main.ProjectRequest(slug="epsilon", title="Epsilon"))

    with pytest.raises(HTTPException) as exc:
        main.project_theorem_unassignment_check(project["id"], "even_square_of_even")

    assert exc.value.status_code == 409
    assert exc.value.detail["conflict_type"] == "used_by_project_theorems"
    assert "even_square_of_double_plus_double" in exc.value.detail["message"]


def test_project_theorem_unassign_blocks_when_target_uses_project_theorem(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    lea_root = tmp_path / "lea"
    _write_project_fixture(
        lea_root,
        {
            "even_square_of_even": (
                "import Mathlib\n\nnamespace Lea.Epsilon\n\n"
                "theorem even_square_of_even : True := by\n  trivial\n\nend Lea.Epsilon\n"
            ),
            "even_square_of_double_plus_double": (
                "import Mathlib\nimport Lea.Epsilon.even_square_of_even\n\nnamespace Lea.Epsilon\n\n"
                "theorem even_square_of_double_plus_double : True := by\n  exact even_square_of_even\n\nend Lea.Epsilon\n"
            ),
        },
    )
    monkeypatch.setattr(
        main,
        "load_config",
        lambda: LeaConfig(model="o4-mini", max_turns=2, lea_api_base_url="http://127.0.0.1:8000", lea_root=lea_root),
    )
    project = main.create_project(main.ProjectRequest(slug="epsilon", title="Epsilon"))

    with pytest.raises(HTTPException) as exc:
        main.project_theorem_unassignment_check(project["id"], "even_square_of_double_plus_double")

    assert exc.value.status_code == 409
    assert exc.value.detail["conflict_type"] == "uses_project_theorems"
    assert "imports `Lea.Epsilon.even_square_of_even`" in exc.value.detail["message"]


def test_run_events_builds_project_payload(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    lea_root = tmp_path / "lea"
    project_file = lea_root / "workspace" / "projects" / "epsilon.md"
    project_file.parent.mkdir(parents=True)
    project_file.write_text("# Project epsilon\n")
    monkeypatch.setattr(
        main,
        "load_config",
        lambda: LeaConfig(
            model="o4-mini",
            max_turns=2,
            lea_api_base_url="http://127.0.0.1:8000",
            lea_root=lea_root,
        ),
    )
    seen = {}

    def fake_run_lea(context):
        seen["project"] = context.project
        store.update_run(context.run_id, "success", final_text="done")
        store.touch_session(context.session_id, "success")
        context.events.put({"type": "done", "payload": {"status": "success"}})

    monkeypatch.setattr(main, "run_lea", fake_run_lea)

    project = main.create_project(main.ProjectRequest(slug="epsilon", title="Epsilon"))
    created = main.create_run(main.RunRequest(message="prove True", project_id=project["id"]))
    response = asyncio.run(main.run_events(created["run_id"]))
    asyncio.run(_read_stream(response.body_iterator))

    assert seen["project"]["project_id"] == "epsilon"
    assert seen["project"]["project_context"] == "# Project epsilon\n"


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


def _write_project_fixture(lea_root, proofs):
    project_dir = lea_root / "workspace" / "projects"
    proof_dir = lea_root / "workspace" / "proofs" / "Lea" / "Epsilon"
    project_dir.mkdir(parents=True)
    proof_dir.mkdir(parents=True)
    entries = ['# Project epsilon\n\n<!-- lea:project id="epsilon" -->\n']
    for name, content in proofs.items():
        (proof_dir / f"{name}.lean").write_text(content)
        entries.append(
            "\n".join(
                [
                    f"## Theorem: {name}",
                    "",
                    f'<!-- lea:theorem name="{name}" proof="workspace/proofs/Lea/Epsilon/{name}.lean" module="Lea.Epsilon.{name}" -->',
                    "",
                    "### Signature",
                    "",
                    "```lean",
                    f"theorem {name} : True := by",
                    "```",
                    "",
                    "### Lean Location",
                    "",
                    f"`workspace/proofs/Lea/Epsilon/{name}.lean`",
                    "",
                ]
            )
        )
    (project_dir / "epsilon.md").write_text("\n".join(entries))
