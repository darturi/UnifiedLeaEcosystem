"""HTTP API for starting, polling, retrying, and inspecting Lea Check reports."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import alignment_checks as service, alignment_store, store
from ..alignment_schemas import AlignmentCheckRequest


router = APIRouter()


@router.post("/api/formalizations/{formalization_id}/alignment-checks", status_code=202)
def start_alignment_check(formalization_id: str, request: AlignmentCheckRequest) -> dict:
    try:
        return service.start(
            formalization_id,
            request.source_bundle,
            trigger=request.trigger,
            solver_run_id=request.solver_run_id,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/api/formalizations/{formalization_id}/alignment-checks/current")
def current_alignment_check(formalization_id: str, source_bundle_hash: str | None = None) -> dict:
    if store.get_formalization(formalization_id) is None:
        raise HTTPException(status_code=404, detail="Formalization not found")
    return service.current(formalization_id, source_bundle_hash)


@router.get("/api/formalizations/{formalization_id}/alignment-checks")
def alignment_check_history(formalization_id: str) -> dict:
    if store.get_formalization(formalization_id) is None:
        raise HTTPException(status_code=404, detail="Formalization not found")
    return {
        "alignment_checks": [service.public(item, current=False)["lea_check"] for item in alignment_store.history(formalization_id)]
    }


@router.post("/api/alignment-checks/{check_id}/retry", status_code=202)
def retry_alignment_check(check_id: str) -> dict:
    prior = alignment_store.get(check_id)
    if prior is None:
        raise HTTPException(status_code=404, detail="Lea Check not found")
    try:
        from ..alignment_schemas import SourceBundle

        return service.start(
            prior["formalization_id"],
            SourceBundle.model_validate(prior["source_bundle"]),
            trigger="retry",
            solver_run_id=prior.get("solver_run_id"),
            retry_of=check_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

