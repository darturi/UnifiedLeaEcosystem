"""Unit tests for item 8 (v2.3 concurrency) — the per-activation run context and
the `bash` cwd fix that stands on it.

The bug on `main`: `bash` runs `subprocess.run(shell=True)` with **no `cwd=`**, so
every run's shell command executes in the one process-global working directory.
Under concurrent runs (and subagents) that means run A's `bash` can read/write in
run B's tree. `lea/runctx.py` puts the working dir in a `ContextVar` set at the
activation boundary; `bash` reads it and passes it as `cwd=`.

These tests assert the concurrency shape, not Lean behavior — no toolchain needed.
Two threads, each in its own `run_context(working_dir=...)`, run `bash` at the same
time (a barrier forces overlap) and must each see **only their own** directory. On
`main` (bash ignores the context, both run in the process cwd) the "saw my own
tree" checks fail.

Run:  uv run python -m tests.tools.test_run_context
Exits 0 if every check passes, 1 otherwise.
"""

import tempfile
import threading
from pathlib import Path

import lea.tools as tools
from lea.runctx import (
    current_candidate_dir,
    current_run_key,
    current_working_dir,
    run_context,
)

_FAILURES: list[str] = []


def check(name: str, cond: bool) -> None:
    print(f"  ok   {name}" if cond else f"  FAIL {name}")
    if not cond:
        _FAILURES.append(name)


def test_defaults_are_none_outside_any_context() -> None:
    """The loose/standalone path never establishes a context; reads must return
    None so `bash` passes `cwd=None` and behaves exactly as it does today."""
    check("working_dir defaults to None", current_working_dir() is None)
    check("run_key defaults to None", current_run_key() is None)
    check("candidate_dir defaults to None", current_candidate_dir() is None)


def test_context_sets_and_resets() -> None:
    """`run_context` sets the vars for its block and resets on exit, so a reused
    thread doesn't leak one activation's working_dir into the next call."""
    with run_context(working_dir="/tmp/a", run_key="run-a", candidate_dir="/tmp/a/cand"):
        check("working_dir is set inside the block", current_working_dir() == "/tmp/a")
        check("run_key is set inside the block", current_run_key() == "run-a")
        check("candidate_dir is set inside the block", current_candidate_dir() == "/tmp/a/cand")
    check("working_dir resets to None after the block", current_working_dir() is None)
    check("run_key resets to None after the block", current_run_key() is None)
    check("candidate_dir resets to None after the block", current_candidate_dir() is None)


def test_bash_runs_in_the_contexts_working_dir_concurrently() -> None:
    """The core fix, as a race: two threads with different `working_dir`s run
    `bash` simultaneously; each must read only its own tree. Fails on `main`,
    where both land in the process-global cwd and see neither marker."""
    with tempfile.TemporaryDirectory() as da, tempfile.TemporaryDirectory() as db:
        dirs = {0: da, 1: db}
        for i, d in dirs.items():
            (Path(d) / f"marker_{i}.txt").write_text(f"iam-{i}\n")

        barrier = threading.Barrier(len(dirs))
        seen: dict[int, str] = {}

        def worker(i: int) -> None:
            with run_context(working_dir=dirs[i], run_key=f"run-{i}"):
                barrier.wait(timeout=5)  # force the two bash calls to overlap
                # `ls` names its own dir's marker; grep the other's to prove
                # isolation in one shell call.
                seen[i] = tools.bash(f"ls; echo '---'; cat marker_{1 - i}.txt 2>/dev/null")

        threads = [threading.Thread(target=worker, args=(i,)) for i in dirs]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)

        check("both bash calls completed", all(not t.is_alive() for t in threads))
        for i in dirs:
            out = seen.get(i, "")
            check(f"thread {i} saw its own marker (marker_{i}.txt)", f"marker_{i}.txt" in out)
            check(f"thread {i} did NOT see the peer's file content (iam-{1 - i})",
                  f"iam-{1 - i}" not in out)


def test_context_isolation_across_threads() -> None:
    """ContextVars are per-thread: a value set in one thread's context is invisible
    to another. This is why per-run threads don't need locking to keep their
    working_dir apart — the isolation is the primitive, not a guard we add."""
    other_saw: list[str | None] = []
    ready = threading.Event()
    go = threading.Event()

    def other() -> None:
        ready.set()
        go.wait(timeout=5)
        other_saw.append(current_working_dir())

    t = threading.Thread(target=other)
    t.start()
    ready.wait(timeout=5)
    with run_context(working_dir="/tmp/mine"):
        go.set()
        t.join(timeout=5)
    check("a peer thread never sees this thread's working_dir", other_saw == [None])


def main() -> None:
    print("Run-context + bash cwd tests (item 8):")
    test_defaults_are_none_outside_any_context()
    test_context_sets_and_resets()
    test_bash_runs_in_the_contexts_working_dir_concurrently()
    test_context_isolation_across_threads()
    print()
    if _FAILURES:
        print(f"FAILED ({len(_FAILURES)}): {', '.join(_FAILURES)}")
        raise SystemExit(1)
    print("All run-context tests passed.")
    raise SystemExit(0)


if __name__ == "__main__":
    main()
