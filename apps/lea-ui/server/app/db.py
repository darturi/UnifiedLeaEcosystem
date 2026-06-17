from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator


ROOT = Path(__file__).resolve().parents[2]
MONOREPO_ROOT = Path(__file__).resolve().parents[4]


def _resolve_env_path(env_key: str, default: Path) -> Path:
    """Resolve a path from an env var, relative paths anchored at the monorepo root."""
    value = os.environ.get(env_key)
    if not value:
        return default
    path = Path(value).expanduser()
    return path if path.is_absolute() else (MONOREPO_ROOT / path)


def shared_data_dir() -> Path:
    """Directory holding the shared database and raw event logs.

    Defaults to the existing UI data directory so the UI and the Overleaf
    extension share one store with no migration. Override with
    ``LEA_SHARED_DATA_DIR`` (relative paths are anchored at the monorepo root).
    """
    return _resolve_env_path("LEA_SHARED_DATA_DIR", MONOREPO_ROOT / "apps" / "lea-ui" / "data")


def db_path() -> Path:
    return _resolve_env_path("LEA_DB_PATH", shared_data_dir() / "lea-interface.sqlite3")


def event_log_dir() -> Path:
    return _resolve_env_path("LEA_EVENT_LOG_DIR", shared_data_dir() / "lea-api-events")


# Module-level so callers/tests can monkeypatch a single attribute.
DB_PATH = db_path()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    # WAL lets the UI server and the Overleaf recorder write concurrently
    # (one writer + many readers) against the shared database file.
    conn.execute("pragma journal_mode=WAL")
    conn.execute("pragma busy_timeout=5000")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with connect() as conn:
        conn.executescript(
            """
            create table if not exists sessions (
                id text primary key,
                project_id text references projects(id),
                title text not null,
                status text not null,
                origin text not null default 'ui',
                external_ref text,
                created_at text not null,
                updated_at text not null
            );

            create table if not exists projects (
                id text primary key,
                slug text not null unique,
                title text not null,
                path text not null,
                created_at text not null,
                updated_at text not null
            );

            create table if not exists runs (
                id text primary key,
                session_id text not null references sessions(id),
                project_id text references projects(id),
                status text not null,
                origin text not null default 'ui',
                api_run_id text,
                pending_approval text,
                model text not null,
                provider text,
                max_turns integer,
                input_tokens integer default 0,
                output_tokens integer default 0,
                final_text text,
                created_at text not null,
                updated_at text not null
            );

            create table if not exists messages (
                id text primary key,
                session_id text not null references sessions(id),
                run_id text references runs(id),
                role text not null,
                content text not null,
                created_at text not null
            );

            create table if not exists code_steps (
                id text primary key,
                session_id text not null references sessions(id),
                run_id text not null references runs(id),
                step_number integer not null,
                path text not null,
                code text not null,
                kind text not null default 'code',
                summary text,
                turn integer,
                used_project_formalizations text,
                created_at text not null
            );

            create table if not exists status_events (
                id text primary key,
                session_id text not null references sessions(id),
                run_id text not null references runs(id),
                step_number integer,
                status text,
                message text not null,
                created_at text not null
            );

            create table if not exists run_usage_breakdown (
                id text primary key,
                session_id text not null references sessions(id),
                run_id text not null references runs(id),
                run_number integer not null,
                ordinal integer not null,
                phase text not null,
                label text not null,
                turn integer,
                candidate integer,
                input_tokens integer not null default 0,
                output_tokens integer not null default 0,
                cost_usd real not null default 0,
                event_count integer not null default 0,
                created_at text not null
            );
            """
        )
        columns = {
            row["name"]
            for row in conn.execute("pragma table_info(code_steps)").fetchall()
        }
        if "kind" not in columns:
            conn.execute("alter table code_steps add column kind text not null default 'code'")
        if "summary" not in columns:
            conn.execute("alter table code_steps add column summary text")
        if "turn" not in columns:
            conn.execute("alter table code_steps add column turn integer")
        if "used_project_formalizations" not in columns:
            conn.execute("alter table code_steps add column used_project_formalizations text")

        run_columns = {
            row["name"]
            for row in conn.execute("pragma table_info(runs)").fetchall()
        }
        if "cost_usd" not in run_columns:
            conn.execute("alter table runs add column cost_usd real not null default 0")
        if "api_run_id" not in run_columns:
            conn.execute("alter table runs add column api_run_id text")
        if "pending_approval" not in run_columns:
            conn.execute("alter table runs add column pending_approval text")
        if "project_id" not in run_columns:
            conn.execute("alter table runs add column project_id text references projects(id)")
        if "origin" not in run_columns:
            conn.execute("alter table runs add column origin text not null default 'ui'")

        session_columns = {
            row["name"]
            for row in conn.execute("pragma table_info(sessions)").fetchall()
        }
        if "project_id" not in session_columns:
            conn.execute("alter table sessions add column project_id text references projects(id)")
        if "origin" not in session_columns:
            conn.execute("alter table sessions add column origin text not null default 'ui'")
        if "external_ref" not in session_columns:
            conn.execute("alter table sessions add column external_ref text")


def row_to_dict(row: sqlite3.Row) -> dict:
    return {key: row[key] for key in row.keys()}
