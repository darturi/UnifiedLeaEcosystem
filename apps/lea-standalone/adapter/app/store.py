from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from uuid import uuid4

from typing import Any

from .db import ROOT, connect, row_to_dict, utc_now, write


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
    parent_id: str | None = None,
    role: str | None = None,
    spawned_at_turn: int | None = None,
) -> dict:
    """Create a session. `origin` records providence ('ui' | 'overleaf'); for an
    Overleaf-spawned session `origin_url` is the canonical Overleaf document URL so
    the UI can open/focus the source document. Both default to the interactive-UI
    case so the existing path is unchanged.

    `parent_id`/`role`/`spawned_at_turn` (item 24) make this a sub-agent CHILD of the
    coordinator that spawned it: a child is a real session excluded from the root list
    (`parent_id is null`), tagged with its `role` (subagent_type) and the coordinator
    `turn` it was delegated on. All three default to None, so a root session is
    unchanged."""
    now = utc_now()
    session_id = str(uuid4())
    origin_value = (origin or "ui").strip() or "ui"
    with connect() as conn:
        conn.execute(
            "insert into sessions "
            "(id, project_id, title, origin, origin_url, parent_id, role, spawned_at_turn, created_at, updated_at) "
            "values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (session_id, project_id, title[:120] or "Untitled theorem", origin_value, origin_url,
             parent_id, role, spawned_at_turn, now, now),
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
    """Loose sessions (`project_id IS NULL`) — the sidebar Chats group (D30). This
    INCLUDES sub-agent children (item 24): the tree is shipped whole and the frontend
    does the `roots = parent_id is null` / `childrenOf(id)` split (matching the design
    mock), because the contextual Sub-agents block needs the children in-store to
    render. In-project sessions are reached through the project window / search."""
    return _list_sessions("s.project_id is null")


def list_project_sessions(project_id: str) -> list[dict]:
    """Sessions belonging to one project — the project window's session list (D30).
    Includes children for the same reason as `list_loose_sessions`; the frontend splits
    roots from children."""
    return _list_sessions("s.project_id = ?", (project_id,))


