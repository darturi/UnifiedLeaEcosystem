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


def test_resolve_git_loose_vs_project(tmp_path, monkeypatch):
    # D24: the resolver returns (GitStore, repo_key) so git ops hit the right repo —
    # loose roots at proofs/ keyed by session id; project roots at proofs/Lea keyed
    # by <Project> (the shared repo).
    _init_db(tmp_path, monkeypatch)
    proofs = tmp_path / "proofs"
    project = projects.provision_project("Graphs", proofs)
    loose = store.create_session("loose")
    in_proj = store.create_session("in", project_id=project["id"])

    gs_l, key_l = projects.resolve_git(loose["id"], proofs)
    gs_p, key_p = projects.resolve_git(in_proj["id"], proofs)
    assert gs_l.root == proofs and key_l == loose["id"]
    assert gs_p.root == proofs / "Lea" and key_p == "Graphs"
    assert projects.resolve_git("missing-session", proofs) is None


def test_compose_context_message(tmp_path, monkeypatch):
    # D25: one marked user message folding instructions + memory + blueprint + files.
    _init_db(tmp_path, monkeypatch)
    proofs = tmp_path / "proofs"
    project = projects.provision_project("Eps", proofs)
    repo = proofs / "Lea" / "Eps"
    (repo / ".lea" / "instructions.md").write_text("# Instructions\nProve continuity.")
    (repo / ".lea" / "files").mkdir()
    (repo / ".lea" / "files" / "paper.txt").write_text("notes")

    msg = projects.compose_context_message(project, repo)
    assert msg["role"] == "user"
    assert msg["content"].startswith(projects.CONTEXT_MARKER)
    assert "Lea.Eps" in msg["content"]
    assert "Prove continuity." in msg["content"]
    assert "`.lea/files/paper.txt`" in msg["content"]  # inventory line
    # D26: the agent is told, concretely, to keep memory.md current with edit_file.
    assert ".lea/memory.md" in msg["content"]
    assert "edit_file" in msg["content"]
    assert projects.is_context_message(msg) is True
    assert projects.is_context_message({"role": "user", "content": "hi"}) is False
    assert projects.compose_context_message(None, repo) is None


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
