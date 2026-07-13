from __future__ import annotations

import json
import re
import sqlite3
from uuid import uuid4

from typing import Any

from .db import ROOT, connect, row_to_dict, utc_now


RAW_EVENT_LOG_DIR = ROOT / "data" / "lea-api-events"
PROJECT_SLUG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$")
PROJECT_NAMESPACE_RE = re.compile(r"^Lea\.[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$")
# A skill slug is the stable id AND the materialized filename stem the prover reads
# as `## Skill: <slug>` (D45) — lower-kebab, letter/digit-initial, ≤80 chars.
SKILL_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,79}$")


def create_session(
    title: str,
    project_id: str | None = None,
    origin: str = "ui",
    origin_url: str | None = None,
) -> dict:
    """Create a session. `origin` records providence ('ui' | 'overleaf'); for an
    Overleaf-spawned session `origin_url` is the canonical Overleaf document URL so
    the UI can open/focus the source document. Both default to the interactive-UI
    case so the existing path is unchanged."""
    now = utc_now()
    session_id = str(uuid4())
    origin_value = (origin or "ui").strip() or "ui"
    with connect() as conn:
        conn.execute(
            "insert into sessions (id, project_id, title, origin, origin_url, created_at, updated_at) "
            "values (?, ?, ?, ?, ?, ?, ?)",
            (session_id, project_id, title[:120] or "Untitled theorem", origin_value, origin_url, now, now),
        )
        row = conn.execute("select * from sessions where id = ?", (session_id,)).fetchone()
    return row_to_dict(row)


def touch_session(session_id: str) -> None:
    """Bump a session's updated_at. There is no stored status to set — a session's
    status is its working-copy verdict, derived from the latest code_step on read
    (D14). Run lifecycle is tracked on runs.status, not here."""
    now = utc_now()
    with connect() as conn:
        conn.execute("update sessions set updated_at = ? where id = ?", (now, session_id))


def get_session(session_id: str) -> dict | None:
    with connect() as conn:
        row = conn.execute("select * from sessions where id = ?", (session_id,)).fetchone()
    return row_to_dict(row) if row else None


def list_sessions() -> list[dict]:
    """All sessions (loose + in-project), newest first. The sidebar uses
    `list_loose_sessions`; this stays the unfiltered view (usage stats, search)."""
    return _list_sessions()


def list_loose_sessions() -> list[dict]:
    """Loose sessions only (`project_id IS NULL`) — the sidebar Chats group (D30).
    In-project sessions are reached through the project window / search, not here."""
    return _list_sessions("s.project_id is null")


def list_project_sessions(project_id: str) -> list[dict]:
    """Sessions belonging to one project — the project window's session list (D30)."""
    return _list_sessions("s.project_id = ?", (project_id,))


# Fields the search endpoint returns per hit — the session plus its project tag. A
# light projection of the full `_list_sessions` dict (the overlay needs no usage rollups).
_SEARCH_FIELDS = (
    "id", "title", "status", "updated_at",
    "project_id", "project_title", "project_namespace",
)


def _escape_like(text: str) -> str:
    """Escape a user query for a LIKE pattern (so `%`/`_` are literal, not wildcards)."""
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def search_sessions(query: str, limit: int = 30) -> list[dict]:
    """Sessions whose title — or whose project's title — matches `query`, newest first
    (D31/D41). Backs `GET /api/search`: the only way to reach a project session, which
    the sidebar hides. Case-insensitive SQLite LIKE (FTS5 is a later upgrade). Each hit
    carries its project tag so the overlay can section loose vs in-project. Blank → []."""
    q = (query or "").strip()
    if not q:
        return []
    like = f"%{_escape_like(q)}%"
    rows = _list_sessions(
        "(s.title like ? escape '\\' or p.title like ? escape '\\')",
        (like, like),
    )
    return [{field: row.get(field) for field in _SEARCH_FIELDS} for row in rows[:limit]]


def _list_sessions(extra_where: str = "", params: tuple = ()) -> list[dict]:
    where_sql = f"where {extra_where}" if extra_where else ""
    with connect() as conn:
        rows = conn.execute(
            f"""
            select
                s.*,
                coalesce(sum(r.input_tokens), 0) as input_tokens,
                coalesce(sum(r.output_tokens), 0) as output_tokens,
                coalesce(sum(r.input_tokens + r.output_tokens), 0) as total_tokens,
                coalesce(sum(r.cost_usd), 0) as cost_usd,
                count(distinct r.id) as run_count,
                (
                    select count(*)
                    from messages m
                    where m.session_id = s.id
                ) as message_count,
                (
                    select r2.model
                    from runs r2
                    where r2.session_id = s.id
                    order by r2.updated_at desc, r2.created_at desc
                    limit 1
                ) as primary_model,
                group_concat(distinct r.model) as models,
                p.id as project_id,
                p.slug as project_slug,
                p.title as project_title,
                p.namespace as project_namespace,
                p.repo_path as project_repo_path,
                s.created_at as started_at,
                s.updated_at as ended_at,
                (
                    select cs.check_status
                    from code_steps cs
                    where cs.session_id = s.id and lower(cs.path) not like '%scratch%'
                    order by cs.seq desc
                    limit 1
                ) as latest_check_status,
                (
                    select cs.artifact_kind
                    from code_steps cs
                    where cs.session_id = s.id and lower(cs.path) not like '%scratch%'
                    order by cs.seq desc
                    limit 1
                ) as latest_artifact_kind,
                (
                    select rcs.status
                    from code_steps cs
                    left join runs rcs on rcs.id = cs.run_id
                    where cs.session_id = s.id and lower(cs.path) not like '%scratch%'
                    order by cs.seq desc
                    limit 1
                ) as latest_code_run_status,
                (
                    select count(*) from code_steps cs
                    where cs.session_id = s.id and lower(cs.path) not like '%scratch%'
                ) as code_step_count,
                (
                    select count(*)
                    from runs r3
                    where r3.session_id = s.id and r3.status in ('pending', 'running')
                ) as active_run_count,
                max(0, cast((julianday(s.updated_at) - julianday(s.created_at)) * 86400 as integer)) as duration_seconds
            from sessions s
            left join runs r on r.session_id = s.id
            left join projects p on p.id = s.project_id
            {where_sql}
            group by s.id
            order by s.updated_at desc
            limit 100
            """,
            params,
        ).fetchall()
    sessions = []
    for row in rows:
        data = row_to_dict(row)
        data["status"] = _derive_session_status(
            data.pop("latest_check_status", None),
            data.pop("latest_artifact_kind", None),
            int(data.pop("code_step_count", 0) or 0),
            bool(data.pop("active_run_count", 0)),
            data.pop("latest_code_run_status", None),
        )
        sessions.append(_normalize_usage_session(data))
    return sessions


def sessions_digest() -> str:
    """A cheap fingerprint of the session-list state, for the `/api/sessions/events`
    SSE feed to poll. Changes whenever a session is created or touched (max
    updated_at + count) or a run enters/leaves the active set (so a status flip from
    'running' → 'ok'/'error' is also detected). Deliberately avoids running the full
    `list_sessions` aggregate on every tick — that query only fires when this digest
    moves."""
    with connect() as conn:
        row = conn.execute(
            """
            select
                (select count(*) from sessions) as session_count,
                (select coalesce(max(updated_at), '') from sessions) as max_updated_at,
                (select count(*) from runs where status in ('pending', 'running')) as active_runs,
                (select coalesce(max(updated_at), '') from runs) as max_run_updated_at
            """
        ).fetchone()
    data = row_to_dict(row)
    return "|".join(
        str(data.get(key, ""))
        for key in ("session_count", "max_updated_at", "active_runs", "max_run_updated_at")
    )


