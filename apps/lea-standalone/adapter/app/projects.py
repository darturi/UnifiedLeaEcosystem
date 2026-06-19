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
        all_names = {p.name for p in files_dir.iterdir() if p.is_file()}
        # A Tier-2 sidecar is "<upload>.txt" with "<upload>" itself present (D27); list
        # the upload, not the sidecar, and tell the agent where to read its text.
        uploads = sorted(
            n for n in all_names if not (n.endswith(".txt") and n[: -len(".txt")] in all_names)
        )
        lines = []
        for n in uploads:
            sidecar = f"{n}.txt"
            if sidecar in all_names:
                lines.append(f"- `.lea/files/{n}` (read its extracted text at `.lea/files/{sidecar}`)")
            else:
                lines.append(f"- `.lea/files/{n}`")
        if lines:
            inventory = "\n".join(lines)

    # Mirrored Overleaf .tex sources live under .lea/files/overleaf/ (kind="overleaf",
    # written by the mirror sync). List them recursively as their own section so the
    # agent knows the LaTeX source is available and where to read it.
    ol_dir = files_dir / "overleaf"
    overleaf_section = ""
    if ol_dir.is_dir():
        ol_lines = [
            f"- `{p.relative_to(repo).as_posix()}`"
            for p in sorted(ol_dir.rglob("*.tex"))
            if p.is_file()
        ]
        if ol_lines:
            overleaf_section = (
                "\n\n## Overleaf LaTeX source\n"
                "The project's LaTeX sources, mirrored from Overleaf and kept current. "
                "Consult them for the prose statements, notation, and definitions behind "
                "the theorems. These are **read-only reference copies**, managed "
                "automatically — do not edit them, and do not compile or run LaTeX "
                "(`pdflatex`/`latexmk`) on them; that only produces build artifacts and "
                "wastes the run:\n" + "\n".join(ol_lines)
            )

    content = (
        f"{CONTEXT_MARKER}\n"
        f"You are working in project **{project.get('title', namespace)}** "
        f"(namespace `{namespace}`). Reuse already-proved sibling lemmas in this "
        f"project by importing them. The following is standing project context.\n\n"
        f"## Project Instructions\n{instructions}\n\n"
        f"## Project Memory\n{memory}\n\n"
        f"**Maintaining this memory is part of your job.** `.lea/memory.md` (in your "
        f"working directory) is a durable, bulleted record that persists across runs "
        f"and is shown to you at the start of every run. Keep it current with "
        f"`edit_file` — append a new bullet, never discard existing notes — whenever:\n"
        f"- the user states a preference or instruction (e.g. \"prefer short proofs\", "
        f"\"explain each step\", \"avoid `simp` here\") — record it verbatim as a rule to follow,\n"
        f"- you find a lemma, tactic, or witness worth reusing in this project,\n"
        f"- an approach fails in a way worth not repeating.\n"
        f"Do this proactively, the moment it happens — don't wait to be asked, and "
        f"don't only mention it in chat. One short bullet per entry.\n\n"
        f"## Project Blueprint (the decomposition)\n{blueprint}\n\n"
        f"`.lea/blueprint.md` (in your working directory) is the project's living proof "
        f"plan — the dependency graph of its definitions and lemmas. **Keeping it current "
        f"is part of your job:** with `edit_file`, add a `## <key>` section the moment you "
        f"plan a new lemma, and fill in its `lean:` name once you've formalized the decl. "
        f"One section per node, header then a one-line statement:\n"
        f"```\n"
        f"## continuous_sq\n"
        f"- kind: lemma            (definition | lemma | theorem)\n"
        f"- lean: `{namespace}.continuous_sq`   (the decl once named; omit until then)\n"
        f"- uses: helper_key, other_key   (keys of the nodes this one depends on)\n"
        f"\n"
        f"One-line statement in prose or LaTeX.\n"
        f"```\n"
        f"The `uses` lines are the edges that chain the proof — point them at the keys of "
        f"sibling nodes you build on, and reuse nodes already proved.\n\n"
        f"## Project files\n{inventory}{overleaf_section}"
    )
    return {"role": "user", "content": content}


def is_context_message(message: dict) -> bool:
    """True if a transcript message is a composed project-context message (D25), so
    the bridge can strip a stale copy before prepending a fresh one."""
    content = message.get("content")
    return isinstance(content, str) and content.startswith(CONTEXT_MARKER)


# The user/agent-editable `.lea/*.md` docs exposed over GET/PUT (D25/D26). A fixed
# whitelist so a doc name can never escape `.lea/` or address an arbitrary path.
EDITABLE_DOCS = {"instructions.md", "memory.md", "blueprint.md"}


