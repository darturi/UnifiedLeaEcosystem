"""C2 tests: the edit-note link on `messages` (D11).

A user's canvas-edit explanation is a *normal* transcript message — no bespoke
channel — distinguished only by `kind='edit_note'` and a `commit_sha` pointing at
the edit's git commit. These tests pin the new column, the round-trip through
`store.add_message`/`session_detail`, the untouched default for ordinary
messages, and the CHECK that an edit_note must carry a commit_sha.
"""

import sqlite3

import pytest

from app import db, store


def _fresh_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()


def test_messages_has_commit_sha_column(tmp_path, monkeypatch):
    _fresh_db(tmp_path, monkeypatch)
    with sqlite3.connect(tmp_path / "test.sqlite3") as conn:
        cols = {row[1] for row in conn.execute("pragma table_info(messages)").fetchall()}
    assert "commit_sha" in cols
    assert "kind" in cols


def test_edit_note_round_trips(tmp_path, monkeypatch):
    _fresh_db(tmp_path, monkeypatch)
    session = store.create_session("Edit note")
    note = store.add_message(
        session["id"], "user", "Swapped the import to Mathlib.Tactic.",
        kind="edit_note", commit_sha="e" * 40,
    )
    assert note["kind"] == "edit_note"
    assert note["commit_sha"] == "e" * 40
    # it surfaces through the normal transcript read — no special plumbing (D11)
    detail = store.session_detail(session["id"])
    surfaced = detail["messages"][0]
    assert surfaced["kind"] == "edit_note"
    assert surfaced["commit_sha"] == "e" * 40


def test_ordinary_message_defaults_are_unchanged(tmp_path, monkeypatch):
    _fresh_db(tmp_path, monkeypatch)
    session = store.create_session("Plain")
    msg = store.add_message(session["id"], "assistant", "Working on it.")
    assert msg["kind"] == "assistant"
    assert msg["commit_sha"] is None


def test_edit_note_without_commit_sha_is_rejected(tmp_path, monkeypatch):
    _fresh_db(tmp_path, monkeypatch)
    session = store.create_session("Bad note")
    # the CHECK enforces D11 at the DB: an edit_note must link to a commit
    with pytest.raises(sqlite3.IntegrityError):
        store.add_message(session["id"], "user", "no commit attached", kind="edit_note")


def test_non_edit_note_may_omit_commit_sha(tmp_path, monkeypatch):
    _fresh_db(tmp_path, monkeypatch)
    session = store.create_session("Free")
    # the CHECK only constrains edit_notes; every other kind passes with NULL
    for kind in ("assistant", "user", "system", "result"):
        msg = store.add_message(session["id"], "user", "x", kind=kind)
        assert msg["commit_sha"] is None
