"""POST /api/runs project tagging (Overleaf path).

When the Overleaf companion sends a `project_slug` (the document namespace), the
adapter tags the new session + run with a project of that slug so the popover's
"This project" usage can be aggregated per document. The interactive UI path sends
no slug and stays project-less.
"""

import asyncio

from app import bridge, db, store
from app.config import LeaConfig
from app.routes import runs as runs_route
from app.routes.runs import RunRequest


def _patch_config(monkeypatch, tmp_path):
    monkeypatch.setattr(
        runs_route, "load_config",
        lambda: LeaConfig(model="m", max_turns=3, lea_root=tmp_path, max_spend_usd=None),
    )


def test_create_run_tags_session_and_run_with_project_slug(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    _patch_config(monkeypatch, tmp_path)

    result = runs_route.create_run(
        RunRequest(message="prove thm_one", autonomous=True,
                   project_slug="doc-a", project_title="Doc A")
    )

    session = store.get_session(result["session_id"])
    project = store.get_project_by_slug("doc-a")
    assert project is not None
    assert session["project_id"] == project["id"]

    # A second run for the same document reuses the same project (no duplicates).
    runs_route.create_run(
        RunRequest(message="prove thm_two", autonomous=True, project_slug="doc-a")
    )
    assert len(store.list_projects()) == 1

    # Both tagged sessions roll up under the document namespace in usage_stats.
    doc_sessions = [s for s in store.usage_stats()["sessions"] if s["project_slug"] == "doc-a"]
    assert len(doc_sessions) == 2


def test_create_run_without_slug_stays_project_less(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    _patch_config(monkeypatch, tmp_path)

    result = runs_route.create_run(RunRequest(message="interactive run"))

    session = store.get_session(result["session_id"])
    assert session["project_id"] is None
    assert store.list_projects() == []


def test_create_run_ignores_an_invalid_slug(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    _patch_config(monkeypatch, tmp_path)

    # A slug that fails validation must not fail the run — association is best-effort.
    result = runs_route.create_run(
        RunRequest(message="bad slug run", project_slug="not a valid slug!")
    )

    session = store.get_session(result["session_id"])
    assert session["project_id"] is None
    assert store.list_projects() == []


def test_current_active_run_id_round_trips():
    assert bridge.current_active_run_id() is None
    bridge._set_active_run_id("run-xyz")
    try:
        assert bridge.current_active_run_id() == "run-xyz"
    finally:
        bridge._set_active_run_id(None)
    assert bridge.current_active_run_id() is None


def _drain_done_status(response):
    async def collect():
        frames = []
        async for chunk in response.body_iterator:
            frames.append(chunk if isinstance(chunk, str) else chunk.decode())
            if "event: done" in frames[-1]:
                break
        return "".join(frames)

    return asyncio.run(collect())


def test_run_events_for_an_already_driven_run_attaches_passively(tmp_path, monkeypatch):
    """A second connection for a run already being driven must NOT spawn a runner;
    it tails the run and emits a single terminal `done`. This is what stops the
    Overleaf-viewed-in-UI request storm."""
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    _patch_config(monkeypatch, tmp_path)

    started = runs_route.create_run(
        RunRequest(message="prove it", autonomous=True, project_slug="doc-a")
    )
    run_id = started["run_id"]
    store.update_run(run_id, "running")

    # Pretend the companion is already driving this run.
    bridge._set_active_run_id(run_id)
    # Any attempt to spawn a competing runner thread should fail the test.
    def _no_thread(*args, **kwargs):
        raise AssertionError("passive view must not spawn a runner thread")
    monkeypatch.setattr(runs_route, "Thread", _no_thread)

    try:
        # Flip the run to terminal shortly after the passive view starts tailing.
        async def finish_soon():
            await asyncio.sleep(0.35)
            store.update_run(run_id, "success")

        async def run_case():
            response = await runs_route.run_events(run_id)
            asyncio.create_task(finish_soon())
            frames = []
            async for chunk in response.body_iterator:
                frames.append(chunk if isinstance(chunk, str) else chunk.decode())
                if "event: done" in frames[-1]:
                    break
            return "".join(frames)

        out = asyncio.run(run_case())
    finally:
        bridge._set_active_run_id(None)

    assert "event: done" in out
    assert '"status": "success"' in out


def test_run_events_rejects_when_a_different_run_is_active(tmp_path, monkeypatch):
    """While a different run holds the single-run slot, attaching to another run
    returns 409 (no doomed runner, no storm)."""
    import pytest
    from fastapi import HTTPException

    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    _patch_config(monkeypatch, tmp_path)

    started = runs_route.create_run(RunRequest(message="prove it", autonomous=True))
    run_id = started["run_id"]
    store.update_run(run_id, "running")

    bridge._set_active_run_id("some-other-run")
    monkeypatch.setattr(
        runs_route, "Thread",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not spawn a runner")),
    )
    try:
        with pytest.raises(HTTPException) as exc:
            asyncio.run(runs_route.run_events(run_id))
        assert exc.value.status_code == 409
    finally:
        bridge._set_active_run_id(None)