def read_doc(project: dict, proofs_root: Path, name: str) -> str:
    """The raw text of a project's ``.lea/<name>`` doc (D25/D26) — un-stripped so the
    editor shows the seeded template verbatim. Missing file → ``""`` (a fresh, never-
    written doc). ``name`` must be in :data:`EDITABLE_DOCS`."""
    if name not in EDITABLE_DOCS:
        raise ValueError(f"not an editable project doc: {name!r}")
    path = project_repo_dir(project, proofs_root) / ".lea" / name
    try:
        return path.read_text()
    except OSError:
        return ""


def write_doc(project: dict, proofs_root: Path, name: str, content: str) -> str:
    """Write a project's ``.lea/<name>`` doc and commit it (D8), returning the SHA.
    The human-edit counterpart to the agent's ``write_file`` on the same files; both
    land in the project repo and feed the composed context (D25). ``name`` must be in
    :data:`EDITABLE_DOCS`."""
    if name not in EDITABLE_DOCS:
        raise ValueError(f"not an editable project doc: {name!r}")
    repo = project_repo_dir(project, proofs_root)
    lea_dir = repo / ".lea"
    lea_dir.mkdir(parents=True, exist_ok=True)
    (lea_dir / name).write_text(content)
    return GitStore(proofs_root).commit_all(repo, f"edit .lea/{name}")


def _seed_docs(title: str, namespace: str) -> dict[str, str]:
    """The three canonical ``.lea/*.md`` docs seeded into a fresh project. Plain
    markdown with a format-reminder comment; agent + human co-author them after
    (D25/D26/D28)."""
    return {
        "instructions.md": (
            f"# Instructions — {title}\n\n"
            "Your project goal and any rules for Lea. The agent reads this on every "
            "run, so describe what you want proved and the conventions to follow.\n"
        ),
        "memory.md": (
            f"# Memory — {title}\n\n"
            "Durable facts, learnings, and preferences. Both you and Lea append here — "
            "what worked, what failed, witnesses to prefer, dead ends to avoid.\n"
        ),
        "blueprint.md": (
            f"# Blueprint — {title}\n\n"
            "The proof decomposition — one `## ` section per node. Lea co-authors this "
            "as it plans and formalizes, and you can edit it too. Each node has a short "
            "header then a prose statement:\n\n"
            "```\n"
            "## continuous_sq\n"
            "- kind: lemma                # definition | lemma | theorem\n"
            f"- lean: `{namespace}.continuous_sq`   # the Lean decl, once it exists\n"
            "- uses: tendsto_iff_eps      # keys of the nodes this one depends on\n"
            "\n"
            "The function x ↦ x² is continuous in the ε–δ sense.\n"
            "```\n\n"
            "Add your first node below.\n"
        ),
    }


def _provision_repo(project: dict, proofs_root: Path, *, overwrite: bool) -> bool:
    """Ensure a project's on-disk repo exists and its seeded ``.lea/*.md`` docs are
    present, committing if anything was written. With ``overwrite=False`` a doc is
    written only when it's missing, so an existing (possibly edited) doc is never
    clobbered — the idempotent path shared by :func:`ensure_project`. Returns True if a
    doc was (re)written."""
    repo = project_repo_dir(project, proofs_root)
    gs = GitStore(proofs_root)
    gs.init_repo(repo, subject=f"project init: {project['namespace']}")
    lea_dir = repo / ".lea"
    lea_dir.mkdir(parents=True, exist_ok=True)
    wrote = False
    for name, content in _seed_docs(project["title"], project["namespace"]).items():
        path = lea_dir / name
        if overwrite or not path.exists():
            path.write_text(content)
            wrote = True
    if wrote:
        gs.commit_all(repo, "project init: seed .lea/ (instructions, memory, blueprint)")
    return wrote


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
        _provision_repo(project, proofs_root, overwrite=True)
    except Exception:
        # Roll back the index row so a half-provisioned project can't linger.
        store.delete_project_cascade(project["id"])
        raise
    return project


def ensure_project(slug: str, proofs_root: Path | None, title: str | None = None) -> dict:
    """Get-or-create a project by slug (the Overleaf path) AND ensure its on-disk repo is
    provisioned with the seeded ``.lea/*.md`` docs — the idempotent, slug-keyed analogue
    of :func:`provision_project`, so an Overleaf-originated project is provisioned exactly
    like a UI-created one (D25/D26/D28).

    Seeds each doc only when missing (never clobbers an edited ``memory.md`` /
    ``blueprint.md``) and commits only when something was written, so it is safe to call
    on every run/mirror and backfills projects created tag-only before this existed. Disk
    provisioning is best-effort — the index row is the source of truth and is always
    returned; a missing ``proofs_root`` (lea_root unconfigured) just skips the disk half."""
    project = store.get_or_create_project(slug, title=title)
    if proofs_root is not None:
        try:
            _provision_repo(project, proofs_root, overwrite=False)
        except Exception:
            pass  # never fail a run/mirror because seeding hiccuped
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