def list_child_sessions(parent_id: str) -> list[dict]:
    """A coordinator's sub-agent children (item 24), newest first — a targeted read for
    callers that want just one coordinator's children (the frontend derives them from
    the full list, but the bridge/tests use this). Each carries its derived
    status/role/spawned_at_turn like any session row."""
    return _list_sessions("s.parent_id = ?", (parent_id,))


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
                    from timeline m
                    where m.session_id = s.id and m.kind != 'code'
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
                    from timeline cs
                    where cs.session_id = s.id and cs.kind = 'code'
                      and lower(cs.path) not like '%scratch%'
                    order by cs.id desc
                    limit 1
                ) as latest_check_status,
                (
                    select cs.artifact_kind
                    from timeline cs
                    where cs.session_id = s.id and cs.kind = 'code'
                      and lower(cs.path) not like '%scratch%'
                    order by cs.id desc
                    limit 1
                ) as latest_artifact_kind,
                (
                    select rcs.status
                    from timeline cs
                    left join runs rcs on rcs.id = cs.run_id
                    where cs.session_id = s.id and cs.kind = 'code'
                      and lower(cs.path) not like '%scratch%'
                    order by cs.id desc
                    limit 1
                ) as latest_code_run_status,
                (
                    select count(*) from timeline cs
                    where cs.session_id = s.id and cs.kind = 'code'
                      and lower(cs.path) not like '%scratch%'
                ) as code_step_count,
                (
                    select count(*)
                    from runs r3
                    where r3.session_id = s.id and r3.status in ('pending', 'running')
                ) as active_run_count,
                -- Sub-agents (bug-fix): a CHILD's final output — its last agent message —
                -- so the coordinator's spawn box can show a collapsed preview + expand
                -- without a second fetch. Gated on parent_id so a normal session's list
                -- row never carries a big prose blob it doesn't use.
                (
                    case when s.parent_id is not null then (
                        select tm.content
                        from timeline tm
                        where tm.session_id = s.id and tm.kind = 'message'
                          and tm.author = 'agent'
                        order by tm.id desc
                        limit 1
                    ) end
                ) as final_summary,
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
        # v2.3 item 13: keep the integer active-run count on the row (not just the
        # bool the derived status consumes). Derived status deliberately stays a
        # working-copy verdict (D14), so a session that already has code but is
        # re-running reads 'proved'/'ok', never 'running' — the sidebar needs this
        # separate signal to show a running dot for background runs.
        active_run_count = int(data.pop("active_run_count", 0) or 0)
        data["status"] = _derive_session_status(
            data.pop("latest_check_status", None),
            data.pop("latest_artifact_kind", None),
            int(data.pop("code_step_count", 0) or 0),
            bool(active_run_count),
            data.pop("latest_code_run_status", None),
        )
        data["active_run_count"] = active_run_count
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
            # `messages`/`code_steps` are pre-cutover rows kept until the contract
            # step drops them; they're still cleared so a delete doesn't leave half
            # a session behind in tables that are still readable.
            for table in ("timeline", "messages", "code_steps", "status_events",
                          "run_usage_breakdown", "runs"):
                conn.execute(f"delete from {table} where session_id in ({marks})", session_ids)
            conn.execute(f"delete from sessions where id in ({marks})", session_ids)
            # Blobs are content-addressed and therefore *shared* — the same file
            # content in another project is the same row. So they can't be deleted
            # by session; drop only the ones nothing points at any more. Deleting
            # eagerly here would silently blank another project's history.
            conn.execute(
                "delete from artifact_blobs where id not in "
                "(select after_blob_id from timeline where after_blob_id is not null)"
            )
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
    """Crash recovery, called once at startup: any run still `pending`/`running`
    in the DB has no live runner thread (they died with the previous process), so
    mark it failed. Without this, a run created but never driven — e.g. its client
    gave up while queued for the single-run slot — sits `pending` forever and the
    derived session status (D14) shows an eternal 'thinking'. Returns the count."""
    now = utc_now()
    detail = "Run did not finish: the adapter restarted (or the run was never started) before it completed."
    with connect() as conn:
        cursor = conn.execute(
            """
            update runs
            set status = 'failed',
                result_kind = coalesce(result_kind, 'failed'),
                result_detail = coalesce(result_detail, ?),
                updated_at = ?
            where status in ('pending', 'running')
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
    """The most recent code step for a file in a session (newest id wins).

    The standalone lean-check / verify endpoints use this to back-fill the verdict
    onto the current working step (the canvas's latest snapshot of that file)."""
    with connect() as conn:
        row = conn.execute(
            "select * from timeline where session_id = ? and kind = 'code' and path = ? "
            "order by id desc limit 1",
            (session_id, path),
        ).fetchone()
    return _code_step_from_row(row) if row else None


def code_steps_for_project_path(project_id: str, path: str) -> list[dict]:
    """Every code step for a file across a project's sessions, newest first — the raw
    material for a blueprint node's status + session attribution (D29). Joins on the
    session's project_id so loose sessions never leak in. Ordered by `created_at`
    (cross-session recency; `id` only orders within one session), so the first row is
    the latest verdict and the distinct session order is newest-touched-first."""
    with connect() as conn:
        rows = conn.execute(
            "select c.* from timeline c join sessions s on s.id = c.session_id "
            "where s.project_id = ? and c.kind = 'code' and c.path = ? "
            "order by c.created_at desc, c.id desc",
            (project_id, path),
        ).fetchall()
    return [_code_step_from_row(r) for r in rows]


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
    """The most recent agent-authored code step — the proof state the agent last
    'knew' (D12). Its content vs. the file's current content reveals human edits."""
    with connect() as conn:
        row = conn.execute(
            "select * from timeline where session_id = ? and kind = 'code' and author = 'agent' "
            "order by id desc limit 1",
            (session_id,),
        ).fetchone()
    return _code_step_from_row(row) if row else None


def latest_agent_code_step_for_path(session_id: str, path: str) -> dict | None:
    """As above, but for one file — the per-file 'before' the agent last saw (D12).

    Divergence is a property of a *file*, not a repo: `git diff <sha> HEAD` compared
    whole trees, so an edit to any file in a shared project repo (D24) reported every
    other session's file as diverged too. Keying on the path is what scopes it."""
    with connect() as conn:
        row = conn.execute(
            "select * from timeline where session_id = ? and kind = 'code' "
            "and author = 'agent' and path = ? order by id desc limit 1",
            (session_id, path),
        ).fetchone()
    return _code_step_from_row(row) if row else None


def edit_notes_since(session_id: str, seq: int) -> list[str]:
    """Edit-note explanations (D11) recorded after a given timeline position —
    the human's words about edits made since the agent last acted (D12)."""
    with connect() as conn:
        rows = conn.execute(
            "select content from timeline where session_id = ? and kind = 'edit_note' and id > ? "
            "order by id asc",
            (session_id, seq),
        ).fetchall()
    return [row["content"] for row in rows]


def get_run(run_id: str) -> dict | None:
    with connect() as conn:
        row = conn.execute("select * from runs where id = ?", (run_id,)).fetchone()
    return _normalize_run(row_to_dict(row)) if row else None


def get_run_status(run_id: str) -> dict | None:
    """The cheap run-row read (v2.3 item 16): just the four outcome columns a
    poller needs — id + lifecycle status + terminal kind/detail. Deliberately
    NOT ``get_run`` (which pulls ``select *``, including the potentially large
    ``transcript`` blob) and emphatically not ``session_detail`` (messages +
    code_steps + status_events + usage). The Overleaf companion hits this every
    ~3s while waiting for a slot or after a dropped stream; paying a full session
    detail there was a self-inflicted DB-contention source under concurrency."""
    with connect() as conn:
        row = conn.execute(
            "select id, status, result_kind, result_detail from runs where id = ?",
            (run_id,),
        ).fetchone()
    return row_to_dict(row) if row else None


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


# ---------------------------------------------------------------------------
# timeline (C4) — one table, one counter
#
# `messages` and `code_steps` were two tables sharing one hand-rolled `seq`
# counter, which is what made a session's thread an ORDER BY merge. That counter
# was a read-modify-write across both tables, and under concurrent writers it
# silently issued duplicate seqs (measured: ~110/200 collisions; see db.write()).
#
# Merging the tables retires the counter: `timeline.id` is an autoincrement
# primary key, so ordering is assigned by SQLite under the write lock. The race
# isn't fixed, it's unrepresentable — there is no read-then-write to lose. The
# `seq` key below is that id, kept so callers and the frontend read unchanged.
#
# Content lives in `artifact_blobs` (D7 inverted): a code row points at a blob by
# id, and the schema CHECKs that a code row has one (or is explicitly marked
# `content_lost`). Git was an unverified pointer into a second store — the 0004
# backfill found a code_step naming a commit whose tree never held the file.
# ---------------------------------------------------------------------------


def _put_blob(conn, content: str) -> str:
    """Insert-or-find a blob by content hash. Dedup is the schema's job (`sha256`
    is UNIQUE), so this stays a dumb upsert. Identical content across steps — a
    revert, a cascade re-check, an unchanged save — costs one row, not a copy.

    Must run inside a `write()`: this is a read-then-insert, and the UNIQUE index
    is what makes a concurrent duplicate an error rather than a silent second copy.
    """
    digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
    row = conn.execute("select id from artifact_blobs where sha256 = ?", (digest,)).fetchone()
    if row:
        return row["id"]
    blob_id = str(uuid4())
    conn.execute(
        "insert into artifact_blobs (id, sha256, content, created_at) values (?, ?, ?, ?)",
        (blob_id, digest, content, utc_now()),
    )
    return blob_id


def blob_content(blob_id: str | None) -> str | None:
    """A blob's text, or None if absent (a `content_lost` row, or no blob)."""
    if not blob_id:
        return None
    with connect() as conn:
        row = conn.execute("select content from artifact_blobs where id = ?", (blob_id,)).fetchone()
    return row["content"] if row else None


def _message_from_row(row) -> dict:
    """A timeline message row in the shape the API has always returned.

    `role` is reconstructed from `author`: they were the same concept spelled
    twice, and the old `kind` column defaulted to 'assistant' — a *role* value used
    as a kind default — so it lied for every row nobody set explicitly. The new
    schema keeps `kind` for what a row *is* and `author` for who made it, which is
    the split OpenHands draws (`SourceType`) and opencode conflates.
    """
    d = row_to_dict(row)
    return {
        "id": str(d["id"]),
        "session_id": d["session_id"],
        "run_id": d["run_id"],
        "role": "user" if d["author"] == "user" else "assistant",
        "content": d["content"],
        "kind": "edit_note" if d["kind"] == "edit_note" else "assistant",
        "seq": d["id"],
        "created_at": d["created_at"],
    }


def _code_step_from_row(row, *, code: str | None = None) -> dict:
    """A timeline code row in the shape the API has always returned.

    `code` is passed when the caller already has the bytes (it just wrote them);
    otherwise it's read from the blob. A `content_lost` row yields `""` — the row
    survives to say a step happened, which is more honest than deleting history
    because its bytes are gone.
    """
    d = row_to_dict(row)
    if code is None:
        code = blob_content(d["after_blob_id"]) or ""
    return {
        "id": str(d["id"]),
        "session_id": d["session_id"],
        "run_id": d["run_id"],
        "seq": d["id"],
        "turn": d["turn"],
        "author": d["author"],
        "path": d["path"],
        "summary": d["summary"],
        "check_status": d["check_status"],
        "check_detail": d["check_detail"],
        "artifact_kind": d["artifact_kind"],
        "content_lost": bool(d["content_lost"]),
        "created_at": d["created_at"],
        "code": code,
    }


def add_message(
    session_id: str,
    role: str,
    content: str,
    run_id: str | None = None,
    kind: str = "assistant",
    commit_sha: str | None = None,
) -> dict:
    """Append a transcript message. A user's edit explanation (D11) is just this
    with `kind='edit_note'` — no bespoke channel; it rides the same path that feeds
    context to the prover.

    `commit_sha` is accepted and ignored: git no longer stores content, so there is
    no commit to point at. The parameter stays only so callers can be moved off it
    one at a time.
    """
    with write() as conn:
        cur = conn.execute(
            """
            insert into timeline (session_id, run_id, kind, author, content, created_at)
            values (?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                run_id,
                "edit_note" if kind == "edit_note" else "message",
                "user" if role == "user" else "agent",
                content,
                utc_now(),
            ),
        )
        row = conn.execute("select * from timeline where id = ?", (cur.lastrowid,)).fetchone()
    touch_session(session_id)
    return _message_from_row(row)


def add_code_step(
    session_id: str,
    run_id: str | None,
    path: str,
    *,
    content: str,
    author: str = "agent",
    summary: str | None = None,
    turn: int | None = None,
    check_status: str | None = None,
    check_detail: str | None = None,
    artifact_kind: str | None = None,
    provenance: dict | None = None,
) -> dict:
    """Record a timeline step holding a file's full contents after a write.

    `content` is the file's bytes and is keyword-only and required — it replaces
    the old `commit_sha` pointer, so a stale caller still passing a sha fails
    loudly rather than storing a 40-char sha as if it were a proof.

    `run_id` is NULL for user edits made outside a run (D9); `turn` is NULL for
    user edits. The verdict (`check_status`/`check_detail`) is recorded here, not
    in a commit message (D6), and may be back-filled once `lean_check` returns.

    `author` is constrained by the schema to 'user' | 'agent' | 'environment'.
    Note 'cascade' — a re-verification of an *unchanged* file — is NOT an author:
    it's a *reason*, and it was only ever in this column because the old schema had
    nowhere else to put it. It rides in `data` instead; the file is still the
    agent's work regardless of what prompted the re-check.

    `provenance` (item 25) is merged into the same `data` JSON — e.g.
    `{"promoted_from": "<result_id>"}` links a promoted sub-agent candidate back to
    the child run that produced it, so "which attempt won" stays answerable.
    """
    now = utc_now()
    reason = None if author in ("user", "agent", "environment") else author
    data_obj: dict = {}
    if reason:
        data_obj["reason"] = reason
    if provenance:
        data_obj.update(provenance)
    data_json = json.dumps(data_obj) if data_obj else None
    with write() as conn:
        blob_id = _put_blob(conn, content)
        cur = conn.execute(
            """
            insert into timeline (
                session_id, run_id, kind, author, turn, path, after_blob_id,
                summary, check_status, check_detail, artifact_kind, data, created_at
            )
            values (?, ?, 'code', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                run_id,
                "agent" if reason else author,
                turn,
                path,
                blob_id,
                summary,
                check_status,
                check_detail,
                artifact_kind if check_status == "ok" else None,
                data_json,
                now,
            ),
        )
        row = conn.execute("select * from timeline where id = ?", (cur.lastrowid,)).fetchone()
    touch_session(session_id)
    return _code_step_from_row(row, code=content)


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


def upsert_user_code_step(session_id: str, path: str, *, content: str) -> dict:
    """Record a user edit, coalescing rapid successive edits into one timeline step.

    Auto-save (v2.2) saves on every debounced keystroke-pause, which would spray the
    History stepper with one 'your edit' step per save. So if the file's latest step
    is already an *uncommitted-to-a-run* user edit (author='user', run_id NULL), we
    repoint that step at the new content and clear its stale verdict — one step that
    tracks the newest bytes — instead of inserting a new row. A step authored by the
    agent (or a user edit for a different file) still starts a fresh step, so the
    human/agent boundary in the timeline is preserved.

    Coalescing now drops the superseded *content*, where git kept every commit. The
    dropped versions are debounced keystroke states of the file the user is actively
    looking at, so the editor — not history — is their undo. Blobs are content-
    addressed, so an intermediate state that recurs anywhere else is still reachable."""
    latest = latest_code_step_for_path(session_id, path)
    if latest and latest.get("author") == "user" and latest.get("run_id") is None:
        with write() as conn:
            blob_id = _put_blob(conn, content)
            conn.execute(
                "update timeline set after_blob_id = ?, content_lost = 0, check_status = NULL, "
                "check_detail = NULL, artifact_kind = NULL where id = ?",
                (blob_id, int(latest["id"])),
            )
            row = conn.execute("select * from timeline where id = ?", (int(latest["id"]),)).fetchone()
        touch_session(session_id)
        return _code_step_from_row(row, code=content)
    return add_code_step(session_id, None, path, content=content, author="user")


def set_code_step_check(
    step_id: str,
    check_status: str,
    check_detail: str | None = None,
    artifact_kind: str | None = None,
) -> dict | None:
    """Back-fill a code step's verdict once `lean_check` returns (D6).

    The write's row is inserted *before* the check runs (FileChanged precedes
    CheckResult), so the verdict lands here, on the existing row, rather than in a
    commit message. Returns the updated row, or None if the id is unknown.
    """
    with connect() as conn:
        conn.execute(
            "update timeline set check_status = ?, check_detail = ?, artifact_kind = ? "
            "where id = ? and kind = 'code'",
            (check_status, check_detail, artifact_kind if check_status == "ok" else None, int(step_id)),
        )
        row = conn.execute("select * from timeline where id = ?", (int(step_id),)).fetchone()
    return _code_step_from_row(row) if row else None


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
        # One table, one order (C4). These were two tables sharing a hand-rolled
        # counter so the frontend could merge them by a single key; now they're the
        # same rows, split apart on the way out only because the API shape predates
        # the merge. `id` is the order — nothing can disagree about it.
        rows = conn.execute(
            "select * from timeline where session_id = ? order by id asc",
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
        runs = conn.execute(
            "select id, status, result_kind, result_detail from runs where session_id = ? order by created_at asc, id asc",
            (session_id,),
        ).fetchall()
        project = None
        if session.get("project_id"):
            project = conn.execute(
                "select * from projects where id = ?",
                (session["project_id"],),
            ).fetchone()
    # Split back into the two lists the API exposes. Code rows carry their content
    # already — a read no longer needs a second store to be reachable, so there is
    # no separate hydrate step that can silently come back empty.
    messages = [_message_from_row(r) for r in rows if r["kind"] != "code"]
    code_steps = [_code_step_from_row(r) for r in rows if r["kind"] == "code"]
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
        "messages": messages,
        "code_steps": [_normalize_code_step(step) for step in code_steps],
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
