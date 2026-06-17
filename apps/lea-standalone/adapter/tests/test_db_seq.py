"""C4 tests: one shared per-session timeline `seq` across messages + code_steps.

Both tables draw from a single monotonic per-session counter, so the thread is a
plain `ORDER BY seq` merge instead of the frontend pairing rows by index. These
tests pin the column on both tables, the interleaved monotonic numbering, the
merge order, and the per-session restart.
"""

import sqlite3

from app import db, store


def _fresh_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()


def _cols(db_path, table):
    with sqlite3.connect(db_path) as conn:
        return {row[1] for row in conn.execute(f"pragma table_info({table})").fetchall()}


def test_both_tables_have_seq(tmp_path, monkeypatch):
    _fresh_db(tmp_path, monkeypatch)
    assert "seq" in _cols(tmp_path / "test.sqlite3", "code_steps")
    assert "seq" in _cols(tmp_path / "test.sqlite3", "messages")
    # the old code-only counter name is gone — seq is the one ordering field
    assert "step_number" not in _cols(tmp_path / "test.sqlite3", "code_steps")


def test_seq_is_monotonic_across_both_tables(tmp_path, monkeypatch):
    _fresh_db(tmp_path, monkeypatch)
    session = store.create_session("Interleaved")
    run = store.create_run(session["id"], "gpt-4o", "openai", 3)
    # a realistic thread: user prompt, agent code, agent narration, agent code
    m1 = store.add_message(session["id"], "user", "prove it", run["id"])
    c1 = store.add_code_step(session["id"], run["id"], "p.lean", commit_sha="1" * 40)
    m2 = store.add_message(session["id"], "assistant", "trying norm_num", run["id"])
    c2 = store.add_code_step(session["id"], run["id"], "p.lean", commit_sha="2" * 40)
    assert [m1["seq"], c1["seq"], m2["seq"], c2["seq"]] == [1, 2, 3, 4]


def test_timeline_merges_by_seq(tmp_path, monkeypatch):
    _fresh_db(tmp_path, monkeypatch)
    session = store.create_session("Merge")
    run = store.create_run(session["id"], "gpt-4o", "openai", 3)
    store.add_message(session["id"], "user", "prove it", run["id"])
    store.add_code_step(session["id"], run["id"], "p.lean", commit_sha="a" * 40)
    store.add_message(session["id"], "assistant", "done", run["id"])

    detail = store.session_detail(session["id"])
    # both lists arrive ordered by seq; the frontend merges them by that one key
    merged = sorted(
        [("message", m["seq"]) for m in detail["messages"]]
        + [("code", c["seq"]) for c in detail["code_steps"]],
        key=lambda t: t[1],
    )
    assert [kind for kind, _ in merged] == ["message", "code", "message"]
    assert [s for _, s in merged] == [1, 2, 3]


def test_seq_restarts_per_session(tmp_path, monkeypatch):
    _fresh_db(tmp_path, monkeypatch)
    s1 = store.create_session("S1")
    store.add_message(s1["id"], "user", "hi")
    s2 = store.create_session("S2")
    first_in_s2 = store.add_message(s2["id"], "user", "hi")
    assert first_in_s2["seq"] == 1  # independent counter per session
