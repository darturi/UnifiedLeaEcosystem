

def test_artifacts_backfill_from_legacy_registry_markdown(tmp_path, monkeypatch):
    """PLAN-system-hardening 4.3: a pre-index project's registry markdown is
    imported into the artifacts table once, so the index answers for artifacts
    that predate 4.1. Backfilled rows have no run (session/run NULL); a second
    read adds nothing."""
    proofs = _setup(tmp_path, monkeypatch)
    project = projects_route.create_project(ProjectCreate(title="Analysis"))
    repo = proofs / "Lea" / "Analysis"
    (repo / "old_thm.lean").write_text("import Mathlib\n\ntheorem old_thm : True := by\n  trivial\n")

    registry = tmp_path / "workspace" / "projects" / f"{project['slug']}.md"
    registry.parent.mkdir(parents=True, exist_ok=True)
    registry.write_text(
        "# Lea Project\n\n## Theorem: old_thm\n\n"
        '<!-- lea:theorem name="old_thm" proof="workspace/proofs/Lea/Analysis/old_thm.lean" module="Lea.Analysis.old_thm" -->\n'
        "\n## Theorem: gone_thm\n\n"
        '<!-- lea:theorem name="gone_thm" proof="workspace/proofs/Lea/Analysis/gone_thm.lean" -->\n'
    )

    payload = projects_route.project_artifacts_by_slug(project["slug"])
    by_name = {row["declaration_name"]: row for row in payload["artifacts"]}
    assert by_name["old_thm"]["path"] == "old_thm.lean"
    assert by_name["old_thm"]["kind"] == "proof"
    assert by_name["old_thm"]["module_name"] == "Lea.Analysis.old_thm"
    assert by_name["old_thm"]["run_id"] is None
    assert by_name["gone_thm"]["kind"] is None

    again = projects_route.project_artifacts_by_slug(project["slug"])
    assert len(again["artifacts"]) == 2

    # And the ledger endpoint serves backfilled targets like any other.
    status = projects_route.project_target_status_by_slug(project["slug"], declarations="old_thm,gone_thm")
    by_status = {t["declaration_name"]: t for t in status["targets"]}
    assert by_status["old_thm"]["exists"] is True and by_status["old_thm"]["has_sorry"] is False
    assert by_status["gone_thm"]["recorded"] is True and by_status["gone_thm"]["exists"] is False
