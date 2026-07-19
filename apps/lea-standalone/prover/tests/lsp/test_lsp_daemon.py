"""Unit tests for `lea/lsp_daemon.py`'s staleness invalidation (`mark_stale`).

Regression test for the Overleaf lean pane's manual-edit rename bug: rebuilding
a module via a separate `lake build` subprocess (`tools.rebuild_module`) cannot
reach into an already-running `lean --server` daemon and refresh its cached
import of that module -- Lean's environment/import cache lives for the life of
the process, not the file on disk. `mark_stale()` is the fix: it flags the
daemon so its *next* check restarts the server first, instead of silently
serving the pre-rebuild environment forever. See
docs/FEATURE-overleaf-lean-pane-manual-edit.md ("Cascade verification") and
`tools.lean_check_cold` for the companion fix (the one call that can't even
wait for a lazy restart).

These tests stub `LeanDaemon` entirely -- no real Lean toolchain needed -- and
assert only the daemon-selection bookkeeping in `check_via_lsp`/`mark_stale`,
mirroring how `tests/tools/test_rebuild_module.py` stubs `subprocess.run`.

Run:  uv run python -m tests.lsp.test_lsp_daemon
Exits 0 if every check passes, 1 otherwise.
"""

import sys

import lea.lsp_daemon as lsp_daemon
from lea.lsp_daemon import check_via_lsp, mark_stale

_FAILURES: list[str] = []


def check(name: str, cond: bool) -> None:
    print(f"  ok   {name}" if cond else f"  FAIL {name}")
    if not cond:
        _FAILURES.append(name)


class _FakeDaemon:
    """Stands in for LeanDaemon so these tests need no real `lake`/`lean`.

    Mirrors the lease/retire surface `check_via_lsp` drives: a retired daemon
    shuts down once its (here always already-released) lease drains."""

    def __init__(self, lake_root):
        self.lake_root = lake_root
        self.broken = False
        self.stale = False
        self._check_count = 0
        self._leases = 0
        self.shutdown_called = False

    def start(self):
        return True

    def check(self, file_path, content):
        self._check_count += 1
        return "OK — no errors, no warnings."

    def shutdown(self):
        self.shutdown_called = True

    def _acquire_lease(self):
        self._leases += 1

    def _release_lease(self):
        self._leases -= 1

    def _retire(self):
        if self._leases == 0:
            self.shutdown()


def _reset():
    lsp_daemon._daemons.clear()


def test_mark_stale_flags_the_tracked_daemon():
    _reset()
    real_cls = lsp_daemon.LeanDaemon
    lsp_daemon.LeanDaemon = _FakeDaemon
    try:
        check_via_lsp("a.lean", "content", "/root")
        d = lsp_daemon._daemons["/root"]
        check("daemon starts non-stale", d.stale is False)

        mark_stale("/root")
        check("mark_stale sets the flag", d.stale is True)
    finally:
        lsp_daemon.LeanDaemon = real_cls
        _reset()


def test_mark_stale_is_a_noop_for_an_untracked_root():
    _reset()
    try:
        mark_stale("/never-started")  # must not raise
        check("mark_stale on an unstarted root tracks nothing new",
              "/never-started" not in lsp_daemon._daemons)
    finally:
        _reset()


def test_a_stale_daemon_is_restarted_on_its_next_check():
    """The actual bug fix: without this, a daemon that already imported a
    module keeps serving that module's pre-rebuild environment forever, no
    matter how many times a *different* process rebuilds it (this is exactly
    what let a renamed declaration's dependent keep reporting 'ok')."""
    _reset()
    real_cls = lsp_daemon.LeanDaemon
    lsp_daemon.LeanDaemon = _FakeDaemon
    try:
        check_via_lsp("a.lean", "v1", "/root")
        first = lsp_daemon._daemons["/root"]

        mark_stale("/root")
        check_via_lsp("a.lean", "v1", "/root")
        second = lsp_daemon._daemons["/root"]

        check("stale daemon was shut down", first.shutdown_called is True)
        check("a fresh daemon replaced it", second is not first)
        check("the new daemon starts non-stale", second.stale is False)
    finally:
        lsp_daemon.LeanDaemon = real_cls
        _reset()


def test_non_stale_daemon_is_reused_across_calls():
    """Regression guard: mark_stale must not make every check pay a restart --
    only a call that happens after mark_stale() should trigger one."""
    _reset()
    real_cls = lsp_daemon.LeanDaemon
    lsp_daemon.LeanDaemon = _FakeDaemon
    try:
        check_via_lsp("a.lean", "v1", "/root")
        first = lsp_daemon._daemons["/root"]
        check_via_lsp("a.lean", "v2", "/root")
        second = lsp_daemon._daemons["/root"]

        check("same daemon reused when not stale/broken/exhausted", second is first)
        check("no premature shutdown", first.shutdown_called is False)
    finally:
        lsp_daemon.LeanDaemon = real_cls
        _reset()


def main():
    print("lsp_daemon mark_stale tests:")
    test_mark_stale_flags_the_tracked_daemon()
    test_mark_stale_is_a_noop_for_an_untracked_root()
    test_a_stale_daemon_is_restarted_on_its_next_check()
    test_non_stale_daemon_is_reused_across_calls()
    print()
    if _FAILURES:
        print(f"FAILED ({len(_FAILURES)}): {', '.join(_FAILURES)}")
        sys.exit(1)
    print("All lsp_daemon mark_stale tests passed.")
    sys.exit(0)


if __name__ == "__main__":
    main()
