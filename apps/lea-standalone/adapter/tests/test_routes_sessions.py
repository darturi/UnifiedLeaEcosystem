"""D2: the sessions route hydrates code_steps from git on reload.

The DB stores each code_step as a pointer (commit_sha + path); git owns the proof
text (C1/D7). The live SSE stream attaches `code` as steps happen, but a reopened
session reads from the DB — so the route must hydrate each step via
`GitStore.snapshot`. These tests pin that, and that the store itself stays
git-free (pointer-only).
"""

import asyncio

import pytest
from fastapi import HTTPException
from lea.interface import CheckResult, VerifyResult

from app import db, store
from app.config import LeaConfig
from app.gitstore import GitStore
from app.routes import sessions as sessions_route
from app.routes.sessions import FileWriteRequest, PathRequest


def _seed_session_with_commit(tmp_path):
    gs = GitStore(tmp_path / "workspace" / "proofs")
    session = store.create_session("S")
    repo = gs.init_session(session["id"])
    proof = repo / "Lea" / "Misc" / "p.lean"
    proof.parent.mkdir(parents=True, exist_ok=True)
    proof.write_text("import Mathlib\n\ntheorem t : True := by trivial\n")
    sha = gs.commit_write(session["id"], turn=1, author="agent", tool="write_file")
    run = store.create_run(session["id"], "m", None, 3)
    store.add_code_step(session["id"], run["id"], "Lea/Misc/p.lean",
                        commit_sha=sha, author="agent", turn=1, check_status="ok")
    return session, sha