def create_run(
    session_id: str,
    model: str,
    provider: str | None,
    max_turns: int | None,
    project_id: str | None = None,
    autonomous: bool = False,
) -> dict:
    now = utc_now()
    run_id = str(uuid4())
    with connect() as conn:
        conn.execute(
            """
            insert into runs (id, session_id, project_id, status, autonomous, model, provider, max_turns, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (run_id, session_id, project_id, "pending", 1 if autonomous else 0, model, provider, max_turns, now, now),
        )
        row = conn.execute("select * from runs where id = ?", (run_id,)).fetchone()
    return row_to_dict(row)


def list_projects() -> list[dict]:
    """All projects, newest first, each with a `session_count` (the sidebar shows
    it). Proof/node counts + status mix come from the live Lean state in later
    slices (the blueprint graph) — not stored here (DB-as-index, D4)."""
    with connect() as conn:
        rows = conn.execute(
            """
            select
                p.*,
                (select count(*) from sessions s where s.project_id = p.id) as session_count
            from projects p
            order by p.updated_at desc, p.title asc
            """
        ).fetchall()
    return [row_to_dict(row) for row in rows]


def get_project(project_id: str) -> dict | None:
    with connect() as conn:
        row = conn.execute("select * from projects where id = ?", (project_id,)).fetchone()
    return row_to_dict(row) if row else None


def get_project_by_slug(slug: str) -> dict | None:
    value = validate_project_slug(slug)
    with connect() as conn:
        row = conn.execute("select * from projects where slug = ?", (value,)).fetchone()
    return row_to_dict(row) if row else None


def get_project_by_namespace(namespace: str) -> dict | None:
    value = validate_project_namespace(namespace)
    with connect() as conn:
        row = conn.execute("select * from projects where namespace = ?", (value,)).fetchone()
    return row_to_dict(row) if row else None


def validate_project_namespace(namespace: str) -> str:
    value = str(namespace or "").strip()
    if not PROJECT_NAMESPACE_RE.fullmatch(value):
        raise ValueError("project namespace must be under Lea. with Lean identifier segments")
    return value


def project_namespace_for_slug(slug: str) -> str:
    """Derive a fallback Lean namespace `Lea.<Project>` from a slug. The slug is the
    immutable Overleaf/project binding; the namespace is cached and can migrate only
    through the explicit project-identity rename flow."""
    parts = re.split(r"[-_\s]+", str(slug or "").strip())
    camel = "".join(p[:1].upper() + p[1:] for p in parts if p)
    camel = re.sub(r"[^A-Za-z0-9]", "", camel)
    if not camel or not camel[0].isalpha():
        camel = "P" + camel  # Lean segments can't start with a digit
    return f"Lea.{camel}"


def repo_path_for_namespace(namespace: str) -> str:
    """The shared dir / git repo for a namespace: `Lea.Foo` → `proofs/Lea/Foo` (D22)."""
    value = validate_project_namespace(namespace)
    return "proofs/" + value.replace(".", "/")


def get_or_create_project(slug: str, title: str | None = None) -> dict:
    """Return the project with this slug, creating it on first use. Used by the
    Overleaf path to tag runs with the document namespace so per-document usage can
    be aggregated. `slug` is unique, so a concurrent create just re-reads the
    winner."""
    existing = get_project_by_slug(slug)
    if existing:
        return existing
    try:
        return create_project(slug, title=title)
    except sqlite3.IntegrityError:
        # Lost a create race on the unique slug — read back the winner.
        winner = get_project_by_slug(slug)
        if winner:
            return winner
        raise


def create_project(
    slug: str,
    title: str | None = None,
    description: str | None = None,
    namespace: str | None = None,
    repo_path: str | None = None,
    remote_url: str | None = None,
) -> dict:
    """Insert a project index row (D21/D30). `namespace`/`repo_path` default to the
    slug-derived values so the Overleaf tag-only path keeps working; P2's project
    service passes them explicitly when it provisions the real on-disk repo."""
    slug = validate_project_slug(slug)
    now = utc_now()
    project_id = str(uuid4())
    project_title = (title or slug).strip() or slug
    ns = validate_project_namespace(namespace) if namespace else project_namespace_for_slug(slug)
    repo = repo_path or repo_path_for_namespace(ns)
    with connect() as conn:
        conn.execute(
            """
            insert into projects
                (id, slug, title, description, namespace, repo_path, remote_url, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (project_id, slug, project_title, description, ns, repo, remote_url, now, now),
        )
        row = conn.execute("select * from projects where id = ?", (project_id,)).fetchone()
    return row_to_dict(row)


def update_project(
    project_id: str,
    title: str | None = None,
    description: str | None = None,
    remote_url: str | None = None,
) -> dict | None:
    """Update project metadata only (D31): title, description, GitHub remote. The
    slug → namespace → repo_path chain is immutable (D22), so those never change
    here. Pass a field as None to leave it untouched."""
    now = utc_now()
    with connect() as conn:
        row = conn.execute("select * from projects where id = ?", (project_id,)).fetchone()
        if not row:
            return None
        current = row_to_dict(row)
        conn.execute(
            """
            update projects
            set title = ?, description = ?, remote_url = ?, updated_at = ?
            where id = ?
            """,
            (
                (title if title is not None else current["title"]).strip() or current["title"],
                description if description is not None else current["description"],
                remote_url if remote_url is not None else current["remote_url"],
                now,
                project_id,
            ),
        )
        updated = conn.execute("select * from projects where id = ?", (project_id,)).fetchone()
    return row_to_dict(updated)


def update_project_identity(
    project_id: str,
    *,
    title: str,
    namespace: str,
    repo_path: str,
) -> dict | None:
    """Update the mutable project identity fields. `slug` remains immutable; this is
    reserved for the explicit namespace-migration path, not ordinary metadata edits."""
    ns = validate_project_namespace(namespace)
    now = utc_now()
    with connect() as conn:
        row = conn.execute("select * from projects where id = ?", (project_id,)).fetchone()
        if not row:
            return None
        conn.execute(
            """
            update projects
            set title = ?, namespace = ?, repo_path = ?, updated_at = ?
            where id = ?
            """,
            ((title or "").strip() or row["title"], ns, repo_path, now, project_id),
        )
        updated = conn.execute("select * from projects where id = ?", (project_id,)).fetchone()
    return row_to_dict(updated)


def create_project_file(
    project_id: str,
    filename: str,
    stored_path: str,
    mime: str | None = None,
    kind: str = "upload",
    extracted_path: str | None = None,
) -> dict:
    """Index a project file (D27). The bytes live in the project repo under
    `.lea/files/` (git-canonical); this row is the pointer + extraction metadata."""
    now = utc_now()
    file_id = str(uuid4())
    with connect() as conn:
        conn.execute(
            """
            insert into project_files
                (id, project_id, filename, stored_path, mime, kind, extracted_path, created_at)
            values (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (file_id, project_id, filename, stored_path, mime, kind, extracted_path, now),
        )
        row = conn.execute("select * from project_files where id = ?", (file_id,)).fetchone()
    return row_to_dict(row)


def list_project_files(project_id: str) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "select * from project_files where project_id = ? order by created_at asc, filename asc",
            (project_id,),
        ).fetchall()
    return [row_to_dict(row) for row in rows]


def get_project_file(file_id: str) -> dict | None:
    with connect() as conn:
        row = conn.execute("select * from project_files where id = ?", (file_id,)).fetchone()
    return row_to_dict(row) if row else None


def list_project_files_by_kind(project_id: str, kind: str) -> list[dict]:
    """Project files of one ``kind`` (e.g. ``"overleaf"`` for the mirrored .tex), used
    by the Overleaf mirror reconcile to diff the desired set against what's indexed."""
    with connect() as conn:
        rows = conn.execute(
            "select * from project_files where project_id = ? and kind = ? "
            "order by stored_path asc",
            (project_id, kind),
        ).fetchall()
    return [row_to_dict(row) for row in rows]


def get_project_file_by_path(project_id: str, stored_path: str) -> dict | None:
    with connect() as conn:
        row = conn.execute(
            "select * from project_files where project_id = ? and stored_path = ?",
            (project_id, stored_path),
        ).fetchone()
    return row_to_dict(row) if row else None


def delete_project_file(file_id: str) -> bool:
    with connect() as conn:
        cur = conn.execute("delete from project_files where id = ?", (file_id,))
    return cur.rowcount > 0


def delete_project_cascade(project_id: str) -> bool:
    """Delete a project and every DB row that references it. SQLite foreign keys are
    not enforced here (no `PRAGMA foreign_keys=ON`), so the cascade is explicit: the
    project's sessions and all their dependent rows go first, then project_files,
    then the project. The on-disk repo (`rm -rf`) is the caller's job (the project
    service) — this is the index half of delete (D31). Returns False if absent."""
    with connect() as conn:
        if not conn.execute("select 1 from projects where id = ?", (project_id,)).fetchone():
            return False
        session_ids = [
            r["id"] for r in conn.execute(
                "select id from sessions where project_id = ?", (project_id,)
            ).fetchall()
        ]
        if session_ids:
            marks = ",".join("?" for _ in session_ids)
            for table in ("messages", "code_steps", "status_events", "run_usage_breakdown", "runs"):
                conn.execute(f"delete from {table} where session_id in ({marks})", session_ids)
            conn.execute(f"delete from sessions where id in ({marks})", session_ids)
        conn.execute("delete from project_files where project_id = ?", (project_id,))
        # Drop any skill assignments pointing at this project (D47) — the skills
        # themselves survive (they may be global or assigned elsewhere).
        conn.execute("delete from skill_projects where project_id = ?", (project_id,))
        conn.execute("delete from projects where id = ?", (project_id,))
    return True


def assign_session_project(session_id: str, project_id: str | None) -> None:
    now = utc_now()
    with connect() as conn:
        conn.execute(
            "update sessions set project_id = ?, updated_at = ? where id = ?",
            (project_id, now, session_id),
        )


# NOTE (D8): `sessions_with_latest_code_path` and `record_project_unassignment`
# lived here — both were project-only (v2.1) AND broken against the v2 schema
# (they referenced the dropped `code`/`kind`/`step_number`/`used_project_formalizations`
# columns). Removed rather than left as landmines; the projects feature rewrites its
# store layer against the git-backed code_steps when it returns. The dormant project
# CRUD below (projects table) stays as the v2.1 foundation.


def validate_project_slug(slug: str) -> str:
    value = str(slug or "").strip()
    if not PROJECT_SLUG_RE.fullmatch(value):
        raise ValueError("Project slug must be 1-80 characters using letters, numbers, '_' or '-'.")
    return value


# --- Skills (Skill Factory, v2.1.1 W1) ------------------------------------------
# A skill is a DB row (markdown `body` in a column), not a git file (D45). The
# scope model (D47): `is_global` → every project; else the `skill_projects` join;
# loose (project-less) sessions resolve to none. These queries are the store half
# of Slice 8 — CRUD + assignment + the project-resolution read; the routes (W2),
# run-time materialization (W3), and GitHub import (W4) build on top.


def slugify_skill(value: str) -> str:
    """Derive a skill slug from a name: lower-kebab, alphanumeric, ≤80 chars (D45).
    Runs of non-alphanumerics collapse to a single '-'; a leading non-letter/digit
    is dropped (slugs must be letter/digit-initial). Empty input → 'skill'."""
    text = str(value or "").strip().lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    text = text[:80].rstrip("-")
    return text or "skill"


def validate_skill_slug(slug: str) -> str:
    value = str(slug or "").strip()
    if not SKILL_SLUG_RE.fullmatch(value):
        raise ValueError(
            "Skill slug must be 1-80 characters of lowercase letters, numbers or '-', "
            "starting with a letter or number."
        )
    return value


def _unique_skill_slug(conn, base: str, exclude_id: str | None = None) -> str:
    """A slug not already taken by another skill, appending -2, -3, … on collision.
    `exclude_id` lets an update keep its own slug. Bounded retry so the unique
    constraint is the real backstop, not this loop."""
    base = validate_skill_slug(base)
    candidate = base
    suffix = 2
    while True:
        row = conn.execute(
            "select id from skills where slug = ?", (candidate,)
        ).fetchone()
        if row is None or row["id"] == exclude_id:
            return candidate
        candidate = validate_skill_slug(f"{base[:74]}-{suffix}")
        suffix += 1


def _skill_row(conn, skill_id: str) -> dict | None:
    row = conn.execute("select * from skills where id = ?", (skill_id,)).fetchone()
    if not row:
        return None
    data = _normalize_skill(row_to_dict(row))
    data["project_ids"] = [
        r["project_id"]
        for r in conn.execute(
            "select project_id from skill_projects where skill_id = ? order by project_id",
            (skill_id,),
        ).fetchall()
    ]
    return data


def create_skill(
    name: str,
    body: str,
    is_global: bool = False,
    source_url: str | None = None,
    source_ref: str | None = None,
    slug: str | None = None,
) -> dict:
    """Insert a skill row (D45). `slug` defaults to a unique slugify(name); when
    given explicitly it is validated and uniquified. The created row carries its
    (empty) `project_ids` so callers get the full assignment shape back."""
    clean_name = str(name or "").strip()
    if not clean_name:
        raise ValueError("Skill name is required.")
    base_slug = validate_skill_slug(slug) if slug else slugify_skill(clean_name)
    now = utc_now()
    skill_id = str(uuid4())
    with connect() as conn:
        final_slug = _unique_skill_slug(conn, base_slug)
        conn.execute(
            """
            insert into skills
                (id, name, slug, body, is_global, source_url, source_ref, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                skill_id,
                clean_name,
                final_slug,
                str(body or ""),
                1 if is_global else 0,
                source_url,
                source_ref,
                now,
                now,
            ),
        )
        return _skill_row(conn, skill_id)


def get_skill(skill_id: str) -> dict | None:
    with connect() as conn:
        return _skill_row(conn, skill_id)


def get_skill_by_slug(slug: str) -> dict | None:
    with connect() as conn:
        row = conn.execute("select id from skills where slug = ?", (slug,)).fetchone()
        return _skill_row(conn, row["id"]) if row else None


def list_skills() -> list[dict]:
    """All skills, newest first, each with its `project_ids` assignment list. The
    factory catalog (F11) renders global/▣-projects badges from this."""
    with connect() as conn:
        ids = [
            row["id"]
            for row in conn.execute(
                "select id from skills order by updated_at desc, name asc"
            ).fetchall()
        ]
        return [_skill_row(conn, skill_id) for skill_id in ids]


def update_skill(
    skill_id: str,
    name: str | None = None,
    body: str | None = None,
    source_url: str | None = None,
    source_ref: str | None = None,
) -> dict | None:
    """Update a skill's editable fields (name/body/provenance). The slug is the
    stable identifier (D45) and is NOT changed here. Pass a field as None to leave
    it untouched. Returns the updated row, or None if the id is unknown."""
    now = utc_now()
    with connect() as conn:
        current = conn.execute("select * from skills where id = ?", (skill_id,)).fetchone()
        if not current:
            return None
        cur = row_to_dict(current)
        new_name = cur["name"] if name is None else (str(name).strip() or cur["name"])
        conn.execute(
            """
            update skills
            set name = ?, body = ?, source_url = ?, source_ref = ?, updated_at = ?
            where id = ?
            """,
            (
                new_name,
                cur["body"] if body is None else str(body),
                cur["source_url"] if source_url is None else source_url,
                cur["source_ref"] if source_ref is None else source_ref,
                now,
                skill_id,
            ),
        )
        return _skill_row(conn, skill_id)


def set_skill_assignment(
    skill_id: str,
    is_global: bool,
    project_ids: list[str] | None = None,
) -> dict | None:
    """Set a skill's scope (D47): `is_global` plus the explicit per-project join.
    Replaces the join wholesale with `project_ids` (deduped, unknown ids rejected).
    When `is_global` is True the join is still stored but unused at resolution time
    — kept so toggling global off restores the prior per-project set is the caller's
    job; here global simply wins. Returns the updated row, or None if unknown."""
    ids = list(dict.fromkeys(project_ids or []))
    now = utc_now()
    with connect() as conn:
        if not conn.execute("select 1 from skills where id = ?", (skill_id,)).fetchone():
            return None
        if ids:
            marks = ",".join("?" for _ in ids)
            known = {
                r["id"]
                for r in conn.execute(
                    f"select id from projects where id in ({marks})", ids
                ).fetchall()
            }
            missing = [pid for pid in ids if pid not in known]
            if missing:
                raise ValueError(f"Unknown project id(s): {', '.join(missing)}")
        conn.execute("delete from skill_projects where skill_id = ?", (skill_id,))
        for project_id in ids:
            conn.execute(
                "insert into skill_projects (skill_id, project_id) values (?, ?)",
                (skill_id, project_id),
            )
        conn.execute(
            "update skills set is_global = ?, updated_at = ? where id = ?",
            (1 if is_global else 0, now, skill_id),
        )
        return _skill_row(conn, skill_id)


def delete_skill(skill_id: str) -> bool:
    """Delete a skill and cascade its `skill_projects` rows. Returns False if absent."""
    with connect() as conn:
        if not conn.execute("select 1 from skills where id = ?", (skill_id,)).fetchone():
            return False
        conn.execute("delete from skill_projects where skill_id = ?", (skill_id,))
        conn.execute("delete from skills where id = ?", (skill_id,))
    return True


def skills_for_project(project_id: str) -> list[dict]:
    """The skills that resolve for a project: global ∪ assigned (D47), newest first.
    This is the run-time resolution read W3 materializes to `cfg.skills`. A loose
    (project-less) session never calls this — it resolves to [] by definition."""
    with connect() as conn:
        ids = [
            row["id"]
            for row in conn.execute(
                """
                select id from skills
                where is_global = 1
                   or id in (select skill_id from skill_projects where project_id = ?)
                order by updated_at desc, name asc
                """,
                (project_id,),
            ).fetchall()
        ]
        return [_skill_row(conn, skill_id) for skill_id in ids]


def _normalize_skill(row: dict) -> dict:
    row["is_global"] = bool(row.get("is_global"))
    return row


def update_run(
    run_id: str,
    status: str,
    final_text: str | None = None,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    cost_usd: float | None = None,
    result_kind: str | None = None,
    result_detail: str | None = None,
) -> None:
    now = utc_now()
    with connect() as conn:
        conn.execute(
            """
            update runs
            set status = ?,
                final_text = coalesce(?, final_text),
                result_kind = coalesce(?, result_kind),
                result_detail = coalesce(?, result_detail),
                input_tokens = coalesce(?, input_tokens),
                output_tokens = coalesce(?, output_tokens),
                cost_usd = coalesce(?, cost_usd),
                updated_at = ?
            where id = ?
            """,
            (status, final_text, result_kind, result_detail, input_tokens, output_tokens, cost_usd, now, run_id),
        )


def fail_stale_active_runs() -> int:
    """Crash recovery, called once at startup: a run still `running` in the DB
    has no live worker after a restart, so mark it failed. `pending` runs are
    NOT reaped anymore (Phase 2): they are honest queue entries that
    bridge.recover_runs_at_startup re-enqueues, so queued work survives a
    restart instead of being stranded. Returns the count reaped."""
    now = utc_now()
    detail = "Run did not finish: the adapter restarted before it completed."
    with connect() as conn:
        cursor = conn.execute(
            """
            update runs
            set status = 'failed',
                result_kind = coalesce(result_kind, 'failed'),
                result_detail = coalesce(result_detail, ?),
                updated_at = ?
            where status = 'running'
            """,
            (detail, now),
        )
        return cursor.rowcount


def set_run_api_run_id(run_id: str, api_run_id: str) -> None:
    now = utc_now()
    with connect() as conn:
        conn.execute(
            "update runs set api_run_id = ?, updated_at = ? where id = ?",
            (api_run_id, now, run_id),
        )


def set_run_pending_approval(run_id: str, pending_approval: dict | None) -> None:
    now = utc_now()
    value = json.dumps(pending_approval) if pending_approval is not None else None
    with connect() as conn:
        conn.execute(
            "update runs set pending_approval = ?, updated_at = ? where id = ?",
            (value, now, run_id),
        )


def set_session_safe_verify(session_id: str, status: str, detail: str | None) -> None:
    """Persist a standalone /verify verdict on the session's latest run, so it
    survives reload (the endpoint is run-less; the latest run is the proof run,
    and session_detail surfaces it as `safe_verify`)."""
    with connect() as conn:
        row = conn.execute(
            "select id from runs where session_id = ? order by created_at desc, id desc limit 1",
            (session_id,),
        ).fetchone()
        if not row:
            return
        conn.execute(
            "update runs set safe_verify_status = ?, safe_verify_detail = ?, updated_at = ? where id = ?",
            (status, detail, utc_now(), row["id"]),
        )


def latest_code_step_for_path(session_id: str, path: str) -> dict | None:
    """The most recent code_step for a file in a session (newest seq wins).

    The standalone lean-check / verify endpoints use this to back-fill the verdict
    onto the current working step (the canvas's latest snapshot of that file)."""
    with connect() as conn:
        row = conn.execute(
            "select * from code_steps where session_id = ? and path = ? "
            "order by seq desc, created_at desc limit 1",
            (session_id, path),
        ).fetchone()
    return row_to_dict(row) if row else None


def code_steps_for_project_path(project_id: str, path: str) -> list[dict]:
    """Every code_step for a file across a project's sessions, newest first — the raw
    material for a blueprint node's status + session attribution (D29). Joins on the
    session's project_id so loose sessions never leak in. Ordered by `created_at`
    (cross-session recency; `seq` is only meaningful within one session), so the first
    row is the latest verdict and the distinct session order is newest-touched-first."""
    with connect() as conn:
        rows = conn.execute(
            "select c.* from code_steps c join sessions s on s.id = c.session_id "
            "where s.project_id = ? and c.path = ? "
            "order by c.created_at desc, c.seq desc",
            (project_id, path),
        ).fetchall()
    return [row_to_dict(r) for r in rows]


def safe_verify_ok_sessions(project_id: str) -> set[str]:
    """Project session ids whose *latest* run holds a passing SafeVerify verdict.

    The verdict is stored on the session's newest run (`set_session_safe_verify`);
    a human edit clears it (routes/sessions.py) and a fresh agent run supersedes it
    (the new latest run carries no verdict), so 'ok' here means the session's
    current working file was audited — not a stale earlier state. Feeds the blueprint
    graph's `verified` flag: a node is SafeVerify-audited iff the session that owns
    its file's latest code_step is in this set."""
    with connect() as conn:
        rows = conn.execute(
            "select s.id from sessions s "
            "join runs r on r.id = ("
            "  select id from runs where session_id = s.id order by created_at desc, id desc limit 1"
            ") "
            "where s.project_id = ? and r.safe_verify_status = 'ok'",
            (project_id,),
        ).fetchall()
    return {row["id"] for row in rows}


def latest_agent_code_step(session_id: str) -> dict | None:
    """The most recent agent-authored code_step — the proof state the agent last
    'knew' (D12). Diffing its commit against HEAD reveals any human edits since."""
    with connect() as conn:
        row = conn.execute(
            "select * from code_steps where session_id = ? and author = 'agent' "
            "order by seq desc limit 1",
            (session_id,),
        ).fetchone()
    return row_to_dict(row) if row else None


def edit_notes_since(session_id: str, seq: int) -> list[str]:
    """Edit-note explanations (D11) recorded after a given timeline position —
    the human's words about edits made since the agent last acted (D12)."""
    with connect() as conn:
        rows = conn.execute(
            "select content from messages where session_id = ? and kind = 'edit_note' and seq > ? "
            "order by seq asc",
            (session_id, seq),
        ).fetchall()
    return [row["content"] for row in rows]


def get_run(run_id: str) -> dict | None:
    with connect() as conn:
        row = conn.execute("select * from runs where id = ?", (run_id,)).fetchone()
    return _normalize_run(row_to_dict(row)) if row else None


def list_runs_by_status(status: str) -> list[dict]:
    """All runs with a given status, in creation (FIFO) order — used by the run
    worker's startup recovery (PLAN-system-hardening Phase 2)."""
    with connect() as conn:
        rows = conn.execute(
            "select * from runs where status = ? order by created_at asc, id asc",
            (status,),
        ).fetchall()
    return [_normalize_run(row_to_dict(row)) for row in rows]


# --- Structured artifact index (PLAN-system-hardening 4.1) -------------------
# One row per (scope, declaration): "declaration X currently lives at path Y".
# Written by the run finalizer; read by the Overleaf companion instead of
# reverse-engineering artifacts from registry-markdown diffs.

def upsert_artifact(
    *,
    project_id: str | None,
    session_id: str | None,
    run_id: str | None,
    declaration_name: str,
    kind: str | None,
    path: str,
    module_name: str | None,
) -> dict:
    scope = project_id or session_id
    if not scope:
        raise ValueError("an artifact needs a project or a session scope")
    now = utc_now()
    with connect() as conn:
        existing = conn.execute(
            "select id from artifacts where scope = ? and declaration_name = ?",
            (scope, declaration_name),
        ).fetchone()
        if existing:
            conn.execute(
                "update artifacts set project_id = ?, session_id = ?, run_id = ?,"
                " kind = ?, path = ?, module_name = ?, updated_at = ? where id = ?",
                (project_id, session_id, run_id, kind, path, module_name, now, existing["id"]),
            )
            artifact_id = existing["id"]
        else:
            artifact_id = str(uuid4())
            conn.execute(
                "insert into artifacts (id, scope, project_id, session_id, run_id,"
                " declaration_name, kind, path, module_name, created_at, updated_at)"
                " values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (artifact_id, scope, project_id, session_id, run_id,
                 declaration_name, kind, path, module_name, now, now),
            )
        row = conn.execute("select * from artifacts where id = ?", (artifact_id,)).fetchone()
    return row_to_dict(row)


def latest_check_for_project_path(project_id: str, path: str) -> dict | None:
    """The newest recorded check verdict for a repo-relative path across ALL of
    a project's sessions (they share one repo, D24). One of the ledger facts
    the target-status endpoint serves (PLAN 4.4): agent runs, manual edits,
    and cascade re-checks all land here as code_steps."""
    with connect() as conn:
        row = conn.execute(
            """
            select cs.check_status, cs.check_detail, cs.author, cs.created_at
            from code_steps cs
            join sessions s on s.id = cs.session_id
            where s.project_id = ? and cs.path = ? and cs.check_status is not null
            order by cs.created_at desc, cs.seq desc
            limit 1
            """,
            (project_id, path),
        ).fetchone()
    return row_to_dict(row) if row else None


def list_artifacts_for_scope(scope: str) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            "select * from artifacts where scope = ? order by declaration_name asc",
            (scope,),
        ).fetchall()
    return [row_to_dict(row) for row in rows]


def queue_position(run_id: str) -> int | None:
    """How many pending runs precede this pending run (0 = next up). None when
    the run is not pending. Derived, never stored — invariant 2."""
    with connect() as conn:
        row = conn.execute(
            "select created_at, id, status from runs where id = ?", (run_id,)
        ).fetchone()
        if not row or row["status"] != "pending":
            return None
        ahead = conn.execute(
            "select count(*) as n from runs where status = 'pending'"
            " and (created_at < ? or (created_at = ? and id < ?))",
            (row["created_at"], row["created_at"], row["id"]),
        ).fetchone()
    return int(ahead["n"])


def set_run_transcript(run_id: str, messages: list) -> None:
    """Persist the faithful prover conversation at this run's end (D16/multi-turn).

    `messages` is the prover's `Finished.transcript["messages"]` — the structured
    model-replay conversation (tool_call/tool_result parts intact, raw_part already
    stripped). Stored as JSON; the next activation in the session replays it as the
    base. Only called on a Finished run, so an errored run leaves this NULL.
    """
    with connect() as conn:
        conn.execute(
            "update runs set transcript = ?, updated_at = ? where id = ?",
            (json.dumps(messages), utc_now(), run_id),
        )


def latest_transcript_for_session(session_id: str, exclude_run_id: str | None = None) -> list | None:
    """The most recent stored transcript in the session — the base for the next run.

    Each activation receives the prior transcript and returns the full updated one,
    so the latest run that has a transcript holds the whole conversation so far.
    `exclude_run_id` skips the current (just-created, transcript-less) run. Returns
    None when the session has no prior Finished run (a cold first activation).
    """
    with connect() as conn:
        row = conn.execute(
            """
            select transcript from runs
            where session_id = ? and transcript is not null and id != ?
            order by created_at desc, id desc
            limit 1
            """,
            (session_id, exclude_run_id or ""),
        ).fetchone()
    if not row or row["transcript"] is None:
        return None
    return json.loads(row["transcript"])


def add_message(
    session_id: str,
    role: str,
    content: str,
    run_id: str | None = None,
    kind: str = "assistant",
    commit_sha: str | None = None,
) -> dict:
    """Append a transcript message. A user's edit explanation (D11) is just this
    with `kind='edit_note'` + `commit_sha` set to the edit's commit — no bespoke
    channel; it rides the same path that feeds context to the prover."""
    now = utc_now()
    message_id = str(uuid4())
    with connect() as conn:
        seq = _next_seq(conn, session_id)
        conn.execute(
            """
            insert into messages (id, session_id, run_id, role, content, kind, commit_sha, seq, created_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (message_id, session_id, run_id, role, content, kind, commit_sha, seq, now),
        )
        row = conn.execute("select * from messages where id = ?", (message_id,)).fetchone()
    touch_session(session_id)
    return row_to_dict(row)


def _next_seq(conn, session_id: str) -> int:
    """The next shared timeline position for a session (C4): one monotonic counter
    that both messages and code_steps draw from, so the thread is an ORDER BY seq
    merge. Runs on the insert's own connection, so the read+write are atomic under
    SQLite's single-writer lock (same max+1 pattern the old step_number used)."""
    row = conn.execute(
        """
        select coalesce(max(seq), 0) + 1 as next from (
            select seq from code_steps where session_id = ?
            union all
            select seq from messages where session_id = ?
        )
        """,
        (session_id, session_id),
    ).fetchone()
    return int(row["next"])


def add_code_step(
    session_id: str,
    run_id: str | None,
    path: str,
    *,
    commit_sha: str,
    author: str = "agent",
    summary: str | None = None,
    turn: int | None = None,
    check_status: str | None = None,
    check_detail: str | None = None,
    artifact_kind: str | None = None,
) -> dict:
    """Record a curated timeline step pointing at a git commit (D7/D8).

    `commit_sha` is the pointer into the session's git repo where the content
    lives — it is keyword-only and required, so a v1-style positional call that
    passed file *text* fails loudly instead of silently storing code as a sha.
    `run_id` is NULL for user edits made outside a run (D9); `turn` is NULL for
    user edits. The verdict (`check_status`/`check_detail`) is recorded here, not
    in the commit message (D6), and may be back-filled once `lean_check` returns.

    `author` is a free-text convention, not an enforced enum: `'agent'` (a
    model turn), `'user'` (a manual canvas edit, D9), or `'cascade'` (a
    re-verification of an *unchanged* file, triggered by an edit to something
    it imports elsewhere in the project — see
    docs/FEATURE-overleaf-lean-pane-manual-edit.md). A cascade step typically
    reuses the file's existing `commit_sha` since nothing on disk changed.
    """
    now = utc_now()
    step_id = str(uuid4())
    with connect() as conn:
        seq = _next_seq(conn, session_id)
        conn.execute(
            """
            insert into code_steps (
                id, session_id, run_id, seq, turn, author, path,
                commit_sha, summary, check_status, check_detail, artifact_kind, created_at
            )
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                step_id,
                session_id,
                run_id,
                seq,
                turn,
                author,
                path,
                commit_sha,
                summary,
                check_status,
                check_detail,
                artifact_kind if check_status == "ok" else None,
                now,
            ),
        )
        inserted = conn.execute("select * from code_steps where id = ?", (step_id,)).fetchone()
    touch_session(session_id)
    return row_to_dict(inserted)


def has_active_run(session_id: str) -> bool:
    """True if the session has a pending/running agent run — the modal lock (D62):
    a user write is refused while the agent is mid-run so the two never race on the
    same file. Same status set the derived session status uses for `active_run_count`."""
    with connect() as conn:
        row = conn.execute(
            "select 1 from runs where session_id = ? and status in ('pending', 'running') limit 1",
            (session_id,),
        ).fetchone()
    return row is not None


def upsert_user_code_step(session_id: str, path: str, *, commit_sha: str) -> dict:
    """Record a user edit, coalescing rapid successive edits into one timeline step.

    Auto-save (v2.2) commits on every debounced keystroke-pause, which would spray
    the History stepper with one 'your edit' step per save. So if the file's latest
    step is already an *uncommitted-to-a-run* user edit (author='user', run_id NULL),
    we repoint that step at the new commit and clear its stale verdict — one step
    that tracks the newest content — instead of inserting a new row. A step authored
    by the agent (or a user edit for a different file) still starts a fresh step, so
    the human/agent boundary in the timeline is preserved. Git keeps every commit;
    only the curated timeline coalesces (D7/D8)."""
    latest = latest_code_step_for_path(session_id, path)
    if latest and latest.get("author") == "user" and latest.get("run_id") is None:
        with connect() as conn:
            conn.execute(
                "update code_steps set commit_sha = ?, check_status = NULL, check_detail = NULL "
                "where id = ?",
                (commit_sha, latest["id"]),
            )
            row = conn.execute("select * from code_steps where id = ?", (latest["id"],)).fetchone()
        touch_session(session_id)
        return row_to_dict(row)
    return add_code_step(session_id, None, path, commit_sha=commit_sha, author="user")


def set_code_step_check(
    step_id: str,
    check_status: str,
    check_detail: str | None = None,
    artifact_kind: str | None = None,
) -> dict | None:
    """Back-fill a code_step's verdict once `lean_check` returns (D6).

    A write is committed and its row inserted *before* the check runs (FileChanged
    precedes CheckResult), so the verdict lands here, on the existing row, rather
    than in the commit message. Returns the updated row, or None if the id is
    unknown.
    """
    now = utc_now()
    with connect() as conn:
        conn.execute(
            "update code_steps set check_status = ?, check_detail = ?, artifact_kind = ? where id = ?",
            (check_status, check_detail, artifact_kind if check_status == "ok" else None, step_id),
        )
        row = conn.execute("select * from code_steps where id = ?", (step_id,)).fetchone()
    return row_to_dict(row) if row else None


def add_status_event(
    session_id: str,
    run_id: str,
    message: str,
    status: str | None = None,
    step_number: int | None = None,
) -> dict:
    now = utc_now()
    event_id = str(uuid4())
    with connect() as conn:
        conn.execute(
            """
            insert into status_events (id, session_id, run_id, step_number, status, message, created_at)
            values (?, ?, ?, ?, ?, ?, ?)
            """,
            (event_id, session_id, run_id, step_number, status, message, now),
        )
        row = conn.execute("select * from status_events where id = ?", (event_id,)).fetchone()
    return row_to_dict(row)


def replace_run_usage_breakdown(run_id: str, rows: list[dict[str, Any]]) -> None:
    now = utc_now()
    with connect() as conn:
        run = conn.execute("select * from runs where id = ?", (run_id,)).fetchone()
        if not run:
            return
        run_dict = row_to_dict(run)
        session_id = str(run_dict["session_id"])
        run_ids = [
            str(row["id"])
            for row in conn.execute(
                "select id from runs where session_id = ? order by created_at asc, id asc",
                (session_id,),
            ).fetchall()
        ]
        run_number = run_ids.index(run_id) + 1 if run_id in run_ids else 1
        conn.execute("delete from run_usage_breakdown where run_id = ?", (run_id,))
        for index, row in enumerate(rows, start=1):
            conn.execute(
                """
                insert into run_usage_breakdown (
                    id, session_id, run_id, run_number, ordinal, phase, label, turn, candidate,
                    input_tokens, output_tokens, cost_usd, event_count, created_at
                )
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(row.get("id") or uuid4()),
                    session_id,
                    run_id,
                    run_number,
                    int(row.get("ordinal") or index),
                    str(row.get("phase") or "unattributed"),
                    str(row.get("label") or "Unattributed usage"),
                    _optional_int(row.get("turn")),
                    _optional_int(row.get("candidate")),
                    int(row.get("input_tokens") or 0),
                    int(row.get("output_tokens") or 0),
                    float(row.get("cost_usd") or 0),
                    int(row.get("event_count") or 0),
                    str(row.get("created_at") or now),
                ),
            )


def usage_breakdown_for_session(session_id: str) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            """
            select *
            from run_usage_breakdown
            where session_id = ?
            order by run_number asc, ordinal asc, created_at asc
            """,
            (session_id,),
        ).fetchall()
    persisted = [_normalize_usage_breakdown_row(row_to_dict(row)) for row in rows]
    if persisted:
        return persisted
    return _usage_breakdown_from_raw_logs(session_id)


def session_detail(session_id: str) -> dict | None:
    session = get_session(session_id)
    if not session:
        return None
    with connect() as conn:
        usage_row = conn.execute(
            """
            select
                coalesce(sum(input_tokens), 0) as input_tokens,
                coalesce(sum(output_tokens), 0) as output_tokens,
                coalesce(sum(input_tokens + output_tokens), 0) as total_tokens,
                coalesce(sum(cost_usd), 0) as cost_usd,
                count(*) as run_count,
                (
                    select model
                    from runs
                    where session_id = ?
                    order by updated_at desc, created_at desc
                    limit 1
                ) as primary_model,
                group_concat(distinct model) as models
            from runs
            where session_id = ?
            """,
            (session_id, session_id),
        ).fetchone()
        # both ordered by the shared timeline seq (C4) so the frontend merges them
        # into one thread by a single key, not by index-pairing
        messages = conn.execute(
            "select * from messages where session_id = ? order by seq asc",
            (session_id,),
        ).fetchall()
        code_steps = conn.execute(
            "select * from code_steps where session_id = ? order by seq asc",
            (session_id,),
        ).fetchall()
        status_events = conn.execute(
            "select * from status_events where session_id = ? order by created_at asc",
            (session_id,),
        ).fetchall()
        active_run = conn.execute(
            """
            select *
            from runs
            where session_id = ? and status in ('pending', 'running')
            order by updated_at desc, created_at desc
            limit 1
            """,
            (session_id,),
        ).fetchone()
        latest_run = conn.execute(
            "select * from runs where session_id = ? order by created_at desc, id desc limit 1",
            (session_id,),
        ).fetchone()
        # Per-run outcomes (id + status), so the UI can place the "Proved"
        # milestone after the run that completed — live and on reload (M16).
        # Usage columns ride along for the Overleaf companion, whose
        # fetchApiRunUsage reads this run's tokens/cost off the persisted row
        # (they were missing here, so every companion job recorded $0 — caught
        # by the Phase 1 integration harness, PLAN-system-hardening).
        runs = conn.execute(
            "select id, status, result_kind, result_detail,"
            " input_tokens, output_tokens, cost_usd"
            " from runs where session_id = ? order by created_at asc, id asc",
            (session_id,),
        ).fetchall()
        project = None
        if session.get("project_id"):
            project = conn.execute(
                "select * from projects where id = ?",
                (session["project_id"],),
            ).fetchone()
    usage = _normalize_usage_session(
        {
            **(row_to_dict(usage_row) if usage_row else {}),
            "message_count": len(messages),
            "started_at": session["created_at"],
            "ended_at": session["updated_at"],
            "duration_seconds": _duration_seconds(session["created_at"], session["updated_at"]),
        }
    )
    # working-copy verdict, derived from the latest *real* code_step (asc by seq).
    # Scratch/probe files (exact?/apply? scratchpads) are excluded so a session is
    # only 'ok' when an actual proof compiles, not when a throwaway probe does (M14).
    real_steps = [c for c in code_steps if "scratch" not in (c["path"] or "").lower()]
    latest_check_status = real_steps[-1]["check_status"] if real_steps else None
    latest_artifact_kind = real_steps[-1]["artifact_kind"] if real_steps else None
    latest_code_run_status = None
    if real_steps and real_steps[-1]["run_id"]:
        with connect() as conn:
            run_row = conn.execute(
                "select status from runs where id = ?",
                (real_steps[-1]["run_id"],),
            ).fetchone()
        latest_code_run_status = run_row["status"] if run_row else None
    return {
        **session,
        **usage,
        "status": _derive_session_status(
            latest_check_status, latest_artifact_kind, len(real_steps), active_run is not None, latest_code_run_status
        ),
        "messages": [row_to_dict(row) for row in messages],
        "code_steps": [_normalize_code_step(row_to_dict(row)) for row in code_steps],
        "status_events": [row_to_dict(row) for row in status_events],
        "approval_events": approval_events_for_session(session_id),
        "usage_breakdown": usage_breakdown_for_session(session_id),
        "active_run": _normalize_run(row_to_dict(active_run)) if active_run else None,
        "runs": [row_to_dict(r) for r in runs],
        "safe_verify": _safe_verify_summary(row_to_dict(latest_run)) if latest_run else None,
        "project": row_to_dict(project) if project else None,
    }


def _derive_session_status(
    latest_check_status: str | None,
    latest_artifact_kind: str | None,
    code_step_count: int,
    has_active_run: bool = False,
    latest_code_run_status: str | None = None,
) -> str:
    """A session's status is its working-copy verdict (D14), derived — never stored.
    Once any code exists the verdict rules (latest step's check_status, or
    'unchecked' before it lands) — run lifecycle stays out of it, per D14. The one
    addition: a session with *no code yet* but an active run (pending/running) reads
    'running' instead of 'empty', so a freshly registered formalization — including
    an Overleaf-driven one whose first file hasn't been written yet — surfaces as
    in-progress in the session list and stats the moment it starts."""
    if code_step_count:
        if latest_check_status == "ok":
            if latest_code_run_status == "disproved":
                return "disproved"
            if latest_artifact_kind == "definition":
                return "defined"
            if latest_artifact_kind in {"proof", "mixed"}:
                return "proved"
            return "ok"
        return latest_check_status or "unchecked"
    if has_active_run:
        return "running"
    return "empty"


def _safe_verify_summary(run: dict) -> dict | None:
    """The latest run's SafeVerify verdict, for showing/auto-firing on reload."""
    status = run.get("safe_verify_status")
    if not status:
        return None
    return {"run_id": run.get("id"), "status": status, "detail": run.get("safe_verify_detail")}


def usage_stats() -> dict:
    sessions = list_sessions()
    with connect() as conn:
        daily_rows = conn.execute(
            """
            select
                date(updated_at) as day,
                coalesce(sum(input_tokens), 0) as input_tokens,
                coalesce(sum(output_tokens), 0) as output_tokens,
                coalesce(sum(input_tokens + output_tokens), 0) as total_tokens,
                coalesce(sum(cost_usd), 0) as cost_usd,
                count(distinct id) as run_count,
                count(distinct session_id) as session_count
            from runs
            group by date(updated_at)
            order by day asc
            """
        ).fetchall()
        model_rows = conn.execute(
            """
            select
                model,
                coalesce(sum(input_tokens), 0) as input_tokens,
                coalesce(sum(output_tokens), 0) as output_tokens,
                coalesce(sum(input_tokens + output_tokens), 0) as total_tokens,
                coalesce(sum(cost_usd), 0) as cost_usd,
                count(*) as run_count,
                count(distinct session_id) as session_count
            from runs
            group by model
            order by cost_usd desc, total_tokens desc
            """
        ).fetchall()

    total_sessions = len(sessions)
    total_messages = sum(int(session["message_count"]) for session in sessions)
    input_tokens = sum(int(session["input_tokens"]) for session in sessions)
    output_tokens = sum(int(session["output_tokens"]) for session in sessions)
    total_tokens = input_tokens + output_tokens
    cost_usd = sum(float(session["cost_usd"]) for session in sessions)

    return {
        "sessions": sessions,
        "origins": _origin_rollup(sessions),
        "global": {
            "session_count": total_sessions,
            "message_count": total_messages,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": total_tokens,
            "cost_usd": cost_usd,
            "average_tokens_per_session": round(total_tokens / total_sessions) if total_sessions else 0,
            "average_cost_per_session": cost_usd / total_sessions if total_sessions else 0,
            "average_messages_per_session": round(total_messages / total_sessions) if total_sessions else 0,
        },
        "daily": [_normalize_usage_day(row_to_dict(row)) for row in daily_rows],
        "models": [_normalize_usage_model(row_to_dict(row)) for row in model_rows],
    }


def _origin_rollup(sessions: list[dict]) -> list[dict]:
    """Per-origin usage rollup for the Stats "By origin" tab (Direct UI vs Overleaf).

    Aggregated from the same `sessions` rows the `global` totals come from, so the two
    always agree. Both 'ui' and 'overleaf' rows are always emitted (zeros when absent)
    so the UI layout is stable. An unexpected origin value falls back to 'ui'."""
    buckets: dict[str, dict] = {
        origin: {
            "origin": origin,
            "session_count": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
            "cost_usd": 0.0,
        }
        for origin in ("ui", "overleaf")
    }
    for session in sessions:
        origin = str(session.get("origin") or "ui")
        bucket = buckets.setdefault(
            origin,
            {
                "origin": origin,
                "session_count": 0,
                "input_tokens": 0,
                "output_tokens": 0,
                "total_tokens": 0,
                "cost_usd": 0.0,
            },
        )
        bucket["session_count"] += 1
        bucket["input_tokens"] += int(session.get("input_tokens") or 0)
        bucket["output_tokens"] += int(session.get("output_tokens") or 0)
        bucket["total_tokens"] += int(session.get("total_tokens") or 0)
        bucket["cost_usd"] += float(session.get("cost_usd") or 0)
    # 'ui' and 'overleaf' first (stable UI order), then any unexpected origins.
    ordered = ["ui", "overleaf"] + [k for k in buckets if k not in ("ui", "overleaf")]
    return [buckets[k] for k in ordered]


def _normalize_usage_session(row: dict) -> dict:
    models = [
        model for model in str(row.get("models") or "").split(",")
        if model
    ]
    row["models"] = models
    row["primary_model"] = row.get("primary_model") or (models[0] if models else None)
    for key in ("input_tokens", "output_tokens", "total_tokens", "message_count", "run_count", "duration_seconds"):
        row[key] = int(row.get(key) or 0)
    row["cost_usd"] = float(row.get("cost_usd") or 0)
    row["started_at"] = row.get("started_at")
    row["ended_at"] = row.get("ended_at")
    return row


def _normalize_code_step(row: dict) -> dict:
    # v2: a code_step is a plain pointer row (commit_sha + path + verdict); there
    # is nothing to decode. The JSON `used_project_formalizations` field was
    # dropped with the projects feature (deferred to v2.1). Kept as the single
    # read-side hook in case future presentation fields need shaping.
    return row


def _normalize_usage_day(row: dict) -> dict:
    for key in ("input_tokens", "output_tokens", "total_tokens", "run_count", "session_count"):
        row[key] = int(row.get(key) or 0)
    row["cost_usd"] = float(row.get("cost_usd") or 0)
    return row


def _normalize_usage_model(row: dict) -> dict:
    row["model"] = row.get("model") or "unknown"
    for key in ("input_tokens", "output_tokens", "total_tokens", "run_count", "session_count"):
        row[key] = int(row.get(key) or 0)
    row["cost_usd"] = float(row.get("cost_usd") or 0)
    return row


def _normalize_usage_breakdown_row(row: dict) -> dict:
    for key in ("run_number", "ordinal", "input_tokens", "output_tokens", "event_count"):
        row[key] = int(row.get(key) or 0)
    row["turn"] = _optional_int(row.get("turn"))
    row["candidate"] = _optional_int(row.get("candidate"))
    row["cost_usd"] = float(row.get("cost_usd") or 0)
    row["total_tokens"] = int(row["input_tokens"]) + int(row["output_tokens"])
    return row


def _normalize_run(row: dict) -> dict:
    raw_pending = row.get("pending_approval")
    if isinstance(raw_pending, str) and raw_pending:
        try:
            row["pending_approval"] = json.loads(raw_pending)
        except json.JSONDecodeError:
            row["pending_approval"] = None
    else:
        row["pending_approval"] = None
    return row


def _duration_seconds(started_at: str | None, ended_at: str | None) -> int:
    if not started_at or not ended_at:
        return 0
    from datetime import datetime

    try:
        started = datetime.fromisoformat(started_at)
        ended = datetime.fromisoformat(ended_at)
    except ValueError:
        return 0
    return max(0, int((ended - started).total_seconds()))


def _usage_breakdown_from_raw_logs(session_id: str) -> list[dict]:
    with connect() as conn:
        runs = [
            row_to_dict(row)
            for row in conn.execute(
                """
                select id, input_tokens, output_tokens, cost_usd
                from runs
                where session_id = ?
                order by created_at asc, id asc
                """,
                (session_id,),
            ).fetchall()
        ]
    rows: list[dict] = []
    for run_number, run in enumerate(runs, start=1):
        log_path = RAW_EVENT_LOG_DIR / f"{run['id']}.jsonl"
        if not log_path.exists():
            continue
        run_rows, totals = _usage_breakdown_from_log(log_path, run_number)
        input_total = max(int(run.get("input_tokens") or 0), int(totals.get("input_tokens") or 0))
        output_total = max(int(run.get("output_tokens") or 0), int(totals.get("output_tokens") or 0))
        cost_total = max(float(run.get("cost_usd") or 0), float(totals.get("cost_usd") or 0))
        _append_unattributed_usage(run_rows, input_total, output_total, cost_total, run_number)
        for ordinal, row in enumerate(run_rows, start=1):
            row["ordinal"] = ordinal
        rows.extend(_normalize_usage_breakdown_row(row) for row in run_rows)
    return rows


def approval_events_for_session(session_id: str) -> list[dict]:
    with connect() as conn:
        runs = [
            row_to_dict(row)
            for row in conn.execute(
                """
                select id
                from runs
                where session_id = ?
                order by created_at asc, id asc
                """,
                (session_id,),
            ).fetchall()
        ]
    approvals: list[dict] = []
    for run in runs:
        log_path = RAW_EVENT_LOG_DIR / f"{run['id']}.jsonl"
        if not log_path.exists():
            continue
        approvals.extend(_approval_events_from_log(log_path, run["id"], session_id))
    return approvals


def _approval_events_from_log(path, run_id: str, session_id: str) -> list[dict]:
    approvals: dict[str, dict] = {}
    order: list[str] = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            try:
                frame = json.loads(line)
            except json.JSONDecodeError:
                continue
            payload = frame.get("payload") if isinstance(frame.get("payload"), dict) else frame
            frame_type = str(frame.get("type") or _event_type(payload)).lower()
            approval_id = str(payload.get("approval_id") or "")
            if not approval_id:
                continue
            if frame_type == "approval_requested":
                if approval_id not in approvals:
                    order.append(approval_id)
                approvals[approval_id] = {
                    "id": f"{run_id}:{approval_id}",
                    "session_id": session_id,
                    "run_id": run_id,
                    "approval_id": approval_id,
                    "tier": payload.get("tier"),
                    "candidate": _optional_int(payload.get("candidate")),
                    "lean_code": str(payload.get("lean_code") or ""),
                    "theorem_name": payload.get("theorem_name"),
                    "check_result": payload.get("check_result"),
                    "decision": None,
                    "feedback": None,
                    "resolved_at": None,
                }
            elif frame_type == "approval_resolved" and approval_id in approvals:
                approvals[approval_id]["decision"] = payload.get("decision") or "resolved"
                approvals[approval_id]["feedback"] = payload.get("feedback")
                approvals[approval_id]["resolved_at"] = payload.get("created_at")
    return [approvals[approval_id] for approval_id in order if approval_id in approvals]


def _usage_breakdown_from_log(path, run_number: int) -> tuple[list[dict], dict[str, float | int]]:
    rows: list[dict] = []
    current_turn: int | None = None
    totals: dict[str, float | int] = {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            try:
                frame = json.loads(line)
            except json.JSONDecodeError:
                continue
            payload = frame.get("payload") if isinstance(frame.get("payload"), dict) else frame
            frame_type = str(frame.get("type") or _event_type(payload)).lower()
            if frame_type == "turn_started":
                current_turn = _first_int(payload, "turn")
            if frame_type == "approval_requested":
                candidate = _first_int(payload, "candidate")
                preflight = _last_unlabeled_preflight(rows)
                if preflight is not None and candidate is not None:
                    preflight["candidate"] = candidate
                    preflight["label"] = f"Theorem translation preflight candidate {candidate}"

            input_tokens, output_tokens = _frame_usage(payload)
            cost_usd = _frame_cost(payload)
            if frame_type == "usage_updated":
                _add_usage_breakdown_event(rows, run_number, current_turn, input_tokens, output_tokens, cost_usd)
            elif frame_type in {"finished", "run_status"}:
                totals["input_tokens"] = max(int(totals["input_tokens"]), input_tokens or 0)
                totals["output_tokens"] = max(int(totals["output_tokens"]), output_tokens or 0)
                totals["cost_usd"] = max(float(totals["cost_usd"]), cost_usd or 0.0)
    return rows, totals


def _add_usage_breakdown_event(
    rows: list[dict],
    run_number: int,
    current_turn: int | None,
    input_tokens: int | None,
    output_tokens: int | None,
    cost_usd: float | None,
) -> None:
    if not input_tokens and not output_tokens and not cost_usd:
        return
    if current_turn is None:
        row = _last_unlabeled_preflight(rows)
        if row is None:
            row = _new_usage_breakdown_row(
                run_number=run_number,
                phase="theorem_translation",
                label="Theorem translation preflight",
                turn=None,
                candidate=None,
            )
            rows.append(row)
    else:
        row = next(
            (
                item for item in rows
                if item.get("run_number") == run_number
                and item.get("phase") == "proof_turn"
                and item.get("turn") == current_turn
            ),
            None,
        )
        if row is None:
            row = _new_usage_breakdown_row(
                run_number=run_number,
                phase="proof_turn",
                label=f"Turn {current_turn}",
                turn=current_turn,
                candidate=None,
            )
            rows.append(row)
    row["input_tokens"] += int(input_tokens or 0)
    row["output_tokens"] += int(output_tokens or 0)
    row["cost_usd"] += float(cost_usd or 0)
    row["event_count"] += 1


def _append_unattributed_usage(
    rows: list[dict],
    input_total: int,
    output_total: int,
    cost_total: float,
    run_number: int,
) -> None:
    input_seen = sum(int(row.get("input_tokens") or 0) for row in rows)
    output_seen = sum(int(row.get("output_tokens") or 0) for row in rows)
    cost_seen = sum(float(row.get("cost_usd") or 0) for row in rows)
    input_delta = max(0, input_total - input_seen)
    output_delta = max(0, output_total - output_seen)
    cost_delta = max(0.0, cost_total - cost_seen)
    if not input_delta and not output_delta and cost_delta < 0.000000001:
        return
    row = _new_usage_breakdown_row(
        run_number=run_number,
        phase="unattributed",
        label="Unattributed usage",
        turn=None,
        candidate=None,
    )
    row["input_tokens"] = input_delta
    row["output_tokens"] = output_delta
    row["cost_usd"] = cost_delta
    rows.append(row)


def _new_usage_breakdown_row(
    *,
    run_number: int,
    phase: str,
    label: str,
    turn: int | None,
    candidate: int | None,
) -> dict:
    return {
        "id": str(uuid4()),
        "run_number": run_number,
        "ordinal": 0,
        "phase": phase,
        "label": label,
        "turn": turn,
        "candidate": candidate,
        "input_tokens": 0,
        "output_tokens": 0,
        "cost_usd": 0.0,
        "event_count": 0,
        "created_at": utc_now(),
    }


def _last_unlabeled_preflight(rows: list[dict]) -> dict | None:
    if not rows:
        return None
    row = rows[-1]
    if row.get("phase") == "theorem_translation" and row.get("candidate") is None:
        return row
    return None


def _event_type(frame: dict[str, Any]) -> str:
    for candidate in _walk_dicts(frame):
        value = candidate.get("type") or candidate.get("event") or candidate.get("kind")
        if isinstance(value, str) and value:
            return value.strip().lower()
    return ""


def _frame_usage(frame: dict[str, Any]) -> tuple[int | None, int | None]:
    for candidate in _walk_dicts(frame):
        usage = candidate.get("usage") if isinstance(candidate.get("usage"), dict) else candidate
        input_tokens = usage.get("input_tokens") or usage.get("prompt_tokens")
        output_tokens = usage.get("output_tokens") or usage.get("completion_tokens")
        if isinstance(input_tokens, int | float) or isinstance(output_tokens, int | float):
            return (
                int(input_tokens) if isinstance(input_tokens, int | float) else None,
                int(output_tokens) if isinstance(output_tokens, int | float) else None,
            )
    return None, None


def _frame_cost(frame: dict[str, Any]) -> float | None:
    for candidate in _walk_dicts(frame):
        value = candidate.get("cost")
        if isinstance(value, int | float):
            return float(value)
        value = candidate.get("cost_usd")
        if isinstance(value, int | float):
            return float(value)
    return None


def _first_int(frame: dict[str, Any], key: str) -> int | None:
    for candidate in _walk_dicts(frame):
        value = candidate.get(key)
        if isinstance(value, int):
            return value
    return None


def _optional_int(value: Any) -> int | None:
    return int(value) if isinstance(value, int | float) else None


def _walk_dicts(value: Any) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []

    def visit(item: Any) -> None:
        if isinstance(item, dict):
            found.append(item)
            for nested in item.values():
                visit(nested)
        elif isinstance(item, list):
            for nested in item:
                visit(nested)

    visit(value)
    return found
