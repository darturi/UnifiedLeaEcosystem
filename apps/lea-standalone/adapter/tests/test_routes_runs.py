"""Run creation, queue observation, reconnect, and interrupt behavior."""

import asyncio

from app import db, runbroker, runregistry, store
from app.config import LeaConfig
from app.runregistry import RunRegistry
from app.routes import runs as runs_route
from app.routes.runs import RunRequest


class _Req:
    def __init__(self, since=None, last_event_id=None):
        self.query_params = {} if since is None else {"since": since}
        self.headers = {} if last_event_id is None else {"last-event-id": last_event_id}


def _fresh_registry(monkeypatch, capacity=1):
    runbroker._brokers.clear()
    reg = RunRegistry(max_concurrent=capacity)
    monkeypatch.setattr(runregistry, "registry", reg)
    return reg


def _patch_config(monkeypatch, tmp_path):
    monkeypatch.setattr(
        runs_route,
        "load_config",
        lambda: LeaConfig(model="m", max_turns=3, lea_root=tmp_path, max_spend_usd=None),
    )
    # Creation tests inspect persisted rows. Keep the real background dispatcher
    # from invoking the prover; observer tests install brokers explicitly.
    monkeypatch.setattr(runs_route.bridge, "enqueue_run", lambda run_id: None)


