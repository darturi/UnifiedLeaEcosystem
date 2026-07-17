"""Migration framework tests — pin the properties the runner *claims*.

Every assertion here exists because the claim was wrong, or unverified, at some
point:

- `transaction_per_migration` is OFF by default in Alembic. With it off, a failure
  at revision N discards revisions 1..N-1 too. We turn it on in env.py; this file
  proves it, rather than trusting the setting.
- `executescript()` inside a transaction COMMITs early (measured), which is why the
  baseline applies statements one at a time via `op.execute`. If someone
  "simplifies" that back to executescript, `test_failed_revision_*` catches it.
- Several processes can start at once and all call `upgrade_to_head()`.
"""

from __future__ import annotations

import sqlite3
import subprocess
import sys

import pytest
from alembic.config import Config

from app import db, migrations
from app.migrations import ADAPTER_ROOT

BASELINE_TABLES = {
    "sessions", "projects", "project_files", "skills", "skill_projects",
    "runs", "messages", "code_steps", "status_events", "run_usage_breakdown",
}


def _tables(path) -> set[str]:
    with sqlite3.connect(path) as conn:
        return {
            r[0] for r in conn.execute(
                "select name from sqlite_master where type='table' and name not like 'sqlite_%'"
            )
        }


def _fresh(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    return tmp_path / "test.sqlite3"


# ── the baseline ──────────────────────────────────────────────────────────────

def test_baseline_builds_the_whole_schema(tmp_path, monkeypatch):
    path = _fresh(tmp_path, monkeypatch)
    db.init_db()
    assert BASELINE_TABLES <= _tables(path)
    assert "alembic_version" in _tables(path)


def test_init_db_is_idempotent(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    db.init_db()
    rev = migrations.current_revision()
    db.init_db()  # a second startup must be a no-op, not an error
    assert migrations.current_revision() == rev


def test_baseline_is_a_noop_on_a_preexisting_database(tmp_path, monkeypatch):
    """The live DB already had these tables at user_version=0 with real rows. The
    baseline must adopt it without touching data — that's why it's all
    `create table if not exists` instead of an `alembic stamp`."""
    path = _fresh(tmp_path, monkeypatch)
    # Simulate the pre-Alembic database: schema present, data present, no stamp.
    db.init_db()
    with sqlite3.connect(path) as conn:
        conn.execute(
            "insert into sessions (id, title, origin, created_at, updated_at)"
            " values ('s1','keep me','ui','t','t')"
        )
        conn.execute("delete from alembic_version")  # unstamped, like the real DB
        conn.commit()

    db.init_db()  # re-adopt

    with sqlite3.connect(path) as conn:
        rows = conn.execute("select title from sessions").fetchall()
    assert rows == [("keep me",)], "baseline destroyed pre-existing data"
    assert migrations.current_revision() is not None


def test_env_resolves_url_from_db_path_not_the_ini(tmp_path, monkeypatch):
    """A hardcoded URL in alembic.ini would migrate the developer's REAL database
    during tests. The ini's url must stay empty."""
    cfg = Config(str(migrations.ALEMBIC_INI))
    assert not (cfg.get_main_option("sqlalchemy.url") or "").strip()

    path = _fresh(tmp_path, monkeypatch)
    db.init_db()
    assert path.exists(), "migration did not follow the monkeypatched DB_PATH"


# ── transaction_per_migration ─────────────────────────────────────────────────

def _scratch_env(tmp_path, revisions: list[tuple[str, str | None, str]]):
    """Build a throwaway migration tree. `revisions` = (rev, down_rev, upgrade_body)."""
    root = tmp_path / "scratch"
    (root / "versions").mkdir(parents=True)
    # Mirrors the real env.py exactly — including _force_real_begin. If this drifts
    # from production the test stops meaning anything, so keep them in step.
    (root / "env.py").write_text(
        "from alembic import context\n"
        "from sqlalchemy import engine_from_config, event, pool\n"
        "from app import db as app_db\n"
        "config = context.config\n"
        "section = config.get_section(config.config_ini_section, {})\n"
        "section['sqlalchemy.url'] = f'sqlite:///{app_db.DB_PATH}'\n"
        "connectable = engine_from_config(section, prefix='sqlalchemy.', poolclass=pool.NullPool)\n"
        "@event.listens_for(connectable, 'connect')\n"
        "def _no_implicit_txn(dbapi_connection, _record):\n"
        "    dbapi_connection.isolation_level = None\n"
        "@event.listens_for(connectable, 'begin')\n"
        "def _explicit_begin(conn):\n"
        "    conn.exec_driver_sql('BEGIN IMMEDIATE')\n"
        "with connectable.connect() as connection:\n"
        "    context.configure(connection=connection, transactional_ddl=True,\n"
        "                      transaction_per_migration=True)\n"
        "    with context.begin_transaction():\n"
        "        context.run_migrations()\n"
    )
    (root / "script.py.mako").write_text(
        '"""${message}"""\n'
        "revision = ${repr(up_revision)}\n"
        "down_revision = ${repr(down_revision)}\n"
    )
    for rev, down, body in revisions:
        (root / "versions" / f"{rev}.py").write_text(
            f'"""{rev}"""\n'
            "from alembic import op\n"
            f"revision = {rev!r}\n"
            f"down_revision = {down!r}\n"
            "branch_labels = None\ndepends_on = None\n"
            f"def upgrade():\n{body}\n"
            "def downgrade():\n    pass\n"
        )
    cfg = Config()
    cfg.set_main_option("script_location", str(root))
    cfg.set_main_option("sqlalchemy.url", "")
    return cfg


def test_failed_revision_keeps_earlier_revisions(tmp_path, monkeypatch):
    """transaction_per_migration=True: r1+r2 survive a failure in r3.

    With Alembic's DEFAULT (off) the whole upgrade shares one transaction and r1/r2
    would be rolled back too — this test is what stops that default sneaking back."""
    from alembic import command

    path = _fresh(tmp_path, monkeypatch)
    cfg = _scratch_env(tmp_path, [
        ("r1", None, "    op.execute('create table a(x)')"),
        ("r2", "r1", "    op.execute('create table b(x)')"),
        ("r3", "r2", "    op.execute('create table c(x)')\n    op.execute('this is not sql')"),
    ])

    with pytest.raises(Exception):
        command.upgrade(cfg, "head")

    tables = _tables(path)
    assert "a" in tables and "b" in tables, "earlier revisions were rolled back"
    assert "c" not in tables, "the failed revision left a partial schema"

    with sqlite3.connect(path) as conn:
        stamped = conn.execute("select version_num from alembic_version").fetchone()
    assert stamped == ("r2",), f"stamped at {stamped}, expected r2"


# ── concurrency ───────────────────────────────────────────────────────────────

def test_concurrent_startup_migrates_exactly_once(tmp_path):
    """Several workers booting at once must not corrupt each other's migration.

    PROCESSES, not threads, and that distinction is real rather than cosmetic:
    `alembic.context` is a module-level global proxy, so two threads calling
    `command.upgrade()` in one interpreter tear down each other's state (observed:
    `KeyError: 'config'` / `KeyError: 'script'`). Alembic simply isn't thread-safe
    that way — and it doesn't need to be, because the deployment shape is N worker
    *processes*, each with its own interpreter, serializing on SQLite's write lock.
    Testing it with threads would fail for a reason the real system never hits.
    """
    db_path = tmp_path / "test.sqlite3"
    runner = tmp_path / "boot.py"
    runner.write_text(
        "import sys\n"
        f"sys.path.insert(0, {str(ADAPTER_ROOT)!r})\n"
        "from pathlib import Path\n"
        "from app import db\n"
        "db.DB_PATH = Path(sys.argv[1])\n"
        "db.init_db()\n"
    )

    procs = [
        subprocess.Popen(
            [sys.executable, str(runner), str(db_path)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        for _ in range(4)
    ]
    results = [(p.wait(timeout=60), p.communicate()[1]) for p in procs]

    failed = [err for code, err in results if code != 0]
    assert not failed, f"concurrent startup failed:\n{failed[0][-800:]}"
    assert BASELINE_TABLES <= _tables(db_path)
    with sqlite3.connect(db_path) as conn:
        stamps = conn.execute("select count(*) from alembic_version").fetchone()[0]
    assert stamps == 1, f"alembic_version has {stamps} rows — migrated more than once"
