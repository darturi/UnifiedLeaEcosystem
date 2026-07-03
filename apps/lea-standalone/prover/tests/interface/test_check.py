"""Unit tests for A5: the standalone check(path) capability (interface.py).

check() wraps lean_check + the output classifiers into a structured CheckResult,
with no agent run. We monkeypatch interface.lean_check so the test needs no Lean
toolchain — check()'s only job is to classify whatever lean_check returns.

Run:  uv run python -m tests.interface.test_check
Exits 0 if every check passes, 1 otherwise.
"""

import sys

import lea.interface as interface
from lea.events import CheckResult

_FAILURES: list[str] = []
_ORIG_LEAN_CHECK = interface.lean_check
_ORIG_LEAN_CHECK_COLD = interface.lean_check_cold


def check(name: str, cond: bool) -> None:
    print(f"  ok   {name}" if cond else f"  FAIL {name}")
    if not cond:
        _FAILURES.append(name)


def _with_lean_check(output: str):
    """Run interface.check('a.lean') with lean_check stubbed to return `output`."""
    interface.lean_check = lambda path: output
    try:
        return interface.check("a.lean")
    finally:
        interface.lean_check = _ORIG_LEAN_CHECK


def test_clean():
    r = _with_lean_check("OK — no errors, no warnings.")
    check("clean -> CheckResult", isinstance(r, CheckResult))
    check("clean status ok", r.status == "ok")
    check("clean detail None", r.detail is None)
    check("clean path carried", r.path == "a.lean")


def test_error():
    out = "a.lean:3:1: error: unknown identifier 'foo'\nsome trailing context"
    r = _with_lean_check(out)
    check("error status error", r.status == "error")
    check("error detail = first error line",
          r.detail == "a.lean:3:1: error: unknown identifier 'foo'")


def test_missing_file_is_error():
    # lean_check returns "Error: <p> does not exist." for a missing file.
    r = _with_lean_check("Error: /tmp/a.lean does not exist.")
    check("missing file -> error verdict", r.status == "error")
    check("missing file detail set", r.detail is not None)


def test_warning_only_is_ok():
    # `sorry` warnings are not errors — a warning-only check is a pass.
    r = _with_lean_check("a.lean:1:0: warning: declaration uses 'sorry'")
    check("warning-only -> ok", r.status == "ok")
    check("warning-only detail None", r.detail is None)


def test_default_uses_the_warm_lean_check_not_the_cold_path():
    calls = {"warm": 0, "cold": 0}
    interface.lean_check = lambda path: (calls.__setitem__("warm", calls["warm"] + 1), "OK — no errors, no warnings.")[1]
    interface.lean_check_cold = lambda path: (calls.__setitem__("cold", calls["cold"] + 1), "OK — no errors, no warnings.")[1]
    try:
        interface.check("a.lean")
    finally:
        interface.lean_check = _ORIG_LEAN_CHECK
        interface.lean_check_cold = _ORIG_LEAN_CHECK_COLD
    check("cold=False (default) calls lean_check", calls == {"warm": 1, "cold": 0})


def test_cold_true_uses_lean_check_cold_not_the_warm_path():
    """docs/FEATURE-overleaf-lean-pane-manual-edit.md ('Cascade verification'):
    the Overleaf lean pane's cascade re-check of a dependent passes cold=True so
    it bypasses the persistent LSP daemon, which may still have a just-rebuilt
    sibling module's pre-rebuild environment cached in memory (lsp_daemon.py)."""
    calls = {"warm": 0, "cold": 0}
    interface.lean_check = lambda path: (calls.__setitem__("warm", calls["warm"] + 1), "OK — no errors, no warnings.")[1]
    interface.lean_check_cold = lambda path: (calls.__setitem__("cold", calls["cold"] + 1), "a.lean:3:1: error: unknown identifier 'epsilon_one'")[1]
    try:
        r = interface.check("a.lean", cold=True)
    finally:
        interface.lean_check = _ORIG_LEAN_CHECK
        interface.lean_check_cold = _ORIG_LEAN_CHECK_COLD
    check("cold=True calls lean_check_cold, not lean_check", calls == {"warm": 0, "cold": 1})
    check("cold=True verdict still classified correctly", r.status == "error")


def main():
    print("interface.check (A5) tests:")
    test_clean()
    test_error()
    test_missing_file_is_error()
    test_warning_only_is_ok()
    test_default_uses_the_warm_lean_check_not_the_cold_path()
    test_cold_true_uses_lean_check_cold_not_the_warm_path()
    print()
    if _FAILURES:
        print(f"FAILED ({len(_FAILURES)}): {', '.join(_FAILURES)}")
        sys.exit(1)
    print("All interface.check tests passed.")
    sys.exit(0)


if __name__ == "__main__":
    main()
