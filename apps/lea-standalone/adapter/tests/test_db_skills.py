import sqlite3

import pytest

from app import db, store


def _fresh_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()


def test_init_db_creates_skills_and_join_tables(tmp_path, monkeypatch):
    # W1 (D45): a skill is a DB row (markdown body in a column) + a per-project join.
    _fresh_db(tmp_path, monkeypatch)
    with sqlite3.connect(tmp_path / "test.sqlite3") as conn:
        skill_cols = {row[1] for row in conn.execute("pragma table_info(skills)").fetchall()}
        join_cols = {row[1] for row in conn.execute("pragma table_info(skill_projects)").fetchall()}
    assert {"id", "name", "slug", "body", "is_global", "source_url", "source_ref"} <= skill_cols
    assert {"skill_id", "project_id"} <= join_cols


def test_create_skill_derives_unique_slug_and_defaults(tmp_path, monkeypatch):
    _fresh_db(tmp_path, monkeypatch)
    s = store.create_skill("My First Skill!", "# How to prove\n…")
    assert s["slug"] == "my-first-skill"       # slugify(name): lower-kebab, punctuation dropped
    assert s["is_global"] is False             # default scope (D47): loose-gets-none
    assert s["project_ids"] == []
    assert s["source_url"] is None and s["source_ref"] is None
    # A second skill with the same name gets a distinct slug (unique constraint).
    again = store.create_skill("My First Skill!", "other")
    assert again["slug"] == "my-first-skill-2"
    assert store.get_skill_by_slug("my-first-skill")["id"] == s["id"]


def test_create_skill_requires_a_name(tmp_path, monkeypatch):
    _fresh_db(tmp_path, monkeypatch)
    with pytest.raises(ValueError):
        store.create_skill("   ", "body")


def test_create_skill_records_github_provenance(tmp_path, monkeypatch):
    # D56: source_url/source_ref are kept so the unit can be re-synced from source later.
    _fresh_db(tmp_path, monkeypatch)
    s = store.create_skill(
        "Imported", "body", is_global=True,
        source_url="https://github.com/you/repo", source_ref="main",
    )
    assert s["is_global"] is True
    assert s["source_url"] == "https://github.com/you/repo"
    assert s["source_ref"] == "main"


def test_update_skill_edits_name_and_body_but_not_slug(tmp_path, monkeypatch):
    # D45: the slug is the stable identifier (and the materialized filename stem) — it
    # must survive a rename untouched.
    _fresh_db(tmp_path, monkeypatch)
    s = store.create_skill("Original", "v1")
    slug = s["slug"]
    updated = store.update_skill(s["id"], name="Renamed", body="v2")
    assert updated["name"] == "Renamed"
    assert updated["body"] == "v2"
    assert updated["slug"] == slug
    # Passing None leaves a field untouched.
    again = store.update_skill(s["id"], body="v3")
    assert again["name"] == "Renamed"
    assert store.update_skill("no-such-id", name="x") is None


def test_assignment_replaces_join_and_rejects_unknown_projects(tmp_path, monkeypatch):
    _fresh_db(tmp_path, monkeypatch)
    p1 = store.create_project("proj-a", title="A")
    p2 = store.create_project("proj-b", title="B")
    s = store.create_skill("Scoped", "body")

    assigned = store.set_skill_assignment(s["id"], is_global=False, project_ids=[p1["id"], p2["id"]])
    assert assigned["is_global"] is False
    assert set(assigned["project_ids"]) == {p1["id"], p2["id"]}

    # A later assignment replaces the join wholesale (not append).
    reassigned = store.set_skill_assignment(s["id"], is_global=False, project_ids=[p2["id"]])
    assert reassigned["project_ids"] == [p2["id"]]

    # Unknown project ids are rejected, leaving the prior assignment intact.
    with pytest.raises(ValueError):
        store.set_skill_assignment(s["id"], is_global=False, project_ids=["ghost"])
    assert store.get_skill(s["id"])["project_ids"] == [p2["id"]]

    assert store.set_skill_assignment("no-such-id", is_global=True) is None


def test_skills_for_project_is_global_union_assigned(tmp_path, monkeypatch):
    # D47: a project resolves global ∪ assigned; an unassigned non-global skill never
    # shows up, and a loose (project-less) session resolves to none by definition.
    _fresh_db(tmp_path, monkeypatch)
    p1 = store.create_project("proj-a", title="A")
    p2 = store.create_project("proj-b", title="B")

    glob = store.create_skill("Global one", "g")
    store.set_skill_assignment(glob["id"], is_global=True)
    only_a = store.create_skill("A only", "a")
    store.set_skill_assignment(only_a["id"], is_global=False, project_ids=[p1["id"]])
    unassigned = store.create_skill("Nobody", "n")  # non-global, no join

    p1_ids = {s["id"] for s in store.skills_for_project(p1["id"])}
    p2_ids = {s["id"] for s in store.skills_for_project(p2["id"])}

    assert p1_ids == {glob["id"], only_a["id"]}      # global + its own assignment
    assert p2_ids == {glob["id"]}                    # only the global one
    assert unassigned["id"] not in p1_ids and unassigned["id"] not in p2_ids


def test_delete_skill_cascades_the_join(tmp_path, monkeypatch):
    _fresh_db(tmp_path, monkeypatch)
    p = store.create_project("proj-a", title="A")
    s = store.create_skill("Doomed", "body")
    store.set_skill_assignment(s["id"], is_global=False, project_ids=[p["id"]])

    assert store.delete_skill(s["id"]) is True
    assert store.delete_skill(s["id"]) is False
    assert store.get_skill(s["id"]) is None
    with sqlite3.connect(tmp_path / "test.sqlite3") as conn:
        remaining = conn.execute(
            "select count(*) from skill_projects where skill_id = ?", (s["id"],)
        ).fetchone()[0]
    assert remaining == 0


def test_deleting_a_project_drops_its_skill_assignments_not_the_skill(tmp_path, monkeypatch):
    _fresh_db(tmp_path, monkeypatch)
    p = store.create_project("proj-a", title="A")
    s = store.create_skill("Survivor", "body")
    store.set_skill_assignment(s["id"], is_global=False, project_ids=[p["id"]])

    store.delete_project_cascade(p["id"])

    # The skill itself survives; only the dangling assignment is gone.
    assert store.get_skill(s["id"])["project_ids"] == []
    with sqlite3.connect(tmp_path / "test.sqlite3") as conn:
        remaining = conn.execute(
            "select count(*) from skill_projects where project_id = ?", (p["id"],)
        ).fetchone()[0]
    assert remaining == 0


def test_list_skills_carries_assignment(tmp_path, monkeypatch):
    _fresh_db(tmp_path, monkeypatch)
    p = store.create_project("proj-a", title="A")
    a = store.create_skill("Alpha", "a")
    b = store.create_skill("Beta", "b")
    store.set_skill_assignment(b["id"], is_global=False, project_ids=[p["id"]])

    listed = {s["id"]: s for s in store.list_skills()}
    assert set(listed) == {a["id"], b["id"]}
    assert listed[a["id"]]["project_ids"] == []
    assert listed[b["id"]]["project_ids"] == [p["id"]]
