from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator


ROOT = Path(__file__).resolve().parents[2]
DB_PATH = ROOT / "data" / "lea-interface.sqlite3"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with connect() as conn:
        conn.executescript(
            """
            -- No stored `status`: a session's status IS its working-copy verdict
            -- (D14/P2) = the latest code_step's check_status, derived on read so it
            -- can never drift. Run lifecycle (running/done/failed) lives on runs.status.
            create table if not exists sessions (
                id text primary key,
                project_id text references projects(id),
                title text not null,
                api_session_id text,
                -- Session origin / providence (P-origin): where this formalization was
                -- spawned from. 'ui' = the interactive Lea UI (default); 'overleaf' =
                -- the Overleaf extension. `origin_url` is the canonical Overleaf
                -- document URL for an Overleaf-originated session (NULL otherwise), so
                -- the UI can open/focus the source document. Deliberately stored on the
                -- session — NOT on `projects` — so it stays independent of the future
                -- projects feature that owns that table.
                origin text not null default 'ui',
                origin_url text,
                created_at text not null,
                updated_at text not null
            );

            -- A project is a shared dir + git repo + this index row (D21). The DB
            -- never stores Instructions/Memory/Blueprint content — those are the
            -- three canonical `.lea/*.md` files (D25/D26/D28); only short metadata
            -- lives here. `slug` is immutable (it determines the namespace + dir,
            -- D22); `namespace`/`repo_path` are derivable-but-cached for queries.
            create table if not exists projects (
                id text primary key,
                slug text not null unique,        -- immutable; → namespace Lea.<Project> (D22)
                title text not null,
                description text,                  -- short metadata for the project list/cards
                namespace text not null,          -- cached 'Lea.<Project>' (derivable; cached)
                repo_path text not null,          -- 'proofs/Lea/<Project>' — the shared dir/repo (D22)
                remote_url text,                  -- per-project GitHub remote for push (D34; nullable)
                created_at text not null,
                updated_at text not null
            );

            -- Uploaded/extracted project files (D27). Index only: the bytes live in
            -- the project repo under `.lea/files/` (git-canonical). `kind` tags the
            -- role; `extracted_path` points at the tiered text sidecar when present.
            create table if not exists project_files (
                id text primary key,
                project_id text not null references projects(id),
                filename text not null,
                stored_path text not null,        -- path within the project repo (.lea/files/<name>)
                mime text,
                kind text not null default 'upload',   -- 'upload' | 'blueprint' | 'extract'
                extracted_path text,              -- tiered text sidecar (.lea/files/<name>.txt)
                created_at text not null
            );

            create table if not exists runs (
                id text primary key,
                session_id text not null references sessions(id),
                project_id text references projects(id),
                status text not null,
                -- Autonomous run (D19): 1 → no per-tool approval gate AND the
                -- non-interactive `default` prompt variant, so the run formalizes
                -- end-to-end with zero human interaction (the Overleaf path). 0 →
                -- the interactive UI behavior (gated tools + collaborator prompt).
                -- Set at create time from the request; read back when the SSE
                -- stream spawns the run thread (a separate HTTP request).
                autonomous integer not null default 0,
                api_run_id text,
                pending_approval text,
                model text not null,
                provider text,
                max_turns integer,
                input_tokens integer default 0,
                output_tokens integer default 0,
                cost_usd real not null default 0,
                final_text text,
                -- The faithful prover conversation at this run's end (JSON list of
                -- messages, with tool_call/tool_result parts) — the model-replay
                -- transcript fed to the next activation for multi-turn (D16). Distinct
                -- from the display `messages` table, which is the flattened human thread.
                -- NULL until the run produces a Finished event (errored runs store none).
                transcript text,
                safe_verify_status text,
                safe_verify_detail text,
                created_at text not null,
                updated_at text not null
            );

            -- A transcript message. `kind='edit_note'` is a user's explanation of a
            -- canvas edit (D11), linked to that edit's git commit via commit_sha — a
            -- normal message, no bespoke channel. The CHECK enforces D11 at the source:
            -- an edit_note must carry a commit_sha (other kinds leave it NULL).
            create table if not exists messages (
                id text primary key,
                session_id text not null references sessions(id),
                run_id text references runs(id),
                role text not null,
                content text not null,
                kind text not null default 'assistant',
                commit_sha text,
                seq integer not null,                     -- shared per-session timeline position (C4)
                created_at text not null,
                check (kind <> 'edit_note' or commit_sha is not null)
            );

            -- A curated step in the session timeline. v2 (D7/D8): git owns the
            -- proof *content*, so a row is a pointer (commit_sha + path) into the
            -- session's git repo plus presentation metadata — not the file text.
            create table if not exists code_steps (
                id text primary key,
                session_id text not null references sessions(id),
                run_id text references runs(id),          -- NULL for user edits (D9)
                seq integer not null,                     -- shared per-session timeline position (C4)
                turn integer,                             -- agent turn; NULL for user edits
                author text not null default 'agent',     -- 'agent' | 'user'
                path text not null,                       -- file this step shows
                commit_sha text not null,                 -- pointer into the git repo (the content)
                summary text,                             -- short label / narration
                check_status text,                        -- 'ok' | 'error' | 'unchecked' (D6)
                check_detail text,                        -- first error line (nullable)
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
        # No in-place ALTER migrations anywhere: v2 is a clean rebuild (no backward
        # compat — single user, disposable/rebuildable DB). Every create-table above
        # is the single authoritative schema; a schema change means a fresh DB
        # (`npm run reset:local`), not a migration. The old runs/sessions/code_steps
        # back-fill ALTERs are intentionally gone.


def row_to_dict(row: sqlite3.Row) -> dict:
    return {key: row[key] for key in row.keys()}
