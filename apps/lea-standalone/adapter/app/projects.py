"""Project service — the adapter-side concept of a "project" (D21/D32).

A project is a shared directory + git repo + DB index row. This module owns the
*directory/repo* half: deriving the slug → ``Lea.<Project>`` namespace → on-disk
``proofs/Lea/<Project>/`` path (D22), provisioning that repo with the three seeded
``.lea/*.md`` docs (Instructions/Memory/Blueprint — D25/D26/D28), resolving which
repo a session writes to (D24), and tearing a project down (rm -rf + the DB
cascade). The prover knows nothing about any of this (D32); it just gets a
``working_dir``.

The proofs root (``<lea_root>/workspace/proofs``) is passed in by callers so the
service is testable against a scratch dir — it never imports config itself.
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path

from . import store
from .gitstore import GitStore


def slugify(text: str) -> str:
    """A title → URL/namespace-safe slug: lowercase, non-alphanumeric runs become
    single hyphens, trimmed, capped at 80 chars. Empty input → ``"project"`` so the
    slug always satisfies ``validate_project_slug``."""
    value = re.sub(r"[^a-z0-9]+", "-", str(text or "").strip().lower()).strip("-")
    return (value[:80] or "project")


def unique_slug(text: str) -> str:
    """``slugify`` plus collision avoidance against existing projects: ``proj``,
    ``proj-2``, ``proj-3``, … Slugs are immutable (D22), so uniqueness only matters
    at creation."""
    base = slugify(text)
    if store.get_project_by_slug(base) is None:
        return base
    n = 2
    while store.get_project_by_slug(f"{base}-{n}") is not None:
        n += 1
    return f"{base}-{n}"


def project_repo_dir(project: dict, proofs_root: Path) -> Path:
    """The on-disk repo for a project: ``proofs_root / Lea / <Project>`` (D22),
    derived from its cached namespace so it always matches ``repo_path``."""
    return proofs_root / Path(project["namespace"].replace(".", "/"))


def repo_for_session(session: dict, proofs_root: Path, project: dict | None = None) -> Path:
    """Resolve the git repo a session reads/writes (D24): an in-project session
    shares the project repo (``proofs/Lea/<Project>``); a loose session gets its own
    ``proofs/<session-id>`` repo. ``project`` must be supplied when the session has a
    ``project_id`` (the caller has it in hand and the resolver stays DB-free)."""
    if session.get("project_id") and project is not None:
        return project_repo_dir(project, proofs_root)
    return proofs_root / session["id"]


def resolve_git(session_id: str, proofs_root: Path) -> tuple[GitStore, str] | None:
    """Resolve a session to its (GitStore, repo_key) so every git primitive operates
    on the right repo (D24), without changing GitStore's session-keyed API. The trick:
    root the store at the repo's *parent* and key by the repo's dir name —
    loose → ``(proofs, <session-id>)`` (identical to before); project →
    ``(proofs/Lea, <Project>)`` (the shared repo). Returns None if the session is gone.

    Callers use the real ``session_id`` for DB rows and ``repo_key`` for git calls."""
    session = store.get_session(session_id)
    if session is None:
        return None
    project = (
        store.get_project(session["project_id"]) if session.get("project_id") else None
    )
    repo = repo_for_session(session, proofs_root, project)
    return GitStore(repo.parent), repo.name


# Sentinel marking the composed project-context message, so a stale copy can be
# stripped from the replayed transcript before a fresh one is prepended (D25).
CONTEXT_MARKER = "<!-- lea:project-context -->"


def _read_lea_doc(repo: Path, name: str) -> str:
    path = repo / ".lea" / name
    try:
        return path.read_text().strip()
    except OSError:
        return ""


def compose_context_message(project: dict, repo: Path) -> dict | None:
    """Assemble the project's standing context into ONE user message (D25): the
    Instructions / Memory / Blueprint `.lea/*.md` docs + a file inventory, prepended
    to the run's messages by the bridge. The prover stays project-agnostic — this is
    pure adapter-side composition. Returns None when there's no project."""
    if not project:
        return None
    namespace = project.get("namespace", "")
    instructions = _read_lea_doc(repo, "instructions.md") or "(none yet)"
    memory = _read_lea_doc(repo, "memory.md") or "(none yet)"
    blueprint = _read_lea_doc(repo, "blueprint.md") or "(none yet)"

    files_dir = repo / ".lea" / "files"
    inventory = "(none)"
    if files_dir.is_dir():
        names = sorted(p.name for p in files_dir.iterdir() if p.is_file())
        if names:
            inventory = "\n".join(f"- `.lea/files/{n}`" for n in names)

    content = (
        f"{CONTEXT_MARKER}\n"
        f"You are working in project **{project.get('title', namespace)}** "
        f"(namespace `{namespace}`). Reuse already-proved sibling lemmas in this "
        f"project by importing them. The following is standing project context.\n\n"
        f"## Project Instructions\n{instructions}\n\n"
        f"## Project Memory\n{memory}\n\n"
        f"## Blueprint (planned decomposition)\n{blueprint}\n\n"
        f"## Project files\n{inventory}"
    )
    return {"role": "user", "content": content}


