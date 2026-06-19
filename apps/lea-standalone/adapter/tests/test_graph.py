"""Tests for the blueprint → graph derivation (T2, D28/D29).

Exercises status derivation (planned/stated/ready/proved/failed) and session
attribution against a scratch project repo + seeded code_steps — no Lean compile,
since status reuses the stored verdict."""

from __future__ import annotations

from app import db, graph, projects, store


def _init_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()


def _write_lean(repo, name: str, body: str) -> None:
    (repo / name).write_text(f"import Mathlib\n\nnamespace Lea.Demo\n\n{body}\n\nend Lea.Demo\n")


def _setup_demo(tmp_path, monkeypatch):
    """A Demo project with four declared files + a blueprint covering five nodes."""
    _init_db(tmp_path, monkeypatch)
    proofs = tmp_path / "proofs"
    project = projects.provision_project("Demo", proofs)
    repo = projects.project_repo_dir(project, proofs)

    _write_lean(repo, "helper.lean", "lemma helper : True := trivial")
    _write_lean(repo, "main.lean", "theorem main : True := trivial")
    _write_lean(repo, "sketch.lean", "lemma sketch : True := by sorry")
    # `dependent` is proved on its own but its node `uses: helper` (also proved).

    blueprint_md = (
        "# Blueprint — Demo\n\n"
        "## helper\n- kind: lemma\n- lean: `Lea.Demo.helper`\n\nA proved helper.\n\n"
        "## main\n- kind: theorem\n- lean: `Lea.Demo.main`\n- uses: helper\n\nFails its check.\n\n"
        "## sketch\n- kind: lemma\n- lean: `Lea.Demo.sketch`\n\nHas a sorry.\n\n"
        "## todo\n- kind: lemma\n- lean: `Lea.Demo.todo`\n- uses: helper\n\nNot built; dep proved.\n\n"
        "## orphan\n- kind: lemma\n\nNo decl, no deps.\n"
    )
    (repo / ".lea" / "blueprint.md").write_text(blueprint_md)
    return project, proofs


def _nodes_by_key(result):
    return {n["key"]: n for n in result["nodes"]}


def test_status_derivation_covers_all_kinds(tmp_path, monkeypatch):
    project, proofs = _setup_demo(tmp_path, monkeypatch)
    pid = project["id"]

    # helper: checked ok, no sorry → proved.
    sess = store.create_session("work", project_id=pid)["id"]
    store.add_code_step(sess, None, "helper.lean", commit_sha="a" * 40, check_status="ok")
    # main: latest check errored → failed (even though the body is trivial).
    store.add_code_step(sess, None, "main.lean", commit_sha="b" * 40, check_status="error")
    # sketch: has a `sorry` in its decl span → stated (regardless of any verdict).
    store.add_code_step(sess, None, "sketch.lean", commit_sha="c" * 40, check_status="ok")

    nodes = _nodes_by_key(graph.build_graph(project, proofs))
    assert nodes["helper"]["status"] == "proved"
    assert nodes["main"]["status"] == "failed"
    assert nodes["sketch"]["status"] == "stated"
    # todo: no decl in code, but its only dep (helper) is proved → ready.
    assert nodes["todo"]["status"] == "ready"
    # orphan: no `lean:` at all → planned.
    assert nodes["orphan"]["status"] == "planned"


def test_planned_when_decl_absent_and_no_ready_without_proved_deps(tmp_path, monkeypatch):
    project, proofs = _setup_demo(tmp_path, monkeypatch)
    # No code_steps at all: helper exists on disk but is unchecked → stated, not proved;
    # so todo (uses helper) is NOT ready, and main (uses helper) is stated too.
    nodes = _nodes_by_key(graph.build_graph(project, proofs))
    assert nodes["helper"]["status"] == "stated"   # decl present on disk, never checked
    assert nodes["main"]["status"] == "stated"     # decl present, unchecked, no sorry
    # `todo` names a decl no file declares → planned; and helper isn't proved, so the
    # ready overlay does NOT fire.
    assert nodes["todo"]["status"] == "planned"


def test_session_attribution_newest_first(tmp_path, monkeypatch):
    project, proofs = _setup_demo(tmp_path, monkeypatch)
    pid = project["id"]
    older = store.create_session("first pass", project_id=pid)["id"]
    newer = store.create_session("second pass", project_id=pid)["id"]
    # Two sessions both touch helper.lean; the newer insert is the latest verdict.
    store.add_code_step(older, None, "helper.lean", commit_sha="a" * 40, check_status="error")
    store.add_code_step(newer, None, "helper.lean", commit_sha="d" * 40, check_status="ok")

    nodes = _nodes_by_key(graph.build_graph(project, proofs))
    helper = nodes["helper"]
    # Newest verdict wins the status, and drives last_modified_by + sessions order.
    assert helper["status"] == "proved"
    assert helper["last_modified_by"] == newer
    assert [s["session_id"] for s in helper["sessions"]] == [newer, older]
    assert {s["title"] for s in helper["sessions"]} == {"first pass", "second pass"}
    # A node with no touching session has empty attribution.
    assert nodes["orphan"]["sessions"] == []
    assert nodes["orphan"]["last_modified_by"] is None


def test_edges_preserved_from_blueprint(tmp_path, monkeypatch):
    project, proofs = _setup_demo(tmp_path, monkeypatch)
    result = graph.build_graph(project, proofs)
    assert {"from": "main", "to": "helper"} in result["edges"]
    assert {"from": "todo", "to": "helper"} in result["edges"]
