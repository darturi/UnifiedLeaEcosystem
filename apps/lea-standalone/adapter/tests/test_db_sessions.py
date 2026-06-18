"""C3 tests: session.status is the working-copy verdict, derived (D14/P2).

A session has no stored status column — its status is computed from the latest
code_step's check_status on every read, so it can never drift from the source of
truth. Run lifecycle (running/done/failed) is NOT here; it lives on runs.status.
These tests pin the vocabulary (empty/unchecked/ok/error), the latest-wins rule,
and that `list_sessions` and `session_detail` agree.
"""

import sqlite3

from app import db, store


def _fresh_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()


def _list_status(session_id):
    return next(s for s in store.list_sessions() if s["id"] == session_id)["status"]


def test_no_stored_status_column(tmp_path, monkeypatch):
    _fresh_db(tmp_path, monkeypatch)
    with sqlite3.connect(tmp_path / "test.sqlite3") as conn:
        cols = {row[1] for row in conn.execute("pragma table_info(sessions)").fetchall()}
    assert "status" not in cols  # derived on read, never stored


def test_session_with_no_code_is_empty(tmp_path, monkeypatch):
    _fresh_db(tmp_path, monkeypatch)
    session = store.create_session("Nothing yet")
    assert store.session_detail(session["id"])["status"] == "empty"
    assert _list_status(session["id"]) == "empty"


def test_status_follows_latest_code_step_verdict(tmp_path, monkeypatch):
    _fresh_db(tmp_path, monkeypatch)
    session = store.create_session("Verdict tracking")
    run = store.create_run(session["id"], "gpt-4o", "openai", 3)

    store.add_code_step(session["id"], run["id"], "p.lean", commit_sha="1" * 40, check_status="error")
    assert store.session_detail(session["id"])["status"] == "error"
    assert _list_status(session["id"]) == "error"

    # a later step's verdict wins — the working copy moved on
    store.add_code_step(session["id"], run["id"], "p.lean", commit_sha="2" * 40, check_status="ok")
    assert store.session_detail(session["id"])["status"] == "ok"
    assert _list_status(session["id"]) == "ok"


def test_step_without_verdict_is_unchecked(tmp_path, monkeypatch):
    _fresh_db(tmp_path, monkeypatch)
    session = store.create_session("Pending check")
    run = store.create_run(session["id"], "gpt-4o", "openai", 3)
    # D6: a write is committed before lean_check returns -> verdict not yet known
    store.add_code_step(session["id"], run["id"], "p.lean", commit_sha="3" * 40)
    assert store.session_detail(session["id"])["status"] == "unchecked"
    assert _list_status(session["id"]) == "unchecked"


def test_session_with_active_run_and_no_code_is_running(tmp_path, monkeypatch):
    # A freshly registered formalization (e.g. an Overleaf-driven run) has a
    # pending/running run but no code step yet -> it should read 'running' rather
    # than 'empty', so it surfaces as in-progress in the list the moment it starts.
    _fresh_db(tmp_path, monkeypatch)
    session = store.create_session("Just started")
    store.create_run(session["id"], "gpt-4o", "openai", 3)  # status defaults to 'pending'
    assert store.session_detail(session["id"])["status"] == "running"
    assert _list_status(session["id"]) == "running"


def test_active_run_does_not_override_an_existing_verdict(tmp_path, monkeypatch):
    # D14 still holds once code exists: the working-copy verdict wins even while a
    # run is active — run lifecycle does not leak into a session that has content.
    _fresh_db(tmp_path, monkeypatch)
    session = store.create_session("Has code, still running")
    run = store.create_run(session["id"], "gpt-4o", "openai", 3)  # stays 'pending'
    store.add_code_step(session["id"], run["id"], "p.lean", commit_sha="9" * 40, check_status="ok")
    assert store.session_detail(session["id"])["status"] == "ok"
    assert _list_status(session["id"]) == "ok"


def test_running_flips_to_verdict_when_run_finishes(tmp_path, monkeypatch):
    _fresh_db(tmp_path, monkeypatch)
    session = store.create_session("Lifecycle")
    run = store.create_run(session["id"], "gpt-4o", "openai", 3)
    assert _list_status(session["id"]) == "running"  # no code yet, active run
    store.update_run(run["id"], "success")
    assert _list_status(session["id"]) == "empty"  # run no longer active, still no code


def test_sessions_digest_changes_on_create_and_run_state(tmp_path, monkeypatch):
    _fresh_db(tmp_path, monkeypatch)
    empty = store.sessions_digest()
    session = store.create_session("D")
    after_create = store.sessions_digest()
    assert after_create != empty  # a new session moves the digest

    run = store.create_run(session["id"], "gpt-4o", "openai", 3)
    after_run = store.sessions_digest()
    assert after_run != after_create  # an active run moves it

    store.update_run(run["id"], "success")
    after_finish = store.sessions_digest()
    assert after_finish != after_run  # leaving the active set moves it too


def test_user_edit_verdict_overrides_after_a_run(tmp_path, monkeypatch):
    # P2: a user edit after the run completes changes the working-copy verdict
    _fresh_db(tmp_path, monkeypatch)
    session = store.create_session("Human takes over")
    run = store.create_run(session["id"], "gpt-4o", "openai", 3)
    store.add_code_step(session["id"], run["id"], "p.lean", commit_sha="a" * 40, check_status="ok")
    # user edits outside the run (run_id=None) and breaks it
    store.add_code_step(session["id"], None, "p.lean", commit_sha="b" * 40, author="user", check_status="error")
    assert store.session_detail(session["id"])["status"] == "error"
