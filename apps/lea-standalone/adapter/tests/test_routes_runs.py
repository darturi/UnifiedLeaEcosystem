"""POST /api/runs project tagging (Overleaf path).

When the Overleaf companion sends a `project_slug` (the document namespace), the
adapter tags the new session + run with a project of that slug so the popover's
"This project" usage can be aggregated per document. The interactive UI path sends
no slug and stays project-less.
"""

import asyncio

from app import db, runbroker, runregistry, store
from app.config import LeaConfig
from app.runregistry import RunRegistry
from app.routes import runs as runs_route
from app.routes.runs import RunRequest


class _Req:
    """Minimal stand-in for the FastAPI Request run_events takes. No header/param =>
    the broker stream replays from cursor 0."""

    def __init__(self, since=None, last_event_id=None):
        self.query_params = {} if since is None else {"since": since}
        self.headers = {} if last_event_id is None else {"last-event-id": last_event_id}


def _fresh_registry(monkeypatch, capacity=1):
    """Swap in a clean registry so admission state can't leak across tests. Both the
    endpoint and the bridge reach it via `runregistry.registry`, so one patch covers
    both."""
    runbroker._brokers.clear()  # module-global; don't let brokers leak across tests
    reg = RunRegistry(max_concurrent=capacity)
    monkeypatch.setattr(runregistry, "registry", reg)
    return reg


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


def test_get_run_row_returns_the_cheap_outcome_columns(tmp_path, monkeypatch):
    """GET /api/runs/{run_id} (item 16) returns just id + status + result_kind +
    result_detail — the outcome a poller needs, not a full session detail. The row
    tracks the run's lifecycle: `running` before, terminal kind/detail after."""
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    _patch_config(monkeypatch, tmp_path)

    started = runs_route.create_run(RunRequest(message="prove it", autonomous=True))
    run_id = started["run_id"]

    row = runs_route.get_run_row(run_id)
    assert row["id"] == run_id
    assert row["status"] in {"pending", "running"}
    # Exactly the cheap columns — no messages/code_steps/usage bleed through.
    assert set(row.keys()) == {"id", "status", "result_kind", "result_detail"}

    store.update_run(run_id, "proved", result_kind="proved", result_detail="qed")
    row = runs_route.get_run_row(run_id)
    assert row["status"] == "proved"
    assert row["result_kind"] == "proved"
    assert row["result_detail"] == "qed"


def test_get_run_row_404s_on_an_unknown_run(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    try:
        runs_route.get_run_row("no-such-run")
        assert False, "expected a 404 for an unknown run id"
    except Exception as exc:  # HTTPException
        assert getattr(exc, "status_code", None) == 404


def _drain_done_status(response):
    async def collect():
        frames = []
        async for chunk in response.body_iterator:
            frames.append(chunk if isinstance(chunk, str) else chunk.decode())
            if "event: done" in frames[-1]:
                break
        return "".join(frames)

    return asyncio.run(collect())


def test_run_events_already_active_without_a_broker_falls_back_to_terminal_done(tmp_path, monkeypatch):
    """The rare race: a run reads active but its broker is already gone (the driver hit
    its finally between our status check and here). The reattach must NOT spawn a
    runner and must settle the client with one terminal `done` from the persisted
    status rather than hanging."""
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    _patch_config(monkeypatch, tmp_path)

    reg = _fresh_registry(monkeypatch, capacity=1)
    started = runs_route.create_run(
        RunRequest(message="prove it", autonomous=True, project_slug="doc-a")
    )
    run_id = started["run_id"]
    store.update_run(run_id, "running")

    # Active in the registry but with NO broker registered → the fallback path.
    reg.try_admit(run_id, started["session_id"])
    def _no_thread(*args, **kwargs):
        raise AssertionError("a reattach must not spawn a runner thread")
    monkeypatch.setattr(runs_route, "Thread", _no_thread)

    async def finish_soon():
        await asyncio.sleep(0.35)
        store.update_run(run_id, "proved")

    async def run_case():
        response = await runs_route.run_events(run_id, _Req())
        asyncio.create_task(finish_soon())
        frames = []
        async for chunk in response.body_iterator:
            frames.append(chunk if isinstance(chunk, str) else chunk.decode())
            if "event: done" in frames[-1]:
                break
        return "".join(frames)

    out = asyncio.run(run_case())

    assert "event: done" in out
    assert '"status": "proved"' in out


def test_reattaching_to_a_live_run_replays_events_not_just_done(tmp_path, monkeypatch):
    """The heart of the broker fix. A second/reconnected connection to a *running* run
    rejoins the LIVE stream — replaying buffered events (e.g. a pending approval that
    fired while the client was away) and then following new ones — instead of the old
    passive view that emitted only a terminal `done`. This is what makes the approval
    card reappear after a stream drop / session switch without a manual re-fetch."""
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    _patch_config(monkeypatch, tmp_path)

    reg = _fresh_registry(monkeypatch, capacity=1)
    started = runs_route.create_run(RunRequest(message="prove it", autonomous=True))
    run_id = started["run_id"]
    store.update_run(run_id, "running")

    # The run is being driven (holds the slot) AND has a live broker with buffered
    # events the first connection would have shown — including the approval the user
    # never saw before this fix.
    reg.try_admit(run_id, started["session_id"])
    broker = runbroker.create(run_id)
    broker.put({"type": "approval_requested", "payload": {"approval_id": "a1", "tool_name": "bash"}})
    broker.put({"type": "code_step", "payload": {"id": "c1"}})

    monkeypatch.setattr(
        runs_route, "Thread",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("reattach must not spawn a runner")),
    )

    async def run_case():
        response = await runs_route.run_events(run_id, _Req())

        async def finish():
            await asyncio.sleep(0.2)
            broker.put({"type": "done", "payload": {"status": "proved"}})

        asyncio.create_task(finish())
        frames = []
        async for chunk in response.body_iterator:
            frames.append(chunk if isinstance(chunk, str) else chunk.decode())
            if "event: done" in frames[-1]:
                break
        return "".join(frames)

    out = asyncio.run(run_case())

    # The buffered approval + code step are REPLAYED (the old passive view dropped them).
    assert "event: approval_requested" in out, "reattach must replay the buffered approval"
    assert '"approval_id": "a1"' in out
    assert "event: code_step" in out
    assert "event: done" in out
    # `id:` frames are present so a native EventSource reconnect can resume via Last-Event-ID.
    assert "id: 1" in out


