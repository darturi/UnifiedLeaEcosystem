"""W3 unit tests: the skill resolution seam (skills_catalog). Materializing the
skills that resolve for a project to per-run temp .md files, and cleaning them up.
The bridge wiring (cfg.skills + finally cleanup) is covered in test_bridge.py."""

from pathlib import Path

from app import db, skills_catalog, store


def _setup(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()


def test_materialize_writes_slug_named_md_with_body(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    p = store.create_project("proj-a", title="A")
    glob = store.create_skill("Ring Tactics", "use `ring`")
    store.set_skill_assignment(glob["id"], is_global=True)
    scoped = store.create_skill("Proj Rules", "house style")
    store.set_skill_assignment(scoped["id"], is_global=False, project_ids=[p["id"]])

    paths, tempdir = skills_catalog.materialize_project_skills(p["id"])
    try:
        # One file per resolved skill, named <slug>.md so the prover's header reads
        # `## Skill: <slug>` cleanly (D45).
        names = {Path(x).name for x in paths}
        assert names == {"ring-tactics.md", "proj-rules.md"}
        bodies = {Path(x).name: Path(x).read_text() for x in paths}
        assert bodies["ring-tactics.md"] == "use `ring`"
        assert bodies["proj-rules.md"] == "house style"
        # The temp dir is NOT inside the project repo/proofs tree (D7/D8 — no git
        # pollution). It lives in the system temp area.
        assert "proofs" not in str(tempdir)
    finally:
        skills_catalog.cleanup(tempdir)


def test_materialize_no_skills_allocates_nothing(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    p = store.create_project("proj-a", title="A")
    # A non-global, unassigned skill must not resolve for the project.
    store.create_skill("Nobody", "n")

    paths, tempdir = skills_catalog.materialize_project_skills(p["id"])
    assert paths == []
    assert tempdir is None


def test_cleanup_removes_the_tempdir_and_tolerates_none(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    p = store.create_project("proj-a", title="A")
    s = store.create_skill("Only", "body")
    store.set_skill_assignment(s["id"], is_global=True)

    paths, tempdir = skills_catalog.materialize_project_skills(p["id"])
    assert Path(tempdir).is_dir()
    skills_catalog.cleanup(tempdir)
    assert not Path(tempdir).exists()
    skills_catalog.cleanup(None)  # no-op, no raise
