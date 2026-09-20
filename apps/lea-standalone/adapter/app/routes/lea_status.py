"""Read-only current and historical solver assessments."""
from fastapi import APIRouter, HTTPException
from .. import lea_status as service

router = APIRouter()


@router.get("/api/formalizations/{formalization_id}/lea-status")
def current(formalization_id: str, source_identity_hash: str | None = None, source_bundle_hash: str | None = None):
    try:
        return {"lea_status": service.current(formalization_id, source_identity_hash, source_bundle_hash)}
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/api/formalizations/{formalization_id}/lea-status/updates")
def history(formalization_id: str, after: str | None = None, limit: int = 50):
    try:
        return service.history(formalization_id, after, limit)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
