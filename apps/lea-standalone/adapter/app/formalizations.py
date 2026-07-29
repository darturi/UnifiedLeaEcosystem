"""First-class formalization read model.

Persistence lives in ``store``; this module batch-loads ledger evidence and
derives validity/activity without caching either on the formalization row.
"""

from __future__ import annotations

import json
from collections import Counter

from .artifacts import contains_sorry_marker
from .db import connect, row_to_dict
from . import store


def _validity(
    formalization: dict,
    *,
    primary: dict | None,
    artifact: dict | None,
    latest_step: dict | None,
    latest_run: dict | None,
) -> str:
    if not formalization.get("declaration_name") and primary is None:
        return "draft"
    if primary is None and artifact is None:
        return "planned"
    if latest_step is None:
        return "unchecked"
    if (
        latest_step.get("check_status") == "error"
        or contains_sorry_marker(latest_step.get("blob_content"))
    ):
        return "failing"
    if not latest_step.get("check_status"):
        return "unchecked"
    current_hash = formalization.get("source_hash")
    artifact_hash = (artifact or {}).get("source_hash")
    if current_hash and artifact_hash and current_hash != artifact_hash:
        return "stale"
    result_kind = (latest_run or {}).get("result_kind")
    if result_kind == "disproved":
        return "disproved"
    artifact_kind = (artifact or {}).get("kind") or latest_step.get("artifact_kind")
    if artifact_kind == "definition" or formalization.get("kind") == "definition":
        return "defined"
    if result_kind == "needs_review":
        return "needs_review"
    return "proved" if latest_step.get("check_status") == "ok" else "unchecked"


def _activity(run: dict | None) -> dict:
    if not run:
        return {"status": "idle", "run_id": None}
    if run.get("status") == "pending":
        status = "queued"
    elif run.get("pending_approval"):
        status = "waiting_for_approval"
    else:
        status = "running"
    return {"status": status, "run_id": run.get("id")}


def _rows_for_ids(conn, sql: str, ids: list[str]) -> list[dict]:
    if not ids:
        return []
    marks = ",".join("?" for _ in ids)
    rows = conn.execute(sql.format(marks=marks), ids).fetchall()
    return [row_to_dict(row) for row in rows]


