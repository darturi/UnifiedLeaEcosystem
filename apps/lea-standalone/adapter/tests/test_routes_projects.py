"""P3 tests: project CRUD routes (D31). Route functions are called directly (as the
other route tests do), with `load_config` patched so the proofs root is a tmp dir."""

import pytest
from fastapi import HTTPException

from app import db, store
from app.config import LeaConfig
from app.routes import projects as projects_route
from app.routes.projects import DocUpdate, ProjectCreate, ProjectUpdate, SessionCreate


def _setup(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    monkeypatch.setattr(
        projects_route, "load_config",
        lambda: LeaConfig(model="m", max_turns=3, lea_root=tmp_path, max_spend_usd=None),
    )
    return tmp_path / "workspace" / "proofs"


def test_create_lists_and_gets_a_project(tmp_path, monkeypatch):
    proofs = _setup(tmp_path, monkeypatch)

    created = projects_route.create_project(ProjectCreate(title="Real Analysis", description="ε–δ"))
    assert created["slug"] == "real-analysis"
    assert created["namespace"] == "Lea.RealAnalysis"
    assert (proofs / "Lea" / "RealAnalysis" / ".lea" / "blueprint.md").is_file()

    listed = projects_route.list_projects()["projects"]
    assert len(listed) == 1
    assert listed[0]["id"] == created["id"]
    assert listed[0]["session_count"] == 0

    detail = projects_route.get_project(created["id"])
    assert detail["id"] == created["id"]
    assert detail["sessions"] == []  # no sessions yet


def test_create_rejects_blank_title(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    with pytest.raises(HTTPException) as exc:
        projects_route.create_project(ProjectCreate(title="   "))
    assert exc.value.status_code == 400


def test_detail_includes_project_sessions(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    project = projects_route.create_project(ProjectCreate(title="Topology"))
    sess = store.create_session("a proof", project_id=project["id"])

    detail = projects_route.get_project(project["id"])
    assert [s["id"] for s in detail["sessions"]] == [sess["id"]]
    assert projects_route.list_projects()["projects"][0]["session_count"] == 1


def test_create_session_in_project(tmp_path, monkeypatch):
    # D23: a session created inside a project is tagged with project_id and appears
    # in the project's session list.
    _setup(tmp_path, monkeypatch)
    project = projects_route.create_project(ProjectCreate(title="Topology"))

    sess = projects_route.create_session_in_project(project["id"], SessionCreate(title="lemma A"))
    assert sess["project_id"] == project["id"]
    assert sess["title"] == "lemma A"
    assert [s["id"] for s in projects_route.get_project(project["id"])["sessions"]] == [sess["id"]]

    # blank title falls back; missing project → 404
    fallback = projects_route.create_session_in_project(project["id"], SessionCreate())
    assert fallback["title"] == "Untitled theorem"
    with pytest.raises(HTTPException) as exc:
        projects_route.create_session_in_project("nope", SessionCreate(title="x"))
    assert exc.value.status_code == 404


def test_update_edits_title_and_description(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    project = projects_route.create_project(ProjectCreate(title="Old"))

    updated = projects_route.update_project(
        project["id"], ProjectUpdate(title="New", description="now described")
    )
    assert updated["title"] == "New"
    assert updated["description"] == "now described"
    assert updated["slug"] == project["slug"]  # immutable


def test_delete_removes_repo_and_rows(tmp_path, monkeypatch):
    proofs = _setup(tmp_path, monkeypatch)
    project = projects_route.create_project(ProjectCreate(title="Doomed"))
    repo = proofs / "Lea" / "Doomed"
    assert repo.is_dir()

    result = projects_route.delete_project(project["id"])
    assert result["deleted"] is True
    assert not repo.exists()
    assert store.get_project(project["id"]) is None


def test_missing_project_is_404(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    for call in (
        lambda: projects_route.get_project("nope"),
        lambda: projects_route.update_project("nope", ProjectUpdate(title="x")),
        lambda: projects_route.delete_project("nope"),
        lambda: projects_route.get_instructions("nope"),
        lambda: projects_route.put_instructions("nope", DocUpdate(content="x")),
        lambda: projects_route.get_memory("nope"),
        lambda: projects_route.put_memory("nope", DocUpdate(content="x")),
    ):
        with pytest.raises(HTTPException) as exc:
            call()
        assert exc.value.status_code == 404


@pytest.mark.parametrize("doc", ["instructions", "memory"])
def test_doc_get_returns_seeded_then_roundtrips_put(tmp_path, monkeypatch, doc):
    # R1/R2: GET returns the seeded template; PUT writes+commits; GET returns the
    # new content; and the composed run context reflects the edit.
    proofs = _setup(tmp_path, monkeypatch)
    project = projects_route.create_project(ProjectCreate(title="Analysis"))
    get = getattr(projects_route, f"get_{doc}")
    put = getattr(projects_route, f"put_{doc}")

    seeded = get(project["id"])["content"]
    assert doc[:4].lower() in seeded.lower()  # "inst"/"memo" header present

    result = put(project["id"], DocUpdate(content="# Edited\n\n- a durable fact\n"))
    assert result["content"].startswith("# Edited")
    assert len(result["commit_sha"]) == 40  # a real commit landed

    assert get(project["id"])["content"] == "# Edited\n\n- a durable fact\n"
    on_disk = proofs / "Lea" / "Analysis" / ".lea" / f"{doc}.md"
    assert on_disk.read_text() == "# Edited\n\n- a durable fact\n"


def test_put_doc_feeds_composed_context(tmp_path, monkeypatch):
    # The edited Instructions/Memory must show up in the next run's context (D25/D26).
    from app import projects as project_service

    proofs = _setup(tmp_path, monkeypatch)
    project = projects_route.create_project(ProjectCreate(title="Analysis"))
    projects_route.put_instructions(project["id"], DocUpdate(content="Prove √2 is irrational."))
    projects_route.put_memory(project["id"], DocUpdate(content="- explicit witnesses preferred"))

    repo = proofs / "Lea" / "Analysis"
    msg = project_service.compose_context_message(store.get_project(project["id"]), repo)
    assert "Prove √2 is irrational." in msg["content"]
    assert "explicit witnesses preferred" in msg["content"]
