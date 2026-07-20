"""Admission at the events endpoint (v2.3 items 9/10).

The registry's atomicity is proven in test_runregistry.py; here we pin the *endpoint*
contract built on it:

  * a new turn for a busy session supersedes that session's own incumbent, and only
    that incumbent — a different chat's run is never touched (per-session supersede);
  * a stranger at a full house gets an honest 409 'at capacity' with Retry-After,
    not a doomed runner;
  * if the superseded incumbent never releases, the waiter times out to a 409 rather
    than hanging;
  * raising LEA_MAX_CONCURRENT_RUNS lets independent sessions run at once.

These drive `run_events` directly with the runner thread faked out, so no model or
Lean is involved — we assert admission state, not proof behavior.
"""

import asyncio

import pytest
from fastapi import HTTPException

from app import db, runbroker, runregistry, store
from app.config import LeaConfig
from app.runregistry import RunRegistry
from app.routes import runs as runs_route
from app.routes.runs import RunRequest


class _Req:
    """A minimal stand-in for the FastAPI Request run_events now takes — just the two
    accessors _request_cursor reads. No header/param => the stream replays from 0."""

    def __init__(self, since=None, last_event_id=None):
        self.query_params = {} if since is None else {"since": since}
        self.headers = {} if last_event_id is None else {"last-event-id": last_event_id}


class _FakeThread:
    """Stands in for the runner thread: records that it was 'started' but runs no
    real work, so the admitted slot stays held (as it would mid-run) for assertions."""

    started: list["_FakeThread"] = []

    def __init__(self, target=None, args=(), daemon=None):
        self._target, self._args = target, args

    def start(self):
        _FakeThread.started.append(self)

    def is_alive(self):
        return False


def _setup(monkeypatch, tmp_path, capacity=1):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    monkeypatch.setattr(
        runs_route, "load_config",
        lambda: LeaConfig(model="m", max_turns=3, lea_root=tmp_path, max_spend_usd=None),
    )
    _FakeThread.started = []
    monkeypatch.setattr(runs_route, "Thread", _FakeThread)
    runbroker._brokers.clear()  # module-global; keep brokers from leaking across tests
    reg = RunRegistry(max_concurrent=capacity)
    monkeypatch.setattr(runregistry, "registry", reg)
    return reg


def _new_run(session_id=None, message="prove it"):
    started = runs_route.create_run(RunRequest(message=message, autonomous=True,
                                               session_id=session_id))
    return started["session_id"], started["run_id"]


def _instant_polls(monkeypatch):
    """Make the supersede poll spin without real time so timeouts are fast to test."""
    async def _no_sleep(*a, **k):
        return None
    monkeypatch.setattr(runs_route.asyncio, "sleep", _no_sleep)


def test_same_session_followup_supersedes_only_its_own_incumbent(tmp_path, monkeypatch):
    reg = _setup(monkeypatch, tmp_path, capacity=1)
    session_id, run1 = _new_run()
    _, run2 = _new_run(session_id=session_id)  # a second turn in the SAME session
    reg.try_admit(run1, session_id)            # run1 is the incumbent

    stopped: list[str] = []

    def fake_stop(rid):
        stopped.append(rid)
        reg.release(rid)  # mimic the incumbent's cooperative stop → run_lea finally

    monkeypatch.setattr(runs_route, "request_stop", fake_stop)

    resp = asyncio.run(runs_route.run_events(run2, _Req()))

    assert stopped == [run1], "supersede must stop exactly the session's incumbent"
    assert not reg.is_active(run1)
    assert reg.is_active(run2), "the follow-up must be admitted after the supersede"
    assert len(_FakeThread.started) == 1
    resp  # a StreamingResponse; not consumed


def test_a_different_sessions_run_is_never_superseded(tmp_path, monkeypatch):
    """The whole point of per-session supersede: a new chat gets a 409, it does NOT
    shoot down an unrelated chat's run."""
    reg = _setup(monkeypatch, tmp_path, capacity=1)
    reg.try_admit("run-A", "session-A")  # a different chat's run holds the slot
    _, run_b = _new_run()                # our new run is in its own fresh session

    stopped: list[str] = []
    monkeypatch.setattr(runs_route, "request_stop", lambda rid: stopped.append(rid))

    with pytest.raises(HTTPException) as exc:
        asyncio.run(runs_route.run_events(run_b, _Req()))

    assert exc.value.status_code == 409
    assert "at capacity" in exc.value.detail.lower()
    assert exc.value.headers.get("Retry-After")
    assert stopped == [], "a different session's run must not be stopped"
    assert reg.is_active("run-A"), "the unrelated run must still hold its slot"


def test_supersede_times_out_to_409_when_incumbent_wont_release(tmp_path, monkeypatch):
    reg = _setup(monkeypatch, tmp_path, capacity=1)
    session_id, run1 = _new_run()
    _, run2 = _new_run(session_id=session_id)
    reg.try_admit(run1, session_id)

    monkeypatch.setattr(runs_route, "request_stop", lambda rid: None)  # never releases
    _instant_polls(monkeypatch)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(runs_route.run_events(run2, _Req()))

    assert exc.value.status_code == 409
    assert "still finishing" in exc.value.detail.lower()
    assert reg.is_active(run1), "the un-stopped incumbent keeps its slot"
    assert not reg.is_active(run2)


def test_capacity_two_admits_two_independent_sessions(tmp_path, monkeypatch):
    reg = _setup(monkeypatch, tmp_path, capacity=2)
    reg.try_admit("run-A", "session-A")   # one slot of two in use
    _, run_b = _new_run()                 # a second, independent session

    resp = asyncio.run(runs_route.run_events(run_b, _Req()))

    assert reg.is_active(run_b), "a second session should be admitted at capacity 2"
    assert reg.active_count() == 2
    assert len(_FakeThread.started) == 1
    resp
