"""End-to-end regression test for the Overleaf lean pane's manual-edit rename
bug, against a REAL Lean toolchain (no mocks) -- the gap the unit tests in
tests/interface/test_check.py, tests/tools/test_rebuild_module.py, and
tests/lsp/test_lsp_daemon.py can't close on their own, since they all stub the
daemon/subprocess boundary rather than exercising a real `lake env lean
--server` process.

The bug this reproduces (see docs/FEATURE-overleaf-lean-pane-manual-edit.md,
"Cascade verification"): given an upstream declaration and a downstream one
that depends on it, both already checked once through the shared persistent
LSP daemon (`lea/lsp_daemon.py`) -- exactly what happens the first time each is
formalized -- renaming the upstream declaration and re-verifying the
downstream one used to still report "ok", because the daemon had already
imported the upstream module into memory and a `lake build` in a separate
process (`tools.rebuild_module`) can't reach into that daemon and refresh it.

This test:
  1. writes a real upstream/downstream pair under the shared workspace,
  2. warms the daemon on both (mirroring each having been checked once during
     its own formalization),
  3. renames the upstream declaration and rebuilds it for real,
  4. asserts the downstream re-check now correctly reports the break, via the
     ordinary warm path -- `rebuild_module` calls `lsp_daemon.mark_stale`,
     which flags the daemon to restart on its very next use, and that restart
     is what makes it see the rebuilt module correctly.

A first version of this fix also tried bypassing the daemon entirely for the
cascade check (`tools.lean_check_cold` / `interface.check(..., cold=True)`).
Running this test live turned up that the cold `lake env lean <file>`
subprocess does NOT reliably see the rebuilt module's fresh `.olean` either --
a real Lean/Lake behavior difference from a restarted `--server` process, not
yet understood. Production (`routes/sessions.py`) does not use `cold=True` for
this reason; it relies solely on the mark_stale-triggered restart asserted
below. `lean_check_cold`/`cold=` are kept as documented, tested primitives at
the unit level, but this test intentionally does not lean on them.

Requires a real Lean/Lake toolchain with this project's Mathlib pin already
built (`workspace/.lake`) -- skips cleanly (exit 0) if `lake` isn't on PATH,
so it's safe to include in a suite that also runs somewhere without one.

Run:  uv run python -m tests.lsp.test_cascade_rename_integration
Exits 0 if every check passes (or the toolchain is unavailable), 1 otherwise.
"""

import shutil
import sys
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parents[2] / "workspace"
NAMESPACE_DIR = WORKSPACE / "proofs" / "Lea" / "TestCascadeRename"
UPSTREAM = NAMESPACE_DIR / "Upstream.lean"
DOWNSTREAM = NAMESPACE_DIR / "Downstream.lean"

_FAILURES: list[str] = []


def check(name: str, cond: bool) -> None:
    print(f"  ok   {name}" if cond else f"  FAIL {name}")
    if not cond:
        _FAILURES.append(name)


def _write_upstream(declaration_name: str) -> None:
    UPSTREAM.write_text(
        "namespace Lea.TestCascadeRename\n\n"
        f"theorem {declaration_name} : True := trivial\n\n"
        "end Lea.TestCascadeRename\n"
    )


def _write_downstream(upstream_reference: str) -> None:
    DOWNSTREAM.write_text(
        "import Lea.TestCascadeRename.Upstream\n\n"
        "namespace Lea.TestCascadeRename\n\n"
        f"theorem bar : True := {upstream_reference}\n\n"
        "end Lea.TestCascadeRename\n"
    )


def _cleanup() -> None:
    shutil.rmtree(NAMESPACE_DIR, ignore_errors=True)
    for rel in ("Lea/TestCascadeRename/Upstream", "Lea/TestCascadeRename/Downstream"):
        for suffix in (".olean", ".ilean", ".trace"):
            (WORKSPACE / ".lake" / "build" / "lib" / "lean" / f"{rel}{suffix}").unlink(missing_ok=True)


def main() -> None:
    if shutil.which("lake") is None:
        print("tests.lsp.test_cascade_rename_integration: `lake` not on PATH, skipping.")
        sys.exit(0)

    NAMESPACE_DIR.mkdir(parents=True, exist_ok=True)
    try:
        import lea.tools as tools
        import lea.interface as interface

        # 1. Establish a known-good starting state and warm the shared daemon on
        # both files, mirroring what real formalization does: each target gets
        # checked (and therefore its imports resolved and cached) at least once.
        _write_upstream("foo")
        _write_downstream("foo")
        upstream_build = tools.rebuild_module(str(UPSTREAM))
        check("initial upstream build succeeds", not tools._lean_check_has_error(upstream_build))
        warm_before_rename = interface.check(str(DOWNSTREAM))
        check("downstream check is ok before any edit", warm_before_rename.status == "ok")

        # 2. The manual edit: rename the upstream declaration. Downstream is left
        # untouched -- it still calls the old name, so it is now genuinely broken.
        _write_upstream("eps")
        own_check = interface.check(str(UPSTREAM))  # the edit's own check (warm path, same-file -- always correct)
        check("upstream's own check still passes (renamed, not broken)", own_check.status == "ok")

        # 3. The cascade's rebuild step: a real `lake build` of the edited module,
        # in a separate subprocess, plus the mark_stale side effect under test.
        rebuild_result = tools.rebuild_module(str(UPSTREAM))
        check("rebuild of the renamed module succeeds", not tools._lean_check_has_error(rebuild_result))

        # 4. The actual production fix: mark_stale flagged the daemon in step 3,
        # so this ordinary warm re-check restarts the daemon first and correctly
        # reports the break -- this is the case that reproduces the original bug
        # report (VS Code showed Downstream broken; the pane's own re-check kept
        # saying "ok"). This is what routes/sessions.py relies on for the
        # cascade path; see the module docstring for why cold=True is not used.
        warm_result = interface.check(str(DOWNSTREAM))
        check("warm re-check (post mark_stale) reports the break", warm_result.status == "error")
    finally:
        _cleanup()

    print()
    if _FAILURES:
        print(f"FAILED ({len(_FAILURES)}): {', '.join(_FAILURES)}")
        sys.exit(1)
    print("All cascade-rename integration checks passed.")
    sys.exit(0)


if __name__ == "__main__":
    main()
