"""Project CRUD endpoints (D31).

The DB index half lives in `store`; the directory/repo half (provision + delete)
lives in the `projects` service. These routes are the composition layer: they
resolve the proofs root from config, then delegate. A project's proof/node counts
+ status mix are derived from live Lean state in later slices (the blueprint
graph), so detail here is just meta + the project's sessions.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..config import load_config
from .. import blueprint as blueprint_doc
from .. import graph as graph_service
from .. import projects as project_service
from .. import store
from .. import uploads

router = APIRouter()


class ProjectCreate(BaseModel):
    title: str
    description: str | None = None


class ProjectUpdate(BaseModel):
    title: str | None = None
    description: str | None = None


class SessionCreate(BaseModel):
    title: str | None = None


class DocUpdate(BaseModel):
    content: str


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


@router.post("/api/projects/{project_id}/sessions", status_code=201)
def create_session_in_project(project_id: str, request: SessionCreate) -> dict:
    """Create a session that lives inside the project (D23). The session is tagged
    with `project_id`; the run it later starts resolves the shared project repo +
    namespace from that tag (the bridge does this, D24/D25). Proofs land in
    `proofs/Lea/<Project>/` from turn 1, able to import sibling lemmas."""
    project = store.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    title = (request.title or "").strip() or "Untitled theorem"
    return store.create_session(title, project_id=project_id)


# ── Instructions & Memory: the two user/agent-editable .lea/*.md docs (R1/R2) ────
# Raw markdown in, raw markdown out. Instructions (D25) is user-authored; Memory
# (D26) is co-authored — the agent also writes memory.md with its own write_file
# during a run. Both GETs return the seeded template when never edited; both PUTs
# write+commit and the new content feeds the next run's composed context.


def _get_doc(project_id: str, name: str) -> dict:
    project = store.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"content": project_service.read_doc(project, _proofs_root(), name)}


def _put_doc(project_id: str, name: str, content: str) -> dict:
    project = store.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    sha = project_service.write_doc(project, _proofs_root(), name, content)
    return {"content": content, "commit_sha": sha}


@router.get("/api/projects/{project_id}/instructions")
def get_instructions(project_id: str) -> dict:
    return _get_doc(project_id, "instructions.md")


@router.put("/api/projects/{project_id}/instructions")
def put_instructions(project_id: str, request: DocUpdate) -> dict:
    return _put_doc(project_id, "instructions.md", request.content)


@router.get("/api/projects/{project_id}/memory")
def get_memory(project_id: str) -> dict:
    return _get_doc(project_id, "memory.md")


@router.put("/api/projects/{project_id}/memory")
def put_memory(project_id: str, request: DocUpdate) -> dict:
    return _put_doc(project_id, "memory.md", request.content)


# ── Blueprint: the canonical .lea/blueprint.md decomposition (T1, D28) ────────────
# Same raw-markdown GET/PUT as the other docs, but each response also carries the
# parser's advisory `warnings` (duplicate keys, missing/unknown kind, dangling edges)
# so the authoring view can flag structure problems without blocking the save. The
# parsed graph (nodes + derived status) is a separate `/graph` endpoint in T2.


@router.get("/api/projects/{project_id}/blueprint")
def get_blueprint(project_id: str) -> dict:
    project = _require_project(project_id)
    content = project_service.read_doc(project, _proofs_root(), "blueprint.md")
    return {"content": content, "warnings": blueprint_doc.validate(content)}


@router.put("/api/projects/{project_id}/blueprint")
def put_blueprint(project_id: str, request: DocUpdate) -> dict:
    project = _require_project(project_id)
    sha = project_service.write_doc(project, _proofs_root(), "blueprint.md", request.content)
    return {"content": request.content, "commit_sha": sha, "warnings": blueprint_doc.validate(request.content)}


@router.get("/api/projects/{project_id}/graph")
def get_graph(project_id: str) -> dict:
    # T2: parse the blueprint + derive each node's live status and session
    # attribution (D28/D29). Cheap — reuses stored verdicts, never recompiles.
    project = _require_project(project_id)
    return graph_service.build_graph(project, _proofs_root())


# ── Files: upload / list / download / delete (S1/S2, D27) ────────────────────────
# Uploaded reference docs land in the project repo's .lea/files/ (git-versioned) and
# are indexed in project_files; Tier-2 (.pdf/.docx) also get a .txt sidecar the agent
# reads. The bytes are canonical in git — these rows are the pointer + metadata.

_UPLOAD_ERROR_STATUS = {"too_large": 413, "unsupported": 415}


def _require_project(project_id: str) -> dict:
    project = store.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


@router.get("/api/projects/{project_id}/files")
def list_files(project_id: str) -> dict:
    _require_project(project_id)
    return {"files": store.list_project_files(project_id)}


@router.post("/api/projects/{project_id}/files", status_code=201)
async def upload_file(project_id: str, file: UploadFile = File(...)) -> dict:
    project = _require_project(project_id)
    data = await file.read()
    try:
        return uploads.save_upload(
            project, _proofs_root(), file.filename or "file", data, mime=file.content_type
        )
    except uploads.UploadError as exc:
        raise HTTPException(status_code=_UPLOAD_ERROR_STATUS.get(exc.code, 400), detail=str(exc))


@router.get("/api/projects/{project_id}/files/{file_id}")
def download_file(project_id: str, file_id: str) -> FileResponse:
    project = _require_project(project_id)
    row = store.get_project_file(file_id)
    if row is None or row["project_id"] != project_id:
        raise HTTPException(status_code=404, detail="File not found")
    path = uploads.file_disk_path(project, _proofs_root(), row)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="File bytes are missing")
    return FileResponse(path, media_type=row.get("mime") or "application/octet-stream", filename=row["filename"])


@router.delete("/api/projects/{project_id}/files/{file_id}")
def delete_file(project_id: str, file_id: str) -> dict:
    project = _require_project(project_id)
    row = store.get_project_file(file_id)
    if row is None or row["project_id"] != project_id:
        raise HTTPException(status_code=404, detail="File not found")
    uploads.delete_file(project, _proofs_root(), row)
    return {"deleted": True, "id": file_id}


@router.delete("/api/projects/{project_id}")
def delete_project(project_id: str) -> dict:
    if not project_service.delete_project(project_id, _proofs_root()):
        raise HTTPException(status_code=404, detail="Project not found")
    return {"deleted": True, "id": project_id}
