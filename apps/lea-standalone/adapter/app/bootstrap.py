"""Explicit schema bootstrap. Neither serving process runs migrations."""
import sqlite3
from . import db
SCHEMA='0048_process_boundary'

def require_schema():
    try:
        with sqlite3.connect(f'file:{db.DB_PATH}?mode=ro',uri=True) as conn:
            versions={r[0] for r in conn.execute('select version_num from alembic_version')}
    except sqlite3.Error as exc:
        raise RuntimeError('Database is not prepared; run bootstrap.py before API and worker.') from exc
    if versions!={SCHEMA}:raise RuntimeError(f'Incompatible database schema {versions}; expected {SCHEMA}. Run the supervised bootstrap before starting either process.')


def migrate():
    # Same lock as older in-process binaries: never migrate underneath a live
    # workspace owner, even during the one-time deployment transition.
    from . import runtime
    runtime.acquire_data_lock()
    try:db.init_db()
    finally:runtime.release_data_lock()
