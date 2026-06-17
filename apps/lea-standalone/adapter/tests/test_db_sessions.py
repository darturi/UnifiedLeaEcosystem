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


def test_user_edit_verdict_overrides_after_a_run(tmp_path, monkeypatch):
    # P2: a user edit after the run completes changes the working-copy verdict
    _fresh_db(tmp_path, monkeypatch)
    session = store.create_session("Human takes over")
    run = store.create_run(session["id"], "gpt-4o", "openai", 3)
    store.add_code_step(session["id"], run["id"], "p.lean", commit_sha="a" * 40, check_status="ok")
    # user edits outside the run (run_id=None) and breaks it
    store.add_code_step(session["id"], None, "p.lean", commit_sha="b" * 40, author="user", check_status="error")
    assert store.session_detail(session["id"])["status"] == "error"
