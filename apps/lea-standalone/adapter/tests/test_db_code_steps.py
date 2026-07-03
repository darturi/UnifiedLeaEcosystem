"""C1 tests: the slimmed v2 `code_steps` schema (D5/D7/D8).

A code_step is no longer the proof *text* — git owns content. A row is a pointer
(`commit_sha` + `path`) plus presentation metadata (author, verdict, summary).
These tests pin that shape on a fresh DB: the columns present/absent, the
NOT NULL on `commit_sha`, the nullable `run_id`, and the round-trip through
`store.add_code_step`.
"""

import sqlite3

import pytest

from app import db, store


def _fresh_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()


def _columns(db_path):
    with sqlite3.connect(db_path) as conn:
        return {row[1] for row in conn.execute("pragma table_info(code_steps)").fetchall()}


def test_schema_is_a_git_pointer_not_content(tmp_path, monkeypatch):
    _fresh_db(tmp_path, monkeypatch)
    cols = _columns(tmp_path / "test.sqlite3")
    # the pointer + verdict shape
    assert {"commit_sha", "author", "path", "check_status", "check_detail"} <= cols
    # content + projects columns are gone (clean rebuild, no backward compat)
    assert "code" not in cols
    assert "kind" not in cols
    assert "used_project_formalizations" not in cols


def test_commit_sha_is_not_null(tmp_path, monkeypatch):
    _fresh_db(tmp_path, monkeypatch)
    # every v2 step IS a git commit, so a NULL pointer is rejected at the DB level
    with pytest.raises(sqlite3.IntegrityError):
        with db.connect() as conn:
            conn.execute(
                "insert into code_steps (id, session_id, seq, author, path, commit_sha, created_at) "
                "values ('x', 's', 1, 'agent', 'p.lean', NULL, 't')"
            )


def test_run_id_is_nullable_for_user_edits(tmp_path, monkeypatch):
    _fresh_db(tmp_path, monkeypatch)
    session = store.create_session("Edit outside a run")
    # a user canvas edit (D9) has no run — run_id=None must be accepted
    step = store.add_code_step(
        session["id"], None, "workspace/proofs/p.lean",
        commit_sha="d" * 40, author="user",
    )
    assert step["run_id"] is None
    assert step["author"] == "user"


def test_author_cascade_round_trips_with_no_check_constraint(tmp_path, monkeypatch):
    """`author` is a free-text convention column, not a SQL CHECK enum
    (db.py: 'agent' | 'user' | 'cascade'). This pins that a third convention
    value -- the Overleaf lean pane's downstream re-verification steps,
    docs/FEATURE-overleaf-lean-pane-manual-edit.md -- round-trips exactly like
    'agent'/'user' with no migration, guarding against a future CHECK being
    added without updating that convention."""
    _fresh_db(tmp_path, monkeypatch)
    session = store.create_session("Cascade re-check")
    step = store.add_code_step(
        session["id"], None, "workspace/proofs/Lea/P/dependent.lean",
        commit_sha="e" * 40, author="cascade",
        summary="Re-checked after edit to compactness_criterion",
        check_status="error", check_detail="unknown identifier: compactness_criterion",
    )
    assert step["run_id"] is None
    assert step["author"] == "cascade"
    assert step["check_status"] == "error"
    detail = store.session_detail(session["id"])
    assert detail["code_steps"][0]["author"] == "cascade"


def test_add_code_step_round_trips_pointer_and_verdict(tmp_path, monkeypatch):
    _fresh_db(tmp_path, monkeypatch)
    session = store.create_session("Round trip")
    run = store.create_run(session["id"], "gpt-4o", "openai", 3)
    step = store.add_code_step(
        session["id"], run["id"], "workspace/proofs/p.lean",
        commit_sha="abc123" + "0" * 34, author="agent",
        summary="wrote it", turn=4,
        check_status="error", check_detail="p.lean:2:0: error: unknown identifier",
    )
    assert step["commit_sha"] == "abc123" + "0" * 34
    assert step["author"] == "agent"
    assert step["turn"] == 4
    assert step["check_status"] == "error"
    assert step["check_detail"].startswith("p.lean:2:0")
    # and it's readable back through the session detail
    detail = store.session_detail(session["id"])
    assert detail["code_steps"][0]["commit_sha"] == step["commit_sha"]


def test_old_positional_code_call_fails_loudly(tmp_path, monkeypatch):
    _fresh_db(tmp_path, monkeypatch)
    session = store.create_session("Loud failure")
    run = store.create_run(session["id"], "gpt-4o", "openai", 3)
    # a v1-style call that passed file text as the 4th positional arg must raise,
    # never silently store proof text where a commit_sha belongs
    with pytest.raises(TypeError):
        store.add_code_step(
            session["id"], run["id"], "p.lean", "theorem t : True := by trivial",
        )


def test_seq_is_session_continuous(tmp_path, monkeypatch):
    _fresh_db(tmp_path, monkeypatch)
    s1 = store.create_session("S1")
    r1 = store.create_run(s1["id"], "gpt-4o", "openai", 3)
    a = store.add_code_step(s1["id"], r1["id"], "p.lean", commit_sha="1" * 40)
    b = store.add_code_step(s1["id"], r1["id"], "p.lean", commit_sha="2" * 40)
    assert (a["seq"], b["seq"]) == (1, 2)
    # a different session restarts the shared timeline seq (it's per-session, D14)
    s2 = store.create_session("S2")
    r2 = store.create_run(s2["id"], "gpt-4o", "openai", 3)
    c = store.add_code_step(s2["id"], r2["id"], "p.lean", commit_sha="3" * 40)
    assert c["seq"] == 1
