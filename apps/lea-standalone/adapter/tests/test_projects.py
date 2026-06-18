"""P2 tests: the project service — provision the on-disk repo + seeds, resolve a
session's repo, delete with cascade. The proofs root is a tmp dir, so these never
touch the real workspace."""

from __future__ import annotations

import subprocess

from app import db, projects, store


def _init_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()


def test_slugify_and_unique_slug(tmp_path, monkeypatch):
    _init_db(tmp_path, monkeypatch)
    assert projects.slugify("Epsilon Delta!") == "epsilon-delta"
    assert projects.slugify("") == "project"

    proofs = tmp_path / "proofs"
    first = projects.provision_project("Epsilon Delta", proofs)
    assert first["slug"] == "epsilon-delta"
    # A second project with the same title gets a distinct slug.
    second = projects.provision_project("Epsilon Delta", proofs)
    assert second["slug"] == "epsilon-delta-2"


def test_provision_creates_repo_with_committed_seed_docs(tmp_path, monkeypatch):
    _init_db(tmp_path, monkeypatch)
    proofs = tmp_path / "proofs"

    project = projects.provision_project("Continuity", proofs, description="ε–δ work")
    assert project["namespace"] == "Lea.Continuity"
    assert project["repo_path"] == "proofs/Lea/Continuity"
    assert project["description"] == "ε–δ work"

    repo = proofs / "Lea" / "Continuity"
    assert (repo / ".git").is_dir()
    lea = repo / ".lea"
    for name in ("instructions.md", "memory.md", "blueprint.md"):
        assert (lea / name).is_file(), f"{name} should be seeded"
    # The blueprint seed points the agent at the real namespace.
    assert "Lea.Continuity.<decl>" in (lea / "blueprint.md").read_text()

    # The seeds are committed (not just on disk): the working tree is clean.
    status = subprocess.run(
        ["git", "status", "--porcelain"], cwd=repo, capture_output=True, text=True
    ).stdout.strip()
    assert status == ""
    # And there are two commits: the empty root + the seed commit.
    log = subprocess.run(
        ["git", "log", "--oneline"], cwd=repo, capture_output=True, text=True
    ).stdout.strip().splitlines()
    assert len(log) == 2


def test_repo_for_session_loose_vs_in_project(tmp_path, monkeypatch):
    _init_db(tmp_path, monkeypatch)
    proofs = tmp_path / "proofs"
    project = projects.provision_project("Graphs", proofs)

    loose = store.create_session("loose")
    in_proj = store.create_session("in project", project_id=project["id"])

    assert projects.repo_for_session(loose, proofs) == proofs / loose["id"]
    assert (
        projects.repo_for_session(in_proj, proofs, project)
        == proofs / "Lea" / "Graphs"
    )


def test_delete_project_removes_tree_and_cascades_rows(tmp_path, monkeypatch):
    _init_db(tmp_path, monkeypatch)
    proofs = tmp_path / "proofs"
    project = projects.provision_project("Doomed", proofs)
    pid = project["id"]
    repo = proofs / "Lea" / "Doomed"

    # A session + run inside the project, to prove the cascade reaches dependents.
    sess = store.create_session("s", project_id=pid)
    store.create_run(sess["id"], "gpt-4o", "openai", 3, project_id=pid)
    assert repo.is_dir()

    assert projects.delete_project(pid, proofs) is True
    assert not repo.exists()
    assert store.get_project(pid) is None
    assert store.get_session(sess["id"]) is None
    # Deleting a missing project is a no-op False.
    assert projects.delete_project(pid, proofs) is False