def is_context_message(message: dict) -> bool:
    """True if a transcript message is a composed project-context message (D25), so
    the bridge can strip a stale copy before prepending a fresh one."""
    content = message.get("content")
    return isinstance(content, str) and content.startswith(CONTEXT_MARKER)


def _seed_docs(title: str, namespace: str) -> dict[str, str]:
    """The three canonical ``.lea/*.md`` docs seeded into a fresh project. Plain
    markdown with a format-reminder comment; agent + human co-author them after
    (D25/D26/D28)."""
    return {
        "instructions.md": (
            f"# Instructions — {title}\n\n"
            "<!-- Your project goal + rules for Lea. The agent reads this every run; "
            "edit it in the project window. Describe what you want proved and any "
            "conventions to follow. -->\n\n"
            "Describe this project's goal here.\n"
        ),
        "memory.md": (
            f"# Memory — {title}\n\n"
            "<!-- Durable facts, learnings, and preferences. Both you and Lea append "
            "here: what worked, what failed, witnesses to prefer, dead ends to avoid. -->\n"
        ),
        "blueprint.md": (
            f"# Blueprint — {title}\n\n"
            "<!-- The proof decomposition. One `## ` section per node, with header lines:\n"
            "       - kind: definition | lemma | theorem\n"
            f"       - lean: `{namespace}.<decl>`   (omit until the decl is named)\n"
            "       - uses: other_node_keys, comma_separated\n"
            "     then a prose statement. Lea co-authors this as it plans + formalizes. -->\n"
        ),
    }


def provision_project(
    title: str,
    proofs_root: Path,
    description: str | None = None,
) -> dict:
    """Create a project end to end: the DB index row (D30) + the on-disk shared git
    repo with its seeded ``.lea/`` docs (D21/D22/D25). Returns the project dict.

    Row first, then disk; if the repo build fails the row is rolled back so a failed
    provision leaves nothing behind."""
    slug = unique_slug(title)
    namespace = store.project_namespace_for_slug(slug)
    repo_path = store.repo_path_for_namespace(namespace)
    project = store.create_project(
        slug,
        title=title.strip() or slug,
        description=(description or None),
        namespace=namespace,
        repo_path=repo_path,
    )
    try:
        repo = project_repo_dir(project, proofs_root)
        gs = GitStore(proofs_root)
        gs.init_repo(repo, subject=f"project init: {namespace}")
        lea_dir = repo / ".lea"
        lea_dir.mkdir(parents=True, exist_ok=True)
        for name, content in _seed_docs(project["title"], namespace).items():
            (lea_dir / name).write_text(content)
        gs.commit_all(repo, "project init: seed .lea/ (instructions, memory, blueprint)")
    except Exception:
        # Roll back the index row so a half-provisioned project can't linger.
        store.delete_project_cascade(project["id"])
        raise
    return project


def delete_project(project_id: str, proofs_root: Path) -> bool:
    """Delete a project's on-disk repo (rm -rf) and cascade its DB rows (D31).
    Returns False if the project doesn't exist. The disk delete is best-effort —
    a missing dir is fine; the index cascade is the source of truth for existence."""
    project = store.get_project(project_id)
    if project is None:
        return False
    repo = project_repo_dir(project, proofs_root)
    if repo.exists():
        shutil.rmtree(repo, ignore_errors=True)
    return store.delete_project_cascade(project_id)
