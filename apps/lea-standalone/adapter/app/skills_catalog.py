"""Skill resolution seam (v2.1.1 W3, D48).

A skill is a DB row (markdown `body` in a column, D45); the prover consumes
`cfg.skills` as a list of file *paths* it reads and injects under `## Skill:
<stem>`. This module bridges the two: at run start it materializes the skills
that resolve for a project (global ∪ assigned, D47) to per-run temp `.md`
files — one `<slug>.md` per skill, so the prover's header reads `## Skill:
<slug>` cleanly — and hands `bridge.py` the paths to set on `cfg.skills`.

The temp dir lives in the system temp area, deliberately **not** inside any
project repo, so materialized skills never pollute the git-owned proof tree
(D7/D8). The caller owns cleanup (a run's `finally`). A loose (project-less)
session never calls this — it resolves to no skills by definition (D47).
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from . import store


def materialize_project_skills(project_id: str) -> tuple[list[str], str | None]:
    """Write each skill that resolves for the project to `<tempdir>/<slug>.md`.

    Returns `(paths, tempdir)` in resolution order (so the prompt injection order
    is stable). When no skills resolve, returns `([], None)` and creates no dir —
    so the common (no-skills) path allocates nothing. The caller sets `paths` on
    `cfg.skills` and passes `tempdir` to `cleanup` in its `finally`.
    """
    skills = store.skills_for_project(project_id)
    if not skills:
        return [], None
    tempdir = tempfile.mkdtemp(prefix="lea-skills-")
    paths: list[str] = []
    for skill in skills:
        path = Path(tempdir) / f"{skill['slug']}.md"
        path.write_text(skill.get("body") or "")
        paths.append(str(path))
    return paths, tempdir


def cleanup(tempdir: str | None) -> None:
    """Remove a materialized-skills temp dir (best effort). No-op for None."""
    if tempdir:
        shutil.rmtree(tempdir, ignore_errors=True)
