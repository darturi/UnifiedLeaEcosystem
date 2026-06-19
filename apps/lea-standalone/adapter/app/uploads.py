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

import hashlib
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


# ── Overleaf .tex mirror (background sync, D27 extended) ───────────────────────────
# The Overleaf extension mirrors the project's .tex sources into a dedicated subtree
# of `.lea/files/` so they surface to the prover exactly like an uploaded reference
# doc — but with UPDATE-by-path semantics (not the `-2`/`-3` collision rename a fresh
# upload gets) and tagged `kind="overleaf"` so they can never clobber a user upload
# (which lives at the `.lea/files/` top level). The git commit is the slow step and is
# deferred by the route (`commit=False`) off the run-start path; the composed-context
# inventory reads files from disk, not git, so a run never waits on the commit.

OVERLEAF_KIND = "overleaf"
OVERLEAF_SUBDIR = "overleaf"  # under .lea/files/


def overleaf_dir(project: dict, proofs_root: Path) -> Path:
    """The project's ``.lea/files/overleaf/`` mirror subtree."""
    return files_dir(project, proofs_root) / OVERLEAF_SUBDIR


# Only mirrored `.tex` sources (and this `.gitignore`) belong in the overleaf subtree.
# `*` ignores everything; `!*/` lets git descend into nested folders; `!*.tex` re-includes
# the sources at any depth. This stops commit-on-write (D8, ``git add -A``) from ever
# capturing LaTeX build artifacts (`.pdf`/`.synctex.gz`/`.aux`/`.log`/`.fls`/`.fdb_latexmk`)
# that the agent may generate by compiling the mirrored document.
OVERLEAF_GITIGNORE = "*\n!*/\n!*.tex\n!.gitignore\n"


def _gitignore_ok(base: Path) -> bool:
    gi = base / ".gitignore"
    try:
        return gi.is_file() and gi.read_text() == OVERLEAF_GITIGNORE
    except OSError:
        return False


def _write_gitignore(base: Path) -> bool:
    """Ensure the subtree's ``.gitignore`` has the canonical content; True if (re)written."""
    base.mkdir(parents=True, exist_ok=True)
    if _gitignore_ok(base):
        return False
    (base / ".gitignore").write_text(OVERLEAF_GITIGNORE)
    return True


def _subtree_files(base: Path) -> list[Path]:
    """Every file under the mirror subtree except the ``.gitignore`` (mirror-owned set)."""
    if not base.is_dir():
        return []
    return [p for p in base.rglob("*") if p.is_file() and p.name != ".gitignore"]


def _prune_empty_dirs(base: Path) -> None:
    """Remove directories left empty after pruning (deepest first), keeping ``base``."""
    if not base.is_dir():
        return
    for p in sorted(base.rglob("*"), key=lambda x: len(x.parts), reverse=True):
        if p.is_dir() and not any(p.iterdir()):
            try:
                p.rmdir()
            except OSError:
                pass


def _normalize_tex_relpath(path: str) -> str:
    """An Overleaf-relative path → a safe POSIX subpath under the mirror dir. Rejects
    absolutes/escapes and non-``.tex``; folds unsafe characters per path segment.
    Raises :class:`UploadError` on a bad or non-``.tex`` path."""
    raw = str(path or "").strip().replace("\\", "/").lstrip("/")
    if not raw.lower().endswith(".tex"):
        raise UploadError(f"not a .tex path: {path!r}", code="unsupported")
    parts: list[str] = []
    for seg in raw.split("/"):
        if seg in ("", "."):
            continue
        if seg == "..":
            raise UploadError("path escapes the project", code="invalid")
        parts.append(re.sub(r"[^A-Za-z0-9._-]+", "-", seg).strip("-._") or "file")
    if not parts:
        raise UploadError("empty .tex path", code="invalid")
    return "/".join(parts)


def _mirror_signature(items: dict[str, str]) -> str:
    """Order-independent content hash of a {relpath: content} set, for the no-op
    short-circuit (skip all I/O + commit when nothing changed)."""
    h = hashlib.sha256()
    for rel, content in sorted(items.items()):
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        h.update(content.encode("utf-8"))
        h.update(b"\0")
    return h.hexdigest()


def _current_mirror(project: dict, proofs_root: Path) -> dict[str, str]:
    """The mirror's current on-disk state as {relpath: content}."""
    base = overleaf_dir(project, proofs_root)
    out: dict[str, str] = {}
    if base.is_dir():
        for p in sorted(base.rglob("*.tex")):
            if p.is_file():
                try:
                    out[p.relative_to(base).as_posix()] = p.read_text()
                except OSError:
                    continue
    return out


