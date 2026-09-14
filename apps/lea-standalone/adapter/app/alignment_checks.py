"""Snapshot, schedule, freshness, and public-state orchestration for Lea Check."""

from __future__ import annotations

import hashlib
import json
import re
from concurrent.futures import ThreadPoolExecutor

from . import alignment_store, formalizations, store
from .alignment_runner import PROMPT_VERSION, run as run_evaluator
from .alignment_schemas import SourceBundle
from .config import load_config


_HEX64 = re.compile(r"^[a-f0-9]{64}$")
_IMPORT_LINE = re.compile(r"(?m)^\s*import\s+([^\n-]+)")
_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="lea-alignment")


def _imported_modules(code: str) -> list[str]:
    modules: list[str] = []
    for match in _IMPORT_LINE.finditer(code or ""):
        for token in match.group(1).split():
            value = token.strip()
            if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_'.]*(?:\.[A-Za-z_][A-Za-z0-9_']*)*", value):
                modules.append(value)
    return modules


def _transitive_project_dependencies(project_id: str | None, roots: list[dict]) -> list[dict]:
    if not project_id:
        return []
    artifacts = store.list_artifacts_for_scope(project_id)
    by_module = {item.get("module_name"): item for item in artifacts if item.get("module_name")}
    queued = [module for item in roots for module in _imported_modules(item.get("code") or "")]
    seen_modules: set[str] = set()
    seen_paths = {str(item.get("path") or "") for item in roots}
    dependencies: list[dict] = []
    while queued:
        module = queued.pop(0)
        if module in seen_modules:
            continue
        seen_modules.add(module)
        artifact = by_module.get(module)
        if not artifact:
            continue
        path = str(artifact.get("path") or "")
        if not path or path in seen_paths:
            continue
        step = None
        formalization_id = artifact.get("formalization_id")
        if formalization_id:
            step = next(
                (item for item in store.current_code_steps_for_formalization(formalization_id) if item.get("path") == path),
                None,
            )
        if step is None:
            candidates = store.code_steps_for_project_path(project_id, path)
            step = candidates[0] if candidates else None
        if not step:
            continue
        seen_paths.add(path)
        dependency = {**step, "role": "dependency", "module_name": module}
        dependencies.append(dependency)
        queued.extend(_imported_modules(dependency.get("code") or ""))
    return dependencies


def _snapshot(formalization_id: str) -> tuple[dict, list[dict]] | None:
    current = formalizations.current_snapshot(formalization_id)
    if not current or not current.get("revision_token") or not current.get("files"):
        return None
    files = [*current["files"], *_transitive_project_dependencies(current.get("project_id"), current["files"])]
    refs = []
    for item in files:
        refs.append({
            "path": item.get("path") or "",
            "role": item.get("role") or "",
            "code_step_id": str(item.get("id") or ""),
            "blob_id": item.get("blob_id"),
            "sha256": item.get("blob_sha256") or "",
            "commit_sha": item.get("commit_sha") or "",
            "check_status": item.get("check_status"),
            "check_detail": item.get("check_detail"),
        })
    return {
        "revision_token": current["revision_token"],
        "files": refs,
        "validity_status": current.get("validity_status"),
    }, files


def _dependency_hash(snapshot: dict) -> str:
    parts = [
        f"{item['path']}:{item.get('sha256') or item.get('blob_id')}"
        for item in snapshot["files"] if item.get("role") == "dependency"
    ]
    return hashlib.sha256("\n".join(sorted(parts)).encode()).hexdigest()


