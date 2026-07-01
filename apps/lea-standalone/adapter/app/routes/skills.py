"""Skill Factory CRUD + assignment endpoints (v2.1.1 W2, D50).

A skill is a DB row (markdown `body` in a column), not a git file (D45); the
store half is in `store` (W1). These routes are the thin REST layer over it:
list/create/read/update/delete plus the scope assignment (`is_global` ∪ the
per-project join, D47). No prover coupling — run-time resolution to
`cfg.skills` is W3, GitHub import is W4.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import ghimport, store
from ..config import github_token

router = APIRouter()


class SkillCreate(BaseModel):
    name: str
    body: str = ""
    is_global: bool = False
    project_ids: list[str] = []


class SkillUpdate(BaseModel):
    name: str | None = None
    body: str | None = None


class SkillAssignment(BaseModel):
    is_global: bool = False
    project_ids: list[str] = []


class SkillImport(BaseModel):
    url: str
    is_global: bool = False
    project_ids: list[str] = []


@router.get("/api/skills")
def list_skills() -> dict:
    return {"skills": store.list_skills()}


@router.post("/api/skills", status_code=201)
def create_skill(request: SkillCreate) -> dict:
    """Author a skill. Scope is applied in the same call (D58: "Add → choose
    scope"): when `is_global` or `project_ids` are given, the assignment is set
    right after create so the row comes back fully scoped."""
    try:
        skill = store.create_skill(request.name, request.body)
        if request.is_global or request.project_ids:
            skill = store.set_skill_assignment(
                skill["id"], is_global=request.is_global, project_ids=request.project_ids
            )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    return skill


@router.post("/api/skills/import", status_code=201)
def import_skill(request: SkillImport) -> dict:
    """Add a skill from a GitHub link (D56): shallow-clone → snapshot the md into
    `body` → create + scope in one call. Uses the global GitHub token from Settings
    for private/rate-limited repos (public repos need none). A bad URL / clone
    failure / missing md is a 400."""
    try:
        imported = ghimport.fetch_skill(request.url, github_token())
    except ghimport.GitHubImportError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    try:
        skill = store.create_skill(
            imported.name, imported.body,
            source_url=imported.source_url, source_ref=imported.source_ref,
        )
        if request.is_global or request.project_ids:
            skill = store.set_skill_assignment(
                skill["id"], is_global=request.is_global, project_ids=request.project_ids
            )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    return skill


@router.get("/api/skills/{skill_id}")
def get_skill(skill_id: str) -> dict:
    skill = store.get_skill(skill_id)
    if skill is None:
        raise HTTPException(status_code=404, detail="Skill not found")
    return skill


@router.put("/api/skills/{skill_id}")
def update_skill(skill_id: str, request: SkillUpdate) -> dict:
    try:
        updated = store.update_skill(skill_id, name=request.name, body=request.body)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    if updated is None:
        raise HTTPException(status_code=404, detail="Skill not found")
    return updated


@router.put("/api/skills/{skill_id}/assignment")
def set_skill_assignment(skill_id: str, request: SkillAssignment) -> dict:
    """Set a skill's scope (D47): `is_global` plus the explicit per-project join.
    Replaces the join wholesale; unknown project ids are a 400."""
    try:
        updated = store.set_skill_assignment(
            skill_id, is_global=request.is_global, project_ids=request.project_ids
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    if updated is None:
        raise HTTPException(status_code=404, detail="Skill not found")
    return updated


@router.delete("/api/skills/{skill_id}")
def delete_skill(skill_id: str) -> dict:
    if not store.delete_skill(skill_id):
        raise HTTPException(status_code=404, detail="Skill not found")
    return {"deleted": True, "id": skill_id}
