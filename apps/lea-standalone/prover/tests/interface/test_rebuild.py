"""Unit tests for the standalone rebuild(path) capability (interface.py).

rebuild() wraps rebuild_module + the shared output classifiers into a structured
CheckResult, no agent run -- the same shape as check(), see test_check.py. We
monkeypatch interface.rebuild_module so the test needs no Lean toolchain;
rebuild_module's own output-shaping (making sure a real `lake build` failure is
always classifiable even when Lake's own log has no "error:" text) is covered
separately in tests/tools/test_rebuild_module.py.

Run:  uv run python -m tests.interface.test_rebuild
Exits 0 if every check passes, 1 otherwise.
"""

import sys

import lea.interface as interface
from lea.events import CheckResult

_FAILURES: list[str] = []
_ORIG_REBUILD_MODULE = interface.rebuild_module


def check(name: str, cond: bool) -> None:
    print(f"  ok   {name}" if cond else f"  FAIL {name}")
    if not cond:
        _FAILURES.append(name)


def _with_rebuild_module(output: str):
    """Run interface.rebuild('a.lean') with rebuild_module stubbed to return `output`."""
    interface.rebuild_module = lambda path: output
    try:
        return interface.rebuild("a.lean")
    finally:
        interface.rebuild_module = _ORIG_REBUILD_MODULE


def test_clean():
    r = _with_rebuild_module("OK — rebuilt.")
    check("clean -> CheckResult", isinstance(r, CheckResult))
    check("clean status ok", r.status == "ok")
    check("clean detail None", r.detail is None)
    check("clean path carried", r.path == "a.lean")


def test_error():
    # The shape rebuild_module now guarantees on a real lake build failure
    # (tools.py's "error: lake build failed for <module> ..." prefix) --
    # regardless of whatever Lake's own log happened to contain.
    out = "error: lake build failed for Lea.Proj.Foo (exit 1):\n✗ [1/1] Building Lea.Proj.Foo (0.1s)"
    r = _with_rebuild_module(out)
    check("error status error", r.status == "error")
    check("error detail = first error line",
          r.detail == "error: lake build failed for Lea.Proj.Foo (exit 1):")


def test_missing_file_is_error():
    r = _with_rebuild_module("Error: /tmp/a.lean does not exist.")
    check("missing file -> error verdict", r.status == "error")
    check("missing file detail set", r.detail is not None)


def main():
    print("interface.rebuild tests:")
    test_clean()
    test_error()
    test_missing_file_is_error()
    print()
    if _FAILURES:
        print(f"FAILED ({len(_FAILURES)}): {', '.join(_FAILURES)}")
        sys.exit(1)
    print("All interface.rebuild tests passed.")
    sys.exit(0)


if __name__ == "__main__":
    main()
