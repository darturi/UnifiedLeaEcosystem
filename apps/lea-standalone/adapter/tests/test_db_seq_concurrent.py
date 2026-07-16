"""C4 under concurrency: the shared per-session `seq` must stay unique.

`test_db_seq.py` covers the single-threaded contract. It passes even with the
read-modify-write bug, because the bug needs two writers in flight at once —
which is exactly what concurrent runs (and subagents) introduce.

The failure this pins is SILENT: no exception, no "database is locked", just rows
sharing a seq. `ORDER BY seq` then returns duplicates in arbitrary order, so the
timeline interleaves wrong and the derived session status can read the wrong
"latest" code_step. Measured on `main` before the fix: 0 errors, 99-119 duplicate
seqs per 200 concurrent inserts.
"""

import threading

from app import db, store

THREADS = 8
PER_THREAD = 25
TOTAL = THREADS * PER_THREAD


def _fresh_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()


def _hammer(fn):
    """Run `fn(i)` from THREADS threads, PER_THREAD times each; collect exceptions."""
    errors = []
    lock = threading.Lock()

    def worker(t):
        for i in range(PER_THREAD):
            try:
                fn(t * PER_THREAD + i)
            except Exception as exc:  # noqa: BLE001 - the test reports whatever surfaced
                with lock:
                    errors.append(f"{type(exc).__name__}: {exc}")

    threads = [threading.Thread(target=worker, args=(t,)) for t in range(THREADS)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return errors


def _seqs(session_id):
    with db.connect() as conn:
        rows = conn.execute(
            """
            select seq from code_steps where session_id = ?
            union all
            select seq from messages where session_id = ?
            """,
            (session_id, session_id),
        ).fetchall()
    return [r["seq"] for r in rows]


def test_concurrent_messages_get_unique_seqs(tmp_path, monkeypatch):
    _fresh_db(tmp_path, monkeypatch)
    session = store.create_session("Concurrent messages")
    run = store.create_run(session["id"], "gpt-4o", "openai", 3)

    errors = _hammer(lambda i: store.add_message(session["id"], "assistant", f"m{i}", run["id"]))

    seqs = _seqs(session["id"])
    assert not errors, f"unexpected errors: {errors[:3]}"
    assert len(seqs) == TOTAL, f"lost rows: {len(seqs)}/{TOTAL}"
    assert len(set(seqs)) == TOTAL, f"{TOTAL - len(set(seqs))} duplicate seqs"


def test_concurrent_mixed_writers_share_one_contiguous_counter(tmp_path, monkeypatch):
    """messages and code_steps draw from the SAME counter, so racing the two tables
    against each other is the real-world shape: a run narrates while it writes."""
    _fresh_db(tmp_path, monkeypatch)
    session = store.create_session("Concurrent mixed")
    run = store.create_run(session["id"], "gpt-4o", "openai", 3)

    def either(i):
        if i % 2:
            store.add_message(session["id"], "assistant", f"m{i}", run["id"])
        else:
            store.add_code_step(session["id"], run["id"], "p.lean", commit_sha=f"{i:040x}")

    errors = _hammer(either)

    seqs = _seqs(session["id"])
    assert not errors, f"unexpected errors: {errors[:3]}"
    assert len(seqs) == TOTAL, f"lost rows: {len(seqs)}/{TOTAL}"
    assert sorted(seqs) == list(range(1, TOTAL + 1)), (
        f"{TOTAL - len(set(seqs))} duplicate seqs; counter must be unique and gapless"
    )


def test_sessions_do_not_share_a_counter_under_load(tmp_path, monkeypatch):
    """Each session's seq restarts at 1. Concurrent writes to *different* sessions
    must not bleed into each other's counters."""
    _fresh_db(tmp_path, monkeypatch)
    a = store.create_session("A")
    b = store.create_session("B")
    run_a = store.create_run(a["id"], "gpt-4o", "openai", 3)
    run_b = store.create_run(b["id"], "gpt-4o", "openai", 3)

    errors = _hammer(
        lambda i: store.add_message(
            (a if i % 2 else b)["id"], "assistant", f"m{i}", (run_a if i % 2 else run_b)["id"]
        )
    )

    assert not errors, f"unexpected errors: {errors[:3]}"
    for session in (a, b):
        seqs = _seqs(session["id"])
        assert sorted(seqs) == list(range(1, len(seqs) + 1)), f"session {session['title']} counter broken"