def _source_bundle_hash(bundle: dict) -> str:
    """Reproduce the extension's version-2 mathematical-identity hash.

    Source line numbers are navigation metadata and deliberately excluded, so
    inserting unrelated prose above a theorem does not supersede its report.
    """
    proof_association = bundle.get("proofAssociation") or {}
    identity = {
        "version": bundle.get("version"),
        "targetKey": bundle.get("targetKey"),
        "targetKind": bundle.get("targetKind"),
        "statement": bundle.get("statement"),
        "proof": bundle.get("proof"),
        "proofAssociation": {
            "status": proof_association.get("status"),
            "method": proof_association.get("method"),
            "sourceFile": proof_association.get("sourceFile"),
            "proofHash": proof_association.get("proofHash"),
        },
        "uses": bundle.get("uses") or [],
        "context": bundle.get("context") or "",
        "relevantSource": bundle.get("relevantSource") or [],
        "mirror": bundle.get("mirror"),
    }
    encoded = json.dumps(identity, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


def _missing_proof_report(bundle: dict) -> dict:
    status = bundle.get("proofAssociation", {}).get("status") or "missing"
    return {
        "schema_version": 1,
        "verdict": "warning",
        "scope": "statement_only",
        "summary": "The Lean artifact can be checked as a statement, but no unambiguous LaTeX proof was available for method comparison.",
        "confidence": "high",
        "dimensions": {
            "statement": "inconclusive",
            "proof_strategy": "inconclusive",
            "coverage": "inconclusive",
            "dependencies": "inconclusive",
        },
        "statement_match": "uncertain",
        "approach_match": "insufficient_evidence",
        "matches": [],
        "findings": [{
            "severity": "warning",
            "category": "source_gap",
            "title": "Source proof unavailable",
            "detail": f"Proof association is {status}; Lea cannot approve proof-method fidelity without the author's argument.",
            "evidence": [{
                "side": "latex",
                "path": bundle.get("statementLocation", {}).get("sourceFile", ""),
                "start_line": bundle.get("statementLocation", {}).get("sourceStartLine") or None,
                "end_line": bundle.get("statementLocation", {}).get("sourceEndLine") or None,
                "excerpt": "",
            }],
        }],
        "caveats": [],
        "remaining_obligations": ["Associate a complete proof environment and rerun formalization."],
        "limitations": ["Lea Check did not compare proof methods because no single source proof could be associated."],
        "recommended_next_action": "Associate the intended LaTeX proof explicitly with `% lea: proof-for=target` and formalize again.",
    }


def _with_revision(report: dict, check: dict, *, scope: str | None = None) -> dict:
    return {
        **report,
        **({"scope": scope} if scope else {}),
        "evaluated_revision": {
            "source_hash": check.get("source_bundle_hash") or "",
            "artifact_commit": check.get("artifact_commit") or "",
            "artifact_content_hash": check.get("artifact_hash") or "",
            "dependency_hash": check.get("dependency_hash") or "",
        },
    }


def start(
    formalization_id: str,
    bundle_model: SourceBundle,
    *,
    trigger: str,
    solver_run_id: str | None,
    retry_of: str | None = None,
) -> dict:
    formalization = store.get_formalization(formalization_id)
    if formalization is None:
        raise LookupError("formalization not found")
    bundle = bundle_model.model_dump()
    if not _HEX64.fullmatch(bundle["bundleHash"]):
        raise ValueError("source bundle hash must be a SHA-256 hex digest")
    if bundle["bundleHash"] != _source_bundle_hash(bundle):
        raise ValueError("source bundle hash does not match its contents")
    captured = _snapshot(formalization_id)
    if captured is None:
        return {"lea_check": {"status": "N/A", "reason": "no_artifact", "current": True}}
    artifact_snapshot, files = captured
    artifact_hash = artifact_snapshot["revision_token"]
    artifact_commit = next(
        (item.get("commit_sha") for item in artifact_snapshot["files"] if item.get("role") == "primary" and item.get("commit_sha")),
        None,
    )
    dependency_hash = _dependency_hash(artifact_snapshot)
    config = load_config()
    provider = config.model.split("/", 1)[0] if "/" in config.model else None
    check, created = alignment_store.create(
        formalization_id=formalization_id,
        project_id=formalization.get("project_id"),
        session_id=(store.get_run(solver_run_id) or {}).get("session_id") if solver_run_id else formalization.get("loose_session_id"),
        solver_run_id=solver_run_id,
        trigger=trigger,
        source_bundle=bundle,
        artifact_snapshot=artifact_snapshot,
        artifact_hash=artifact_hash,
        artifact_commit=artifact_commit,
        dependency_hash=dependency_hash,
        prompt_version=PROMPT_VERSION,
        model=config.model,
        provider=provider,
        retry_of=retry_of,
    )
    if not created:
        return public(check, current=True)
    if config.max_spend_usd is not None and store.total_spend_usd() >= config.max_spend_usd:
        alignment_store.pause(
            check["id"],
            reason="budget_unavailable",
            report=_with_revision({
                "schema_version": 1,
                "verdict": "error",
                "scope": "partial_artifact",
                "summary": "Lea Check is paused because the configured spending limit has been reached.",
                "confidence": "low",
                "statement_match": "uncertain",
                "approach_match": "insufficient_evidence",
                "findings": [],
                "caveats": [],
                "remaining_obligations": ["Retry Lea Check after budget is available."],
                "limitations": ["No semantic comparison ran because evaluator budget was unavailable."],
                "recommended_next_action": "Increase or wait for available budget, then retry Lea Check.",
            }, check),
        )
    elif (
        bundle.get("targetKind") != "definition"
        and (
            bundle.get("proofAssociation", {}).get("status") != "associated"
            or not bundle.get("proof", "").strip()
        )
    ):
        alignment_store.complete(
            check["id"], report=_with_revision(_missing_proof_report(bundle), check),
            input_tokens=0, output_tokens=0, cost_usd=0.0,
        )
    else:
        _EXECUTOR.submit(
            run_evaluator,
            check["id"],
            source_bundle=bundle,
            files=files,
            model=config.model,
            model_kwargs=config.model_kwargs,
        )
    return public(alignment_store.get(check["id"]), current=True)


def current(formalization_id: str, source_bundle_hash: str | None = None) -> dict:
    captured = _snapshot(formalization_id)
    history = alignment_store.history(formalization_id)
    if captured is None:
        return {"lea_check": {"status": "N/A", "reason": "no_artifact", "current": True}}
    snapshot, _ = captured
    dependency_hash = _dependency_hash(snapshot)
    if source_bundle_hash:
        check = alignment_store.latest_for_snapshot(
            formalization_id, source_bundle_hash, snapshot["revision_token"], dependency_hash,
        )
    else:
        check = next((item for item in history if item["artifact_hash"] == snapshot["revision_token"]), None)
    if check:
        return public(check, current=True)
    return {
        "lea_check": {
            "status": "N/A",
            "reason": "superseded" if history else "not_evaluated",
            "current": True,
            "history_count": len(history),
        }
    }


def public(check: dict | None, *, current: bool) -> dict:
    if not check:
        return {"lea_check": {"status": "N/A", "reason": "not_evaluated", "current": current}}
    status = check["status"]
    value = {
        "pending": "in-progress", "running": "in-progress", "paused": "paused",
        "failed": "error", "completed": check.get("verdict") or "error",
    }.get(status, "error")
    phase = "queued" if status == "pending" else "evaluating" if status == "running" else "settled"
    report = check.get("report") if isinstance(check.get("report"), dict) else None
    findings = report.get("findings") if report and isinstance(report.get("findings"), list) else []
    warning_count = sum(1 for item in findings if isinstance(item, dict) and item.get("severity") == "warning")
    caveat_count = (
        sum(1 for item in findings if isinstance(item, dict) and item.get("severity") == "caveat")
        + (len(report.get("caveats")) if report and isinstance(report.get("caveats"), list) else 0)
    )
    return {
        "lea_check": {
            "id": check["id"],
            "status": value,
            "phase": phase,
            "current": current,
            "reason": check.get("stop_reason") or ("evaluation_failed" if status == "failed" else None),
            "report": report,
            "report_available": report is not None,
            "summary": report.get("summary") if report else None,
            "warning_count": warning_count,
            "caveat_count": caveat_count,
            "error": check.get("error"),
            "source_bundle_hash": check.get("source_bundle_hash"),
            "artifact_hash": check.get("artifact_hash"),
            "artifact_commit": check.get("artifact_commit"),
            "dependency_hash": check.get("dependency_hash"),
            "target_kind": check.get("target_kind"),
            "target_label": check.get("target_label"),
            "report_schema_version": check.get("report_schema_version", 1),
            "attempt": check.get("attempt"),
            "trigger": check.get("trigger"),
            "model": check.get("model"),
            "usage": {
                "input_tokens": check.get("input_tokens", 0),
                "output_tokens": check.get("output_tokens", 0),
                "cost_usd": check.get("cost_usd", 0.0),
            },
            "created_at": check.get("created_at"),
            "completed_at": check.get("completed_at"),
        }
    }
