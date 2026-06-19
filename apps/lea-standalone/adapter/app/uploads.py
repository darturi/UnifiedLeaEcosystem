"""Project file uploads + tiered text extraction (D27, Slice 4).

The agent's native interface is files, so an uploaded reference doc just needs to
land in its working dir and be readable — no RAG, no embeddings. This module owns
that I/O path: validate → sanitize → write bytes into the project repo's
``.lea/files/`` → commit (git versions binaries fine, D8) → extract text by tier
into a ``<name>.txt`` sidecar → index the row in ``project_files``. The composed
context (D25) points the agent at the readable path; it pulls content on demand
through the existing ``read_file`` tool.

Extraction tiers:
  - Tier 1 — native text (``.tex/.md/.txt``): the file itself is readable; no sidecar.
  - Tier 2 — extractable (``.pdf/.docx``): text extracted to ``<name>.txt`` at upload.
  - Tier 3 — images (``.png/.jpg``): stored + downloadable, not extracted (vision is
    a later, model-side concern).

Like ``projects.py``, the proofs root is passed in by callers so the service is
testable against a scratch dir; it never imports config itself.
"""

from __future__ import annotations

import re
from pathlib import Path

from . import store
from .gitstore import GitStore
from .projects import project_repo_dir


class UploadError(ValueError):
    """A rejected upload. ``code`` maps to an HTTP status at the route boundary:
    ``too_large`` → 413, ``unsupported`` → 415, anything else → 400."""

    def __init__(self, message: str, code: str = "invalid"):
        super().__init__(message)
        self.code = code


# 25 MB cap — comfortably covers math PDFs/papers without inviting large media into
# git history (the binaries-in-git tradeoff is logged in the architecture doc).
MAX_UPLOAD_BYTES = 25 * 1024 * 1024

# Extension allowlist (no executables/scripts). Maps each accepted extension to the
# MIME we record when the client doesn't send a trustworthy one. The tier each falls
# into is decided by ``_TIER`` below.
ALLOWED_EXT: dict[str, str] = {
    ".pdf": "application/pdf",
    ".tex": "text/x-tex",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
}

_NATIVE_TEXT = {".tex", ".md", ".txt"}  # Tier 1 — readable as-is
_EXTRACTABLE = {".pdf", ".docx"}        # Tier 2 — extract a .txt sidecar
# everything else allowed (images) is Tier 3 — stored only


def files_dir(project: dict, proofs_root: Path) -> Path:
    """The project's ``.lea/files/`` directory (created on demand)."""
    return project_repo_dir(project, proofs_root) / ".lea" / "files"


def sanitize_filename(name: str, existing: set[str]) -> str:
    """A safe, collision-free filename for ``.lea/files/`` — never an absolute or
    parent path, only the basename, with unsafe characters folded to ``-``. A name
    that already exists (or whose sidecar would clash) gets ``-2``, ``-3``, … so an
    upload never silently overwrites a prior one. Empty/dotfile input → ``file``."""
    base = Path(str(name)).name  # drop any directory components (path-escape guard)
    stem, dot, ext = base.rpartition(".")
    if not dot:  # no extension
        stem, ext = base, ""
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip("-._") or "file"
    ext = re.sub(r"[^A-Za-z0-9]+", "", ext).lower()

    def build(suffix: str = "") -> str:
        name = f"{stem}{suffix}"
        return f"{name}.{ext}" if ext else name

    # A collision check covers the file itself AND its would-be .txt sidecar, so a
    # Tier-2 extract can never clobber an existing file.
    def clashes(name: str) -> bool:
        return name in existing or f"{name}.txt" in existing

    candidate = build()
    if not clashes(candidate):
        return candidate
    n = 2
    while clashes(build(f"-{n}")):
        n += 1
    return build(f"-{n}")