def ensure_overleaf_gitignore(project: dict, proofs_root: Path) -> bool:
    """Ensure the ``.gitignore`` guard exists in an existing overleaf mirror subtree, so a
    run's commit-on-write never captures LaTeX build artifacts the agent may generate by
    compiling. No-op when the subtree doesn't exist yet. Returns True if (re)written.

    Called at run start (the bridge) so protection holds even before the first post-fix
    mirror sync writes the file itself."""
    base = overleaf_dir(project, proofs_root)
    if not base.is_dir():
        return False
    return _write_gitignore(base)


def commit_mirror(project: dict, proofs_root: Path) -> str:
    """Commit the project repo after a mirror reconcile (run as a deferred background
    task by the route, so the request returns before git runs)."""
    repo = project_repo_dir(project, proofs_root)
    return GitStore(proofs_root).commit_all(repo, "overleaf: mirror .tex sources")


def sync_overleaf_tex(
    project: dict,
    proofs_root: Path,
    files: list[dict],
    *,
    commit: bool = True,
) -> dict:
    """Reconcile the project's mirrored ``.lea/files/overleaf/**`` against the incoming
    ``.tex`` set: upsert changed files, index new rows (``kind="overleaf"``), drop rows
    for removed ones. The subtree is treated as **exclusively mirror-owned** — only the
    incoming ``.tex`` (plus a ``.gitignore``) survive, so any LaTeX build artifacts the
    agent generated by compiling the document are pruned, and the ``.gitignore`` stops
    commit-on-write from capturing new ones. Idempotent and order-independent.

    Short-circuits to a no-op only when the ``.tex`` are byte-identical to disk AND the
    subtree is already clean (nothing to prune, ``.gitignore`` present). When
    ``commit=False`` the git commit is deferred to the caller; the returned ``changed``
    flag says whether a commit is needed. Returns a summary dict."""
    # Normalize + validate incoming (last write wins on a normalized-path clash).
    incoming: dict[str, str] = {}
    for f in files or []:
        path = f["path"] if isinstance(f, dict) else getattr(f, "path", "")
        content = str((f.get("content") if isinstance(f, dict) else getattr(f, "content", "")) or "")
        rel = _normalize_tex_relpath(path)
        if len(content.encode("utf-8")) > MAX_UPLOAD_BYTES:
            raise UploadError(f"{rel} is too large (cap {MAX_UPLOAD_BYTES // (1024 * 1024)} MB).", code="too_large")
        incoming[rel] = content

    base = overleaf_dir(project, proofs_root)
    desired_abs = {base / rel for rel in incoming}
    stray = [p for p in _subtree_files(base) if p not in desired_abs]

    # Fast path: .tex unchanged AND nothing to prune AND the .gitignore is in place.
    if (
        _mirror_signature(incoming) == _mirror_signature(_current_mirror(project, proofs_root))
        and not stray
        and _gitignore_ok(base)
    ):
        return {"written": 0, "updated": 0, "deleted": 0, "pruned": 0,
                "unchanged": len(incoming), "changed": False, "committed": False}

    repo = project_repo_dir(project, proofs_root)
    GitStore(proofs_root).init_repo(repo)  # idempotent; provisions tag-only projects
    base.mkdir(parents=True, exist_ok=True)
    gitignore_written = _write_gitignore(base)

    existing = {r["stored_path"]: r for r in store.list_project_files_by_kind(project["id"], OVERLEAF_KIND)}

    written = updated = unchanged = deleted = 0
    desired_stored: set[str] = set()
    for rel, content in incoming.items():
        stored_rel = f".lea/files/{OVERLEAF_SUBDIR}/{rel}"
        desired_stored.add(stored_rel)
        abs_path = base / rel
        abs_path.parent.mkdir(parents=True, exist_ok=True)
        prior = abs_path.read_text() if abs_path.is_file() else None
        if prior == content:
            unchanged += 1
        elif prior is None:
            abs_path.write_text(content)
            written += 1
        else:
            abs_path.write_text(content)
            updated += 1
        if stored_rel not in existing:
            store.create_project_file(
                project["id"], filename=rel, stored_path=stored_rel,
                mime="text/x-tex", kind=OVERLEAF_KIND, extracted_path=None,
            )

    # Prune everything in the subtree that isn't a desired .tex — build artifacts the
    # agent produced by compiling, plus any .tex removed from Overleaf. (.gitignore kept.)
    pruned = 0
    for p in _subtree_files(base):
        if p not in desired_abs:
            try:
                p.unlink()
                pruned += 1
            except OSError:
                pass
    _prune_empty_dirs(base)

    # Drop index rows for .tex no longer present.
    for stored_rel, row in existing.items():
        if stored_rel not in desired_stored:
            store.delete_project_file(row["id"])
            deleted += 1

    changed = bool(written or updated or deleted or pruned or gitignore_written)
    committed = False
    if changed and commit:
        commit_mirror(project, proofs_root)
        committed = True
    return {"written": written, "updated": updated, "deleted": deleted, "pruned": pruned,
            "unchanged": unchanged, "changed": changed, "committed": committed}
