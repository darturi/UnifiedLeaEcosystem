"""Project CRUD endpoints (D31).

The DB index half lives in `store`; the directory/repo half (provision + delete)
lives in the `projects` service. These routes are the composition layer: they
resolve the proofs root from config, then delegate. A project's proof/node counts
+ status mix are derived from live Lean state in later slices (the blueprint
graph), so detail here is just meta + the project's sessions.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..config import load_config
from .. import projects as project_service
from .. import store

router = APIRouter()


class ProjectCreate(BaseModel):
    title: str
    description: str | None = None


class ProjectUpdate(BaseModel):
    title: str | None = None
    description: str | None = None


def _proofs_root() -> Path:
    """The git proofs root (`<lea_root>/workspace/proofs`) project repos live under.
    Mirrors how the session routes build their GitStore root."""
    config = load_config()
    if config.lea_root is None:
        raise HTTPException(status_code=422, detail="lea_root is not configured")
    return config.lea_root / "workspace" / "proofs"


@router.get("/api/projects")
def list_projects() -> dict:
    return {"projects": store.list_projects()}


@router.post("/api/projects", status_code=201)
def create_project(request: ProjectCreate) -> dict:
    title = request.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Project title is required")
    return project_service.provision_project(title, _proofs_root(), description=request.description)


@router.get("/api/projects/{project_id}")
def get_project(project_id: str) -> dict:
    project = store.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return {**project, "sessions": store.list_project_sessions(project_id)}


@router.put("/api/projects/{project_id}")
def update_project(project_id: str, request: ProjectUpdate) -> dict:
    updated = store.update_project(
        project_id, title=request.title, description=request.description
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return updated


@router.delete("/api/projects/{project_id}")
def delete_project(project_id: str) -> dict:
    if not project_service.delete_project(project_id, _proofs_root()):
        raise HTTPException(status_code=404, detail="Project not found")
    return {"deleted": True, "id": project_id}