def _validate(filename: str, data: bytes) -> str:
    """Enforce the size cap + extension allowlist; return the lowercased extension.
    Raises :class:`UploadError` with the right ``code`` on rejection."""
    if len(data) == 0:
        raise UploadError("The file is empty.", code="invalid")
    if len(data) > MAX_UPLOAD_BYTES:
        raise UploadError(
            f"File is too large ({len(data) // (1024 * 1024)} MB); the cap is "
            f"{MAX_UPLOAD_BYTES // (1024 * 1024)} MB.",
            code="too_large",
        )
    ext = Path(str(filename)).suffix.lower()
    if ext not in ALLOWED_EXT:
        allowed = ", ".join(sorted(ALLOWED_EXT))
        raise UploadError(f"Unsupported file type '{ext or '?'}'. Allowed: {allowed}.", code="unsupported")
    return ext


def _extract_pdf(path: Path) -> str:
    from pdfminer.high_level import extract_text  # lazy: only when a pdf is uploaded

    return extract_text(str(path)) or ""


def _extract_docx(path: Path) -> str:
    import docx  # lazy: only when a docx is uploaded

    document = docx.Document(str(path))
    return "\n".join(p.text for p in document.paragraphs)


def extract_text(stored: Path, ext: str) -> Path | None:
    """Tier-2 extraction: for ``.pdf/.docx`` write a ``<name>.txt`` sidecar next to the
    stored file and return its path; for Tier-1/3 return None (nothing to extract).
    A failed extraction (corrupt/encrypted PDF) is swallowed — the upload still
    succeeds, just without a sidecar."""
    if ext not in _EXTRACTABLE:
        return None
    try:
        text = _extract_pdf(stored) if ext == ".pdf" else _extract_docx(stored)
    except Exception:
        return None
    if not text.strip():
        return None
    sidecar = stored.with_name(stored.name + ".txt")
    sidecar.write_text(text)
    return sidecar


def save_upload(
    project: dict,
    proofs_root: Path,
    filename: str,
    data: bytes,
    mime: str | None = None,
) -> dict:
    """The full upload pipeline (D27): validate → sanitize → write into ``.lea/files/``
    → extract text by tier → commit → index. Returns the ``project_files`` row.

    The bytes are git-canonical (committed to the project repo); the row is the
    pointer + extraction metadata. ``stored_path``/``extracted_path`` are stored
    repo-relative so they resolve regardless of where the repo lives on disk."""
    ext = _validate(filename, data)
    target_dir = files_dir(project, proofs_root)
    target_dir.mkdir(parents=True, exist_ok=True)
    existing = {p.name for p in target_dir.iterdir()} if target_dir.exists() else set()
    name = sanitize_filename(filename, existing)
    stored = target_dir / name
    stored.write_bytes(data)

    sidecar = extract_text(stored, ext)

    repo = project_repo_dir(project, proofs_root)
    GitStore(proofs_root).commit_all(repo, f"upload .lea/files/{name}")

    rel_stored = f".lea/files/{name}"
    rel_extracted = f".lea/files/{sidecar.name}" if sidecar else None
    return store.create_project_file(
        project["id"],
        filename=name,
        stored_path=rel_stored,
        mime=mime or ALLOWED_EXT.get(ext),
        kind="upload",
        extracted_path=rel_extracted,
    )


def file_disk_path(project: dict, proofs_root: Path, file_row: dict) -> Path:
    """Resolve a ``project_files`` row to the bytes on disk (for download)."""
    return project_repo_dir(project, proofs_root) / file_row["stored_path"]


def delete_file(project: dict, proofs_root: Path, file_row: dict) -> bool:
    """Remove an uploaded file + its sidecar from disk, drop the index row, and commit
    the removal. Best-effort on disk (a missing file is fine); the row delete is the
    source of truth. Returns the store delete result."""
    repo = project_repo_dir(project, proofs_root)
    for rel in (file_row.get("stored_path"), file_row.get("extracted_path")):
        if rel:
            p = repo / rel
            if p.exists():
                p.unlink()
    GitStore(proofs_root).commit_all(repo, f"delete {file_row['stored_path']}")
    return store.delete_project_file(file_row["id"])
