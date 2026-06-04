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
            "select * from sessions order by updated_at desc limit 100"
        ).fetchall()
    return [row_to_dict(row) for row in rows]


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
                updated_at = ?
            where id = ?
            """,
            (status, final_text, input_tokens, output_tokens, now, run_id),
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


def session_detail(session_id: str) -> dict | None:
    session = get_session(session_id)
    if not session:
        return None
    with connect() as conn:
        messages = conn.execute(
            "select * from messages where session_id = ? order by created_at asc",
            (session_id,),
        ).fetchall()
        code_steps = conn.execute(
            "select * from code_steps where session_id = ? order by step_number asc",
            (session_id,),
        ).fetchall()
    return {
        **session,
        "messages": [row_to_dict(row) for row in messages],
        "code_steps": [row_to_dict(row) for row in code_steps],
    }
