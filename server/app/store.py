from __future__ import annotations

from uuid import uuid4

from .db import connect, row_to_dict, utc_now


def create_session(title: str) -> dict:
    now = utc_now()
    session_id = str(uuid4())
    with connect() as conn:
        conn.execute(
            "insert into sessions (id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?)",
            (session_id, title[:120] or "Untitled theorem", "running", now, now),
        )
        row = conn.execute("select * from sessions where id = ?", (session_id,)).fetchone()
    return row_to_dict(row)


def touch_session(session_id: str, status: str | None = None) -> None:
    now = utc_now()
    with connect() as conn:
        if status:
            conn.execute(
                "update sessions set status = ?, updated_at = ? where id = ?",
                (status, now, session_id),
            )
        else:
            conn.execute("update sessions set updated_at = ? where id = ?", (now, session_id))


def get_session(session_id: str) -> dict | None:
    with connect() as conn:
        row = conn.execute("select * from sessions where id = ?", (session_id,)).fetchone()
    return row_to_dict(row) if row else None


def list_sessions() -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            """
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
                s.created_at as started_at,
                s.updated_at as ended_at,
                max(0, cast((julianday(s.updated_at) - julianday(s.created_at)) * 86400 as integer)) as duration_seconds
            from sessions s
            left join runs r on r.session_id = s.id
            group by s.id
            order by s.updated_at desc
            limit 100
            """
        ).fetchall()
    return [_normalize_usage_session(row_to_dict(row)) for row in rows]


def create_run(session_id: str, model: str, provider: str | None, max_turns: int | None) -> dict:
    now = utc_now()
    run_id = str(uuid4())
    with connect() as conn:
        conn.execute(
            """
            insert into runs (id, session_id, status, model, provider, max_turns, created_at, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (run_id, session_id, "pending", model, provider, max_turns, now, now),
        )
        row = conn.execute("select * from runs where id = ?", (run_id,)).fetchone()
    return row_to_dict(row)


def update_run(
    run_id: str,
    status: str,
    final_text: str | None = None,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    cost_usd: float | None = None,
) -> None:
    now = utc_now()
    with connect() as conn:
        conn.execute(
            """
            update runs
            set status = ?,
                final_text = coalesce(?, final_text),
                input_tokens = coalesce(?, input_tokens),
                output_tokens = coalesce(?, output_tokens),
                cost_usd = coalesce(?, cost_usd),
                updated_at = ?
            where id = ?
            """,
            (status, final_text, input_tokens, output_tokens, cost_usd, now, run_id),
        )


def get_run(run_id: str) -> dict | None:
    with connect() as conn:
        row = conn.execute("select * from runs where id = ?", (run_id,)).fetchone()
    return row_to_dict(row) if row else None


def add_message(session_id: str, role: str, content: str, run_id: str | None = None) -> dict:
    now = utc_now()
    message_id = str(uuid4())
    with connect() as conn:
        conn.execute(
            """
            insert into messages (id, session_id, run_id, role, content, created_at)
            values (?, ?, ?, ?, ?, ?)
            """,
            (message_id, session_id, run_id, role, content, now),
        )
        row = conn.execute("select * from messages where id = ?", (message_id,)).fetchone()
    touch_session(session_id)
    return row_to_dict(row)


def add_code_step(
    session_id: str,
    run_id: str,
    path: str,
    code: str,
    kind: str = "code",
    summary: str | None = None,
    turn: int | None = None,
) -> dict:
    now = utc_now()
    step_id = str(uuid4())
    with connect() as conn:
        row = conn.execute(
            "select coalesce(max(step_number), 0) + 1 as next_step from code_steps where session_id = ?",
            (session_id,),
        ).fetchone()
        step_number = int(row["next_step"])
        conn.execute(
            """
            insert into code_steps (id, session_id, run_id, step_number, path, code, kind, summary, turn, created_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (step_id, session_id, run_id, step_number, path, code, kind, summary, turn, now),
        )
        inserted = conn.execute("select * from code_steps where id = ?", (step_id,)).fetchone()
    touch_session(session_id)
    return row_to_dict(inserted)


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
        messages = conn.execute(
            "select * from messages where session_id = ? order by created_at asc",
            (session_id,),
        ).fetchall()
        code_steps = conn.execute(
            "select * from code_steps where session_id = ? order by step_number asc",
            (session_id,),
        ).fetchall()
        status_events = conn.execute(
            "select * from status_events where session_id = ? order by created_at asc",
            (session_id,),
        ).fetchall()
    usage = _normalize_usage_session(
        {
            **(row_to_dict(usage_row) if usage_row else {}),
            "message_count": len(messages),
            "started_at": session["created_at"],
            "ended_at": session["updated_at"],
            "duration_seconds": _duration_seconds(session["created_at"], session["updated_at"]),
        }
    )
    return {
        **session,
        **usage,
        "messages": [row_to_dict(row) for row in messages],
        "code_steps": [row_to_dict(row) for row in code_steps],
        "status_events": [row_to_dict(row) for row in status_events],
    }


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
