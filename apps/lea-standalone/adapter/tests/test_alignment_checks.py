"""Revision-bound Lea Check persistence and public status projection."""

import hashlib
import json

from app import alignment_checks, alignment_runner, alignment_store, db, store
from app.alignment_schemas import AlignmentCheckRequest, AlignmentReport, SourceBundle, normalize_report
from app.routes import alignment_checks as routes


def _fresh(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    session = store.create_session("Overleaf theorem", origin="overleaf")
    formalization = store.create_formalization(
        project_id=None,
        loose_session_id=session["id"],
        display_title="target",
        declaration_name="target",
        origin="overleaf",
        source_hash="a" * 64,
    )
    store.link_session_formalization(session["id"], formalization["id"])
    store.link_formalization_file(formalization["id"], "target.lean", "primary")
    store.add_code_step(
        session["id"], None, "target.lean",
        content="theorem target : True := by trivial",
        check_status="ok", formalization_id=formalization["id"],
    )
    return session, formalization


def _bundle(*, proof="", status="missing", target_kind="theorem", digest=None):
    payload = {
        "version": 2,
        "targetKey": "target",
        "targetKind": target_kind,
        "statement": "True.",
        "proof": proof,
        "proofAssociation": {
            "status": status,
            "method": "adjacent" if status == "associated" else "none",
            "sourceFile": "main.tex",
            "sourceStartLine": 5,
            "sourceEndLine": 7,
            "proofHash": "",
        },
        "statementLocation": {
            "sourceFile": "main.tex", "sourceStartLine": 1, "sourceEndLine": 4,
        },
        "uses": [], "context": "", "relevantSource": [], "mirror": None,
    }
    identity = {
        "version": payload["version"],
        "targetKey": payload["targetKey"],
        "targetKind": payload["targetKind"],
        "statement": payload["statement"],
        "proof": payload["proof"],
        "proofAssociation": {
            key: payload["proofAssociation"][key]
            for key in ("status", "method", "sourceFile", "proofHash")
        },
        "uses": payload["uses"],
        "context": payload["context"],
        "relevantSource": payload["relevantSource"],
        "mirror": payload["mirror"],
    }
    payload["bundleHash"] = digest or hashlib.sha256(
        json.dumps(identity, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()
    return SourceBundle.model_validate(payload)


def test_missing_source_proof_produces_a_durable_warning_without_model_call(tmp_path, monkeypatch):
    _, formalization = _fresh(tmp_path, monkeypatch)
    monkeypatch.setattr(alignment_checks, "load_config", lambda: type("C", (), {
        "model": "test/model", "model_kwargs": {}, "max_spend_usd": None,
    })())
    result = alignment_checks.start(
        formalization["id"], _bundle(), trigger="solver_terminal", solver_run_id=None,
    )
    assert result["lea_check"]["status"] == "warning"
    assert result["lea_check"]["report"]["approach_match"] == "insufficient_evidence"
    assert alignment_store.history(formalization["id"])[0]["cost_usd"] == 0


def test_automatic_start_is_idempotent_for_one_source_and_artifact_snapshot(tmp_path, monkeypatch):
    _, formalization = _fresh(tmp_path, monkeypatch)
    monkeypatch.setattr(alignment_checks, "load_config", lambda: type("C", (), {
        "model": "test/model", "model_kwargs": {}, "max_spend_usd": None,
    })())
    first = alignment_checks.start(formalization["id"], _bundle(), trigger="solver_terminal", solver_run_id=None)
    second = alignment_checks.start(formalization["id"], _bundle(), trigger="solver_terminal", solver_run_id=None)
    assert first["lea_check"]["id"] == second["lea_check"]["id"]
    assert len(alignment_store.history(formalization["id"])) == 1


def test_artifact_edit_supersedes_the_old_report(tmp_path, monkeypatch):
    session, formalization = _fresh(tmp_path, monkeypatch)
    monkeypatch.setattr(alignment_checks, "load_config", lambda: type("C", (), {
        "model": "test/model", "model_kwargs": {}, "max_spend_usd": None,
    })())
    bundle = _bundle()
    alignment_checks.start(formalization["id"], bundle, trigger="manual", solver_run_id=None)
    store.add_code_step(
        session["id"], None, "target.lean",
        content="theorem target : True := by\n  trivial",
        check_status="ok", formalization_id=formalization["id"],
    )
    current = alignment_checks.current(formalization["id"], bundle.bundleHash)
    assert current["lea_check"]["status"] == "N/A"
    assert current["lea_check"]["reason"] == "superseded"


def test_warning_evidence_overrides_an_inconsistent_approved_label():
    report = AlignmentReport.model_validate({
        "verdict": "approved",
        "summary": "Mismatch found.",
        "statement_match": "mismatch",
        "approach_match": "faithful",
        "findings": [], "caveats": [], "remaining_obligations": [],
    })
    assert normalize_report(report).verdict == "warning"


def test_route_returns_na_when_no_artifact(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    session = store.create_session("Empty")
    formalization = store.create_formalization(
        project_id=None, loose_session_id=session["id"], display_title="empty",
    )
    response = routes.start_alignment_check(
        formalization["id"],
        AlignmentCheckRequest(source_bundle=_bundle(), trigger="manual"),
    )
    assert response["lea_check"] == {"status": "N/A", "reason": "no_artifact", "current": True}


def test_rejects_a_bundle_hash_that_does_not_match_the_source(tmp_path, monkeypatch):
    _, formalization = _fresh(tmp_path, monkeypatch)
    monkeypatch.setattr(alignment_checks, "load_config", lambda: type("C", (), {
        "model": "test/model", "model_kwargs": {}, "max_spend_usd": None,
    })())
    try:
        alignment_checks.start(
            formalization["id"], _bundle(digest="a" * 64),
            trigger="manual", solver_run_id=None,
        )
    except ValueError as exc:
        assert "does not match" in str(exc)
    else:
        raise AssertionError("expected mismatched bundle hash to be rejected")


def test_definition_without_a_proof_is_sent_to_the_evaluator(tmp_path, monkeypatch):
    _, formalization = _fresh(tmp_path, monkeypatch)
    submitted = []
    monkeypatch.setattr(alignment_checks, "load_config", lambda: type("C", (), {
        "model": "test/model", "model_kwargs": {}, "max_spend_usd": None,
    })())
    monkeypatch.setattr(alignment_checks._EXECUTOR, "submit", lambda *args, **kwargs: submitted.append((args, kwargs)))
    result = alignment_checks.start(
        formalization["id"], _bundle(target_kind="definition"),
        trigger="solver_terminal", solver_run_id=None,
    )
    assert result["lea_check"]["status"] == "in-progress"
    assert len(submitted) == 1


def test_restart_pauses_incomplete_checks_and_keeps_them_retryable(tmp_path, monkeypatch):
    _, formalization = _fresh(tmp_path, monkeypatch)
    monkeypatch.setattr(alignment_checks, "load_config", lambda: type("C", (), {
        "model": "test/model", "model_kwargs": {}, "max_spend_usd": None,
    })())
    monkeypatch.setattr(alignment_checks._EXECUTOR, "submit", lambda *args, **kwargs: None)
    created = alignment_checks.start(
        formalization["id"], _bundle(proof="Trivial.", status="associated"),
        trigger="solver_terminal", solver_run_id=None,
    )
    assert created["lea_check"]["status"] == "in-progress"
    assert alignment_store.recover_interrupted() == 1
    recovered = alignment_store.get(created["lea_check"]["id"])
    assert recovered["status"] == "paused"
    assert recovered["stop_reason"] == "adapter_restart"
    assert recovered["report"]["remaining_obligations"]


def test_evaluator_report_records_scope_usage_and_exact_revisions(tmp_path, monkeypatch):
    _, formalization = _fresh(tmp_path, monkeypatch)
    monkeypatch.setattr(alignment_checks, "load_config", lambda: type("C", (), {
        "model": "test/model", "model_kwargs": {}, "max_spend_usd": None,
    })())
    monkeypatch.setattr(alignment_checks._EXECUTOR, "submit", lambda *args, **kwargs: None)
    bundle = _bundle(proof="Trivial.", status="associated")
    created = alignment_checks.start(
        formalization["id"], bundle, trigger="solver_terminal", solver_run_id=None,
    )
    payload = {
        "verdict": "approved",
        "summary": "The statement and direct argument correspond.",
        "statement_match": "matches",
        "approach_match": "faithful",
        "matches": [{"summary": "Both use the same direct proof."}],
        "findings": [],
        "caveats": ["Lean makes the final proposition explicit."],
        "remaining_obligations": [],
        "limitations": ["This is a model-assisted semantic comparison."],
        "recommended_next_action": "No change is required.",
    }
    monkeypatch.setattr(
        alignment_runner, "_one_response",
        lambda *args, **kwargs: (json.dumps(payload), 11, 7, 0.125),
    )
    _, files = alignment_checks._snapshot(formalization["id"])
    alignment_runner.run(
        created["lea_check"]["id"], source_bundle=bundle.model_dump(), files=files,
        model="test/model", model_kwargs={},
    )

    check = alignment_store.get(created["lea_check"]["id"])
    assert check["status"] == "completed"
    assert check["report"]["scope"] == "statement_and_proof"
    assert check["report"]["evaluated_revision"]["source_hash"] == bundle.bundleHash
    assert check["report"]["evaluated_revision"]["artifact_content_hash"] == check["artifact_hash"]
    assert check["input_tokens"] == 11
    assert check["output_tokens"] == 7
    assert check["cost_usd"] == 0.125


def test_evaluator_schema_failure_retains_both_attempts_usage(tmp_path, monkeypatch):
    _, formalization = _fresh(tmp_path, monkeypatch)
    monkeypatch.setattr(alignment_checks, "load_config", lambda: type("C", (), {
        "model": "test/model", "model_kwargs": {}, "max_spend_usd": None,
    })())
    monkeypatch.setattr(alignment_checks._EXECUTOR, "submit", lambda *args, **kwargs: None)
    bundle = _bundle(proof="Trivial.", status="associated")
    created = alignment_checks.start(
        formalization["id"], bundle, trigger="solver_terminal", solver_run_id=None,
    )
    monkeypatch.setattr(
        alignment_runner, "_one_response",
        lambda *args, **kwargs: ("not a JSON report", 3, 2, 0.05),
    )
    _, files = alignment_checks._snapshot(formalization["id"])
    alignment_runner.run(
        created["lea_check"]["id"], source_bundle=bundle.model_dump(), files=files,
        model="test/model", model_kwargs={},
    )

    check = alignment_store.get(created["lea_check"]["id"])
    assert check["status"] == "failed"
    assert check["verdict"] == "error"
    assert check["input_tokens"] == 6
    assert check["output_tokens"] == 4
    assert check["cost_usd"] == 0.1
    assert check["report"]["confidence"] == "low"
    assert check["report"]["evaluated_revision"]["source_hash"] == bundle.bundleHash