def decorate(rows: list[dict]) -> list[dict]:
    ids = [str(row["id"]) for row in rows]
    if not ids:
        return []
    with connect() as conn:
        files = _rows_for_ids(
            conn,
            """
            select * from formalization_files
            where formalization_id in ({marks})
            order by case role when 'primary' then 0 when 'support' then 1 else 2 end,
                     path asc
            """,
            ids,
        )
        artifacts = _rows_for_ids(
            conn,
            """
            select * from artifacts
            where formalization_id in ({marks})
            order by updated_at desc, id desc
            """,
            ids,
        )
        latest_steps = _rows_for_ids(
            conn,
            """
            select * from (
                select t.*, b.content as blob_content,
                       row_number() over (
                           partition by t.formalization_id
                           order by
                             case ff.role
                               when 'primary' then 0
                               when 'support' then 1
                               else 2
                             end,
                             t.id desc
                       ) as rn
                from timeline t
                join formalization_files ff
                  on ff.formalization_id = t.formalization_id
                 and ff.path = t.path
                left join artifact_blobs b on b.id = t.after_blob_id
                where t.kind = 'code' and t.formalization_id in ({marks})
            ) where rn = 1
            """,
            ids,
        )
        active_runs = _rows_for_ids(
            conn,
            """
            select * from (
                select r.*,
                       row_number() over (
                           partition by r.focus_formalization_id
                           order by r.created_at desc, r.id desc
                       ) as rn
                from runs r
                where r.focus_formalization_id in ({marks})
                  and r.status in ('pending', 'running')
            ) where rn = 1
            """,
            ids,
        )
        latest_runs = _rows_for_ids(
            conn,
            """
            select * from (
                select r.*,
                       row_number() over (
                           partition by r.focus_formalization_id
                           order by r.created_at desc, r.id desc
                       ) as rn
                from runs r
                where r.focus_formalization_id in ({marks})
            ) where rn = 1
            """,
            ids,
        )
        verifications = _rows_for_ids(
            conn,
            """
            select * from (
                select v.*,
                       row_number() over (
                           partition by v.formalization_id
                           order by v.created_at desc, v.id desc
                       ) as rn
                from verification_events v
                where v.formalization_id in ({marks})
            ) where rn = 1
            """,
            ids,
        )
        sessions = _rows_for_ids(
            conn,
            """
            select sf.formalization_id, s.id, s.title, s.updated_at
            from session_formalizations sf
            join sessions s on s.id = sf.session_id
            where sf.formalization_id in ({marks})
            order by s.updated_at desc
            """,
            ids,
        )

    by_files: dict[str, list[dict]] = {}
    by_sessions: dict[str, list[dict]] = {}
    for item in files:
        by_files.setdefault(str(item["formalization_id"]), []).append(item)
    for item in sessions:
        by_sessions.setdefault(str(item["formalization_id"]), []).append(
            {
                "id": item["id"],
                "title": item["title"],
                "updated_at": item["updated_at"],
            }
        )
    first_artifact: dict[str, dict] = {}
    for item in artifacts:
        first_artifact.setdefault(str(item["formalization_id"]), item)
    step_by_id = {str(item["formalization_id"]): item for item in latest_steps}
    active_by_id = {str(item["focus_formalization_id"]): item for item in active_runs}
    run_by_id = {str(item["focus_formalization_id"]): item for item in latest_runs}
    verify_by_id = {str(item["formalization_id"]): item for item in verifications}

    result = []
    for raw in rows:
        item = dict(raw)
        fid = str(item["id"])
        item_files = by_files.get(fid, [])
        primary = next((f for f in item_files if f["role"] == "primary"), None)
        artifact = first_artifact.get(fid)
        step = step_by_id.get(fid)
        active = active_by_id.get(fid)
        latest_run = run_by_id.get(fid)
        verification = verify_by_id.get(fid)
        if active and isinstance(active.get("pending_approval"), str):
            try:
                active["pending_approval"] = json.loads(active["pending_approval"])
            except json.JSONDecodeError:
                active["pending_approval"] = None
        safe_verify = None
        if verification:
            safe_verify = {
                "id": verification["id"],
                "status": verification["status"],
                "detail": verification.get("detail"),
                "path": verification["path"],
                "code_step_id": (
                    str(verification["code_step_id"])
                    if verification.get("code_step_id") is not None else None
                ),
                "current": bool(
                    step
                    and verification.get("code_step_id") is not None
                    and str(verification["code_step_id"]) == str(step["id"])
                ),
                "created_at": verification["created_at"],
            }
        item.update(
            {
                "validity_status": _validity(
                    item, primary=primary, artifact=artifact,
                    latest_step=step, latest_run=latest_run,
                ),
                "activity": _activity(active),
                "primary_path": (
                    primary["path"] if primary else (artifact or {}).get("path")
                ),
                "files": item_files,
                "artifact": artifact,
                "latest_check": (
                    {
                        "code_step_id": str(step["id"]),
                        "path": step["path"],
                        "status": step["check_status"],
                        "detail": step["check_detail"],
                        "created_at": step["created_at"],
                    }
                    if step else None
                ),
                "safe_verify": safe_verify,
                "sessions": by_sessions.get(fid, []),
                "latest_run": (
                    {
                        "id": latest_run["id"],
                        "status": latest_run["status"],
                        "result_kind": latest_run.get("result_kind"),
                        "result_detail": latest_run.get("result_detail"),
                    }
                    if latest_run else None
                ),
            }
        )
        result.append(item)
    return result


def get(formalization_id: str) -> dict | None:
    row = store.get_formalization(formalization_id)
    if not row:
        return None
    return decorate([row])[0]


def for_project(project_id: str) -> list[dict]:
    return decorate(store.list_raw_project_formalizations(project_id))


def for_session(session_id: str) -> list[dict]:
    return decorate(store.list_raw_session_formalizations(session_id))


def search(query: str, limit: int = 30) -> list[dict]:
    q = (query or "").strip()
    if not q:
        return []
    like = f"%{store._escape_like(q)}%"
    with connect() as conn:
        rows = conn.execute(
            """
            select f.*, p.title as project_title, p.namespace as project_namespace
            from formalizations f
            left join projects p on p.id = f.project_id
            where f.display_title like ? escape '\\'
               or f.declaration_name like ? escape '\\'
               or f.statement like ? escape '\\'
               or exists (
                   select 1 from formalization_files ff
                   where ff.formalization_id = f.id
                     and ff.path like ? escape '\\'
               )
            order by f.updated_at desc
            limit ?
            """,
            (like, like, like, like, limit),
        ).fetchall()
    raw = [row_to_dict(row) for row in rows]
    project_tags = {
        str(item["id"]): {
            "project_title": item.pop("project_title", None),
            "project_namespace": item.pop("project_namespace", None),
        }
        for item in raw
    }
    items = decorate(raw)
    for item in items:
        item.update(project_tags[str(item["id"])])
    return items


def summary(items: list[dict]) -> dict:
    counts = Counter(str(item.get("validity_status") or "unknown") for item in items)
    return {
        "formalization_count": len(items),
        **dict(counts),
        "active_run_count": sum(
            1 for item in items
            if (item.get("activity") or {}).get("status") != "idle"
        ),
    }
