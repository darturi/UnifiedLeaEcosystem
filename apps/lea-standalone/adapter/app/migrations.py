"""Schema migrations — the DB is no longer disposable.

`db.py` used to say: *"No in-place ALTER migrations anywhere: v2 is a clean
rebuild (no backward compat — single user, disposable/rebuildable DB) … a schema
change means a fresh DB (`npm run reset:local`), not a migration."*

That policy was correct **while git owned proof content** — the database was only
an index, so throwing it away and rebuilding cost nothing. It stops being true the
moment SQL holds the only copy of a proof: then "just reset it" means "delete the
user's work". The premise died, so the policy did too.

Everything runs through Alembic (`migrations/`, revision `0001_baseline` onward).
Autogenerate is unavailable — there are no SQLAlchemy models, and every query in
this app is raw `sqlite3` — so revisions are hand-written. Alembic earns its place
via `op.batch_alter_table`, the only correct way to change a column constraint in
SQLite (it does the 12-step create/copy/drop/rename rebuild, including recreating
indexes). Hand-writing that is high-risk here because `foreign_keys` is OFF and
`store.delete_project_cascade`'s cascades depend on that, so a botched rebuild
fails *silently*.

Concurrency: several workers may start at once and all call `upgrade_to_head()`.
Alembic takes SQLite's write lock for each revision, so the losers block and then
observe the applied version — exactly-once, verified in `tests/test_migrations.py`.
"""

from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config

ADAPTER_ROOT = Path(__file__).resolve().parents[1]
ALEMBIC_INI = ADAPTER_ROOT / "alembic.ini"


def _config() -> Config:
    cfg = Config(str(ALEMBIC_INI))
    # Absolute, so the runner works regardless of the process's cwd (uvicorn, pytest,
    # a script). The URL itself is resolved inside env.py from db.DB_PATH at call
    # time — deliberately not set here, so tests keep hitting their scratch DB.
    cfg.set_main_option("script_location", str(ADAPTER_ROOT / "migrations"))
    return cfg


def upgrade_to_head() -> None:
    """Bring the database at `db.DB_PATH` up to the latest revision.

    Idempotent: already-current is a no-op. Safe to call on every startup."""
    command.upgrade(_config(), "head")


def current_revision() -> str | None:
    """The revision the database is stamped at; None if unstamped or absent.

    Reads `alembic_version` directly rather than via `MigrationContext.configure`,
    which requires a SQLAlchemy connection and raises `AttributeError: 'sqlite3.
    Connection' object has no attribute 'dialect'` if handed one of ours."""
    import sqlite3

    from .db import connect

    with connect() as conn:
        try:
            row = conn.execute("select version_num from alembic_version").fetchone()
        except sqlite3.OperationalError:
            return None  # table absent -> never migrated
    return row["version_num"] if row else None
