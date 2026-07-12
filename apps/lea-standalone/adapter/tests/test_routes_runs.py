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
    # These tests exercise create_run's tagging, not execution: keep the FIFO
    # worker out of it (a real enqueue would try to drive the run with the
    # real prover).
    monkeypatch.setattr(runs_route.bridge, "enqueue_run", lambda run_id: None)


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
    assert result["project_id"] == project["id"]
    assert result["project_slug"] == "doc-a"
    assert result["project_namespace"] == project["namespace"]

    # A second run for the same document reuses the same project (no duplicates).
    runs_route.create_run(
        RunRequest(message="prove thm_two", autonomous=True, project_slug="doc-a")
    )
    assert len(store.list_projects()) == 1

    # Both tagged sessions roll up under the document namespace in usage_stats.
    doc_sessions = [s for s in store.usage_stats()["sessions"] if s["project_slug"] == "doc-a"]
    assert len(doc_sessions) == 2


def test_create_run_records_overleaf_origin(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    _patch_config(monkeypatch, tmp_path)

    url = "https://www.overleaf.com/project/doc-a"
    result = runs_route.create_run(
        RunRequest(message="prove thm_one", autonomous=True,
                   project_slug="doc-a", project_title="Doc A",
                   origin="overleaf", origin_url=url)
    )

    session = store.get_session(result["session_id"])
    assert session["origin"] == "overleaf"
    assert session["origin_url"] == url


def test_create_run_without_origin_defaults_to_ui(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    _patch_config(monkeypatch, tmp_path)

    result = runs_route.create_run(RunRequest(message="interactive run"))
    session = store.get_session(result["session_id"])
    assert session["origin"] == "ui"
    assert session["origin_url"] is None


def test_create_run_without_slug_stays_project_less(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    _patch_config(monkeypatch, tmp_path)

    result = runs_route.create_run(RunRequest(message="interactive run"))

    session = store.get_session(result["session_id"])
    assert session["project_id"] is None
    assert result["project_id"] is None
    assert result["project_slug"] is None
    assert result["project_namespace"] is None
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


def test_run_events_replays_buffered_history_then_tails_live(tmp_path, monkeypatch):
    """Phase 2 observer contract: attaching mid-run replays everything the hub
    already buffered, then tails live events to the terminal `done` — attach
    never starts or competes with a run."""
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    _patch_config(monkeypatch, tmp_path)

    started = runs_route.create_run(
        RunRequest(message="prove it", autonomous=True, project_slug="doc-a")
    )
    run_id = started["run_id"]
    store.update_run(run_id, "running")
    bridge._hub_publish(run_id, {"type": "status", "payload": {"status": "tool_call", "turn": 1}})

    async def run_case():
        response = await runs_route.run_events(run_id)

        async def finish_soon():
            await asyncio.sleep(0.2)
            store.update_run(run_id, "proved")
            bridge._hub_publish(run_id, {"type": "done", "payload": {"status": "proved"}})

        asyncio.create_task(finish_soon())
        frames = []
        async for chunk in response.body_iterator:
            frames.append(chunk if isinstance(chunk, str) else chunk.decode())
            if "event: done" in frames[-1]:
                break
        return "".join(frames)

    out = asyncio.run(run_case())
    assert "event: status" in out, "buffered history replays first"
    assert "event: done" in out
    assert '"status": "proved"' in out


def test_run_events_for_terminal_run_synthesizes_done(tmp_path, monkeypatch):
    """Attaching to an already-finished run is no longer a 409: the stream ends
    with a `done` synthesized from the persisted row (result labels intact)."""
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    _patch_config(monkeypatch, tmp_path)

    started = runs_route.create_run(RunRequest(message="prove it", autonomous=True))
    run_id = started["run_id"]
    store.update_run(run_id, "disproved", result_kind="disproved", result_detail="DISPROVED")

    out = _drain_done_status(asyncio.run(runs_route.run_events(run_id)))
    assert "event: done" in out
    assert '"status": "disproved"' in out
    assert '"result_kind": "disproved"' in out


def test_run_events_for_queued_run_announces_position(tmp_path, monkeypatch):
    """A pending (queued) run's stream opens with a `queued` frame carrying the
    run's FIFO position, so clients can render an honest waiting state."""
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    _patch_config(monkeypatch, tmp_path)

    first = runs_route.create_run(RunRequest(message="first", autonomous=True))
    second = runs_route.create_run(RunRequest(message="second", autonomous=True))
    assert first["queue_position"] == 0
    assert second["queue_position"] == 1

    async def read_first_frame():
        response = await runs_route.run_events(second["run_id"])
        async for chunk in response.body_iterator:
            return chunk if isinstance(chunk, str) else chunk.decode()
        return ""

    frame = asyncio.run(read_first_frame())
    assert "event: queued" in frame
    assert '"position": 1' in frame


def test_interrupt_pending_run_with_no_runner_fails_it_directly(tmp_path, monkeypatch):
    """A pending run nobody is driving (created by POST /api/runs but its events
    stream never attached — e.g. its client gave up waiting for the single-run
    slot) has no runner to read a stop flag: interrupt must fail it directly so
    the session's derived status doesn't show 'thinking' forever."""
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    _patch_config(monkeypatch, tmp_path)

    started = runs_route.create_run(RunRequest(message="prove it", autonomous=True))
    run_id = started["run_id"]

    bridge._set_active_run_id("some-other-run")
    try:
        result = runs_route.interrupt_run(run_id)
    finally:
        bridge._set_active_run_id(None)

    assert result == {"status": "interrupted"}
    run = store.get_run(run_id)
    assert run["status"] == "failed"
    assert run["result_kind"] == "failed"
    assert "before the run started" in run["result_detail"]


def test_interrupt_pending_run_being_driven_stays_cooperative(tmp_path, monkeypatch):
    """When the pending run IS the slot holder (its runner just hasn't flipped it
    to running yet), interrupt keeps the cooperative-stop path: flag set, status
    left for the runner to finalize."""
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    _patch_config(monkeypatch, tmp_path)

    started = runs_route.create_run(RunRequest(message="prove it", autonomous=True))
    run_id = started["run_id"]

    bridge._set_active_run_id(run_id)
    try:
        result = runs_route.interrupt_run(run_id)
    finally:
        bridge._set_active_run_id(None)

    assert result == {"status": "interrupting"}
    assert store.get_run(run_id)["status"] == "pending"