def test_reattach_with_last_event_id_resumes_without_replaying_seen_events(tmp_path, monkeypatch):
    """A browser's native EventSource reconnect sends `Last-Event-ID`; the broker must
    resume just past it, not re-deliver everything (which would double live assistant
    tokens). The manual-attach path (no header) replays from 0 and relies on the
    client's id-dedupe instead."""
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    _patch_config(monkeypatch, tmp_path)
    reg = _fresh_registry(monkeypatch, capacity=1)
    started = runs_route.create_run(RunRequest(message="prove it", autonomous=True))
    run_id = started["run_id"]
    store.update_run(run_id, "running")
    reg.try_admit(run_id, started["session_id"])
    broker = runbroker.create(run_id)
    broker.put({"type": "message", "payload": {"id": "m1"}})    # seq 1 — already seen
    broker.put({"type": "code_step", "payload": {"id": "c1"}})  # seq 2 — new
    monkeypatch.setattr(
        runs_route, "Thread",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("no runner on reattach")),
    )

    async def run_case():
        response = await runs_route.run_events(run_id, _Req(last_event_id="1"))

        async def finish():
            await asyncio.sleep(0.2)
            broker.put({"type": "done", "payload": {"status": "proved"}})

        asyncio.create_task(finish())
        frames = []
        async for chunk in response.body_iterator:
            frames.append(chunk if isinstance(chunk, str) else chunk.decode())
            if "event: done" in frames[-1]:
                break
        return "".join(frames)

    out = asyncio.run(run_case())
    assert "event: message" not in out, "resume must not replay events at/below Last-Event-ID"
    assert "event: code_step" in out  # only the unseen event
    assert "event: done" in out


def test_run_events_rejects_when_at_capacity(tmp_path, monkeypatch):
    """While a *different session's* run fills capacity, attaching to another run
    returns a 409 'at capacity' with Retry-After (no doomed runner, no storm)."""
    import pytest
    from fastapi import HTTPException

    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    _patch_config(monkeypatch, tmp_path)
    reg = _fresh_registry(monkeypatch, capacity=1)

    started = runs_route.create_run(RunRequest(message="prove it", autonomous=True))
    run_id = started["run_id"]
    store.update_run(run_id, "running")

    # A different chat's run holds the only slot.
    reg.try_admit("some-other-run", "some-other-session")
    monkeypatch.setattr(
        runs_route, "Thread",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not spawn a runner")),
    )
    with pytest.raises(HTTPException) as exc:
        asyncio.run(runs_route.run_events(run_id, _Req()))
    assert exc.value.status_code == 409
    assert "at capacity" in exc.value.detail.lower()
    assert exc.value.headers.get("Retry-After")


def test_interrupt_pending_run_with_no_runner_fails_it_directly(tmp_path, monkeypatch):
    """A pending run nobody is driving (created by POST /api/runs but its events
    stream never attached — e.g. its client gave up waiting for the single-run
    slot) has no runner to read a stop flag: interrupt must fail it directly so
    the session's derived status doesn't show 'thinking' forever."""
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    _patch_config(monkeypatch, tmp_path)

    _fresh_registry(monkeypatch, capacity=1)  # run_id is absent → provably no driver
    started = runs_route.create_run(RunRequest(message="prove it", autonomous=True))
    run_id = started["run_id"]

    result = runs_route.interrupt_run(run_id)

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

    reg = _fresh_registry(monkeypatch, capacity=1)
    started = runs_route.create_run(RunRequest(message="prove it", autonomous=True))
    run_id = started["run_id"]

    # The pending run holds a slot (its runner was admitted but hasn't flipped it to
    # running yet), so interrupt stays cooperative rather than failing it directly.
    reg.try_admit(run_id, started["session_id"])
    result = runs_route.interrupt_run(run_id)

    assert result == {"status": "interrupting"}
    assert store.get_run(run_id)["status"] == "pending"