def _setup(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    _patch_config(monkeypatch, tmp_path)
    return _fresh_registry(monkeypatch)


def test_create_run_tags_session_and_run_with_project_slug(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    result = runs_route.create_run(
        RunRequest(
            message="prove thm_one",
            autonomous=True,
            project_slug="doc-a",
            project_title="Doc A",
        )
    )

    session = store.get_session(result["session_id"])
    project = store.get_project_by_slug("doc-a")
    assert project is not None
    assert session["project_id"] == project["id"]
    assert result["project_id"] == project["id"]
    assert result["project_slug"] == "doc-a"
    assert result["project_namespace"] == project["namespace"]

    runs_route.create_run(
        RunRequest(message="prove thm_two", autonomous=True, project_slug="doc-a")
    )
    assert len(store.list_projects()) == 1
    doc_sessions = [
        s for s in store.usage_stats()["sessions"] if s["project_slug"] == "doc-a"
    ]
    assert len(doc_sessions) == 2


def test_create_run_records_overleaf_origin(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    url = "https://www.overleaf.com/project/doc-a"
    result = runs_route.create_run(
        RunRequest(
            message="prove thm_one",
            autonomous=True,
            project_slug="doc-a",
            project_title="Doc A",
            origin="overleaf",
            origin_url=url,
        )
    )
    session = store.get_session(result["session_id"])
    assert session["origin"] == "overleaf"
    assert session["origin_url"] == url


def test_create_run_without_origin_defaults_to_ui(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    result = runs_route.create_run(RunRequest(message="interactive run"))
    session = store.get_session(result["session_id"])
    assert session["origin"] == "ui"
    assert session["origin_url"] is None


def test_create_run_without_slug_stays_project_less(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    result = runs_route.create_run(RunRequest(message="interactive run"))
    session = store.get_session(result["session_id"])
    assert session["project_id"] is None
    assert result["project_id"] is None
    assert result["project_slug"] is None
    assert result["project_namespace"] is None
    assert store.list_projects() == []


def test_create_run_ignores_invalid_slug(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    result = runs_route.create_run(
        RunRequest(message="bad slug run", project_slug="not a valid slug!")
    )
    assert store.get_session(result["session_id"])["project_id"] is None
    assert store.list_projects() == []


def test_get_run_row_returns_only_cheap_outcome_columns(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    started = runs_route.create_run(RunRequest(message="prove it", autonomous=True))
    run_id = started["run_id"]
    assert set(runs_route.get_run_row(run_id)) == {
        "id", "status", "result_kind", "result_detail"
    }
    store.update_run(run_id, "proved", result_kind="proved", result_detail="qed")
    row = runs_route.get_run_row(run_id)
    assert row["status"] == "proved"
    assert row["result_kind"] == "proved"
    assert row["result_detail"] == "qed"


def test_get_run_row_404s_on_unknown_run(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    try:
        runs_route.get_run_row("no-such-run")
        assert False, "expected a 404"
    except Exception as exc:
        assert getattr(exc, "status_code", None) == 404


def _collect_through_done(response):
    async def collect():
        frames = []
        async for chunk in response.body_iterator:
            frames.append(chunk if isinstance(chunk, str) else chunk.decode())
            if "event: done" in frames[-1]:
                break
        return "".join(frames)

    return asyncio.run(collect())


def test_run_events_replays_buffered_history_then_tails_live(tmp_path, monkeypatch):
    reg = _setup(tmp_path, monkeypatch)
    started = runs_route.create_run(RunRequest(message="prove it", autonomous=True))
    run_id = started["run_id"]
    store.update_run(run_id, "running")
    reg.try_admit(run_id, started["session_id"])
    broker = runbroker.create(run_id)
    broker.put({"type": "status", "payload": {"status": "tool_call", "turn": 1}})

    async def run_case():
        response = await runs_route.run_events(run_id, _Req())

        async def finish():
            await asyncio.sleep(0.1)
            store.update_run(run_id, "proved")
            broker.put({"type": "done", "payload": {"status": "proved"}})

        asyncio.create_task(finish())
        frames = []
        async for chunk in response.body_iterator:
            frames.append(chunk if isinstance(chunk, str) else chunk.decode())
            if "event: done" in frames[-1]:
                break
        return "".join(frames)

    out = asyncio.run(run_case())
    assert "event: status" in out
    assert "event: done" in out
    assert "id: 1" in out


def test_reattach_cursor_skips_seen_events(tmp_path, monkeypatch):
    reg = _setup(tmp_path, monkeypatch)
    started = runs_route.create_run(RunRequest(message="prove it", autonomous=True))
    run_id = started["run_id"]
    store.update_run(run_id, "running")
    reg.try_admit(run_id, started["session_id"])
    broker = runbroker.create(run_id)
    broker.put({"type": "message", "payload": {"id": "m1"}})
    broker.put({"type": "code_step", "payload": {"id": "c1"}})
    broker.put({"type": "done", "payload": {"status": "proved"}})

    response = asyncio.run(runs_route.run_events(run_id, _Req(last_event_id="1")))
    out = _collect_through_done(response)
    assert "event: message" not in out
    assert "event: code_step" in out
    assert "event: done" in out


def test_terminal_run_without_broker_synthesizes_done(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    started = runs_route.create_run(RunRequest(message="prove it", autonomous=True))
    run_id = started["run_id"]
    store.update_run(
        run_id, "disproved", result_kind="disproved", result_detail="DISPROVED"
    )
    response = asyncio.run(runs_route.run_events(run_id, _Req()))
    out = _collect_through_done(response)
    assert "event: done" in out
    assert '"status": "disproved"' in out
    assert '"result_kind": "disproved"' in out


def test_queued_run_announces_position_before_broker_events(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    first = runs_route.create_run(RunRequest(message="first", autonomous=True))
    second = runs_route.create_run(RunRequest(message="second", autonomous=True))
    assert first["queue_position"] == 0
    assert second["queue_position"] == 1
    broker = runbroker.create(second["run_id"])
    broker.put({"type": "done", "payload": {"status": "proved"}})
    response = asyncio.run(runs_route.run_events(second["run_id"], _Req()))
    out = _collect_through_done(response)
    assert out.index("event: queued") < out.index("event: done")
    assert '"position": 1' in out


def test_interrupt_pending_unadmitted_run_finalizes_it(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    started = runs_route.create_run(RunRequest(message="prove it", autonomous=True))
    broker = runbroker.create(started["run_id"])
    assert runs_route.interrupt_run(started["run_id"]) == {"status": "interrupted"}
    run = store.get_run(started["run_id"])
    assert run["status"] == "failed"
    assert broker.closed


def test_interrupt_pending_admitted_run_stays_cooperative(tmp_path, monkeypatch):
    reg = _setup(tmp_path, monkeypatch)
    started = runs_route.create_run(RunRequest(message="prove it", autonomous=True))
    reg.try_admit(started["run_id"], started["session_id"])
    assert runs_route.interrupt_run(started["run_id"]) == {"status": "interrupting"}
    assert store.get_run(started["run_id"])["status"] == "pending"