def test_session_detail_hydrates_code_from_git(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    session, sha = _seed_session_with_commit(tmp_path)
    monkeypatch.setattr(sessions_route, "load_config",
                        lambda: LeaConfig(model="m", max_turns=3, lea_root=tmp_path))

    detail = sessions_route.session_detail(session["id"])

    step = detail["code_steps"][0]
    assert "theorem t : True" in step["code"]   # hydrated from git
    assert step["commit_sha"] == sha

    # the store stays git-free: the raw DB row is a pointer with no content
    raw = store.session_detail(session["id"])["code_steps"][0]
    assert "code" not in raw


def test_hydration_is_graceful_on_a_bad_pointer(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    session = store.create_session("S")
    GitStore(tmp_path / "workspace" / "proofs").init_session(session["id"])
    run = store.create_run(session["id"], "m", None, 3)
    # a pointer whose blob doesn't exist (e.g. repo wiped) must not 500 the read
    store.add_code_step(session["id"], run["id"], "Lea/Misc/missing.lean",
                        commit_sha="0" * 40, author="agent", turn=1)
    monkeypatch.setattr(sessions_route, "load_config",
                        lambda: LeaConfig(model="m", max_turns=3, lea_root=tmp_path))

    detail = sessions_route.session_detail(session["id"])

    assert detail["code_steps"][0]["code"] == ""


def _config_for(tmp_path):
    return lambda: LeaConfig(model="m", max_turns=3, lea_root=tmp_path)


def test_lean_check_backfills_verdict_onto_the_step(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    session, _ = _seed_session_with_commit(tmp_path)  # seeds a step with check_status="ok"
    monkeypatch.setattr(sessions_route, "load_config", _config_for(tmp_path))
    monkeypatch.setattr(sessions_route, "interface_check",
                        lambda p: CheckResult(p, "error", "p.lean:2:0: error: boom"))

    result = sessions_route.lean_check_session(session["id"], PathRequest(path="Lea/Misc/p.lean"))

    assert result["status"] == "error" and result["path"] == "Lea/Misc/p.lean"
    # the verdict is back-filled onto the file's latest code_step (canvas + status)
    step = store.latest_code_step_for_path(session["id"], "Lea/Misc/p.lean")
    assert step["check_status"] == "error"
    assert store.session_detail(session["id"])["status"] == "error"


def test_verify_returns_the_verdict_for_the_default_file(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    session, _ = _seed_session_with_commit(tmp_path)
    monkeypatch.setattr(sessions_route, "load_config", _config_for(tmp_path))
    monkeypatch.setattr(sessions_route, "interface_verify", lambda p: VerifyResult("ok", None))

    result = sessions_route.verify_session(session["id"], PathRequest())  # default = latest step

    assert result["status"] == "ok"
    assert result["path"] == "Lea/Misc/p.lean"


def test_check_404_when_session_has_no_proof_file(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    session = store.create_session("empty")
    monkeypatch.setattr(sessions_route, "load_config", _config_for(tmp_path))

    with pytest.raises(HTTPException) as exc:
        sessions_route.lean_check_session(session["id"], PathRequest())
    assert exc.value.status_code == 404


def test_write_file_creates_user_step_and_edit_note(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    session = store.create_session("Canvas edit")
    monkeypatch.setattr(sessions_route, "load_config", _config_for(tmp_path))
    code = "import Mathlib\n\ntheorem mine : True := by trivial\n"

    result = sessions_route.write_file_session(
        session["id"], FileWriteRequest(path="Lea/Misc/Mine.lean", content=code, note="hand-wrote it"))

    assert result["unchanged"] is False
    step = result["code_step"]
    assert step["author"] == "user" and step["run_id"] is None  # run-less first-class step (D9)
    assert step["code"] == code
    # the edit landed on disk (filesystem-canonical) and is committed
    repo = GitStore(tmp_path / "workspace" / "proofs").session_repo(session["id"])
    assert (repo / "Lea" / "Misc" / "Mine.lean").read_text() == code
    # the note is a linked edit_note message (D11)
    assert result["note"]["kind"] == "edit_note"
    assert result["note"]["commit_sha"] == step["commit_sha"]
    # it shows up in the session timeline as a user step
    assert store.session_detail(session["id"])["code_steps"][-1]["author"] == "user"


def test_write_file_no_op_save_creates_no_step(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    session = store.create_session("S")
    monkeypatch.setattr(sessions_route, "load_config", _config_for(tmp_path))
    req = FileWriteRequest(path="Lea/Misc/P.lean", content="theorem p : True := by trivial\n")

    sessions_route.write_file_session(session["id"], req)
    again = sessions_route.write_file_session(session["id"], req)  # identical content

    assert again["unchanged"] is True and again["code_step"] is None
    # only the first save made a step
    assert len(store.session_detail(session["id"])["code_steps"]) == 1


def test_session_list_events_emits_initial_sessions_changed(tmp_path, monkeypatch):
    # The feed fires `sessions_changed` on connect (digest goes None -> current), so
    # a client that connects mid-change still re-syncs. We pull only the first frame;
    # the generator yields it before its first sleep.
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()

    async def first_frame():
        response = await sessions_route.session_list_events()
        return await response.body_iterator.__anext__()

    first = asyncio.run(first_frame())

    assert "event: sessions_changed" in first


def test_export_session_returns_a_zip_of_its_files(tmp_path, monkeypatch):
    # #14: a loose session's files download as a zip (its own proofs/<id> repo).
    import io
    import zipfile

    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    session, _ = _seed_session_with_commit(tmp_path)  # writes Lea/Misc/p.lean
    monkeypatch.setattr(sessions_route, "load_config", _config_for(tmp_path))

    response = sessions_route.export_session(session["id"])

    assert response.media_type == "application/zip"
    assert response.headers["Content-Disposition"] == 'attachment; filename="s.zip"'  # slug of "S"
    names = zipfile.ZipFile(io.BytesIO(response.body)).namelist()
    assert any(n.endswith("Lea/Misc/p.lean") for n in names)
    assert not any("/.git/" in n for n in names)  # .git excluded by export_zip


def test_export_session_404_when_missing_or_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    monkeypatch.setattr(sessions_route, "load_config", _config_for(tmp_path))

    # unknown session
    with pytest.raises(HTTPException) as exc:
        sessions_route.export_session("no-such-session")
    assert exc.value.status_code == 404

    # a session that has never written a file → no repo on disk → 404 (not a 500)
    empty = store.create_session("nothing here")
    with pytest.raises(HTTPException) as exc:
        sessions_route.export_session(empty["id"])
    assert exc.value.status_code == 404


def test_export_session_filename_falls_back_to_id(tmp_path, monkeypatch):
    # A title that slugifies to nothing falls back to a session-<id8> filename.
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    gs = GitStore(tmp_path / "workspace" / "proofs")
    session = store.create_session("!!!")  # slug → "" → fallback
    repo = gs.init_session(session["id"])
    (repo / "note.txt").write_text("hi")
    gs.commit_write(session["id"], turn=None, author="user", tool="edit")
    monkeypatch.setattr(sessions_route, "load_config", _config_for(tmp_path))

    response = sessions_route.export_session(session["id"])
    expected = f'attachment; filename="session-{session["id"][:8]}.zip"'
    assert response.headers["Content-Disposition"] == expected


def test_write_file_rejects_path_escape(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    session = store.create_session("S")
    monkeypatch.setattr(sessions_route, "load_config", _config_for(tmp_path))

    with pytest.raises(HTTPException) as exc:
        sessions_route.write_file_session(
            session["id"], FileWriteRequest(path="../../escape.lean", content="x"))
    assert exc.value.status_code == 400
