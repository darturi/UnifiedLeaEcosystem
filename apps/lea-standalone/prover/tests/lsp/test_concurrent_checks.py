"""Real-Lean concurrency guard for `lea/lsp_daemon.py` (slow, opt-in).

Two threads hammer one warm `lake env lean --server` with distinct documents --
a `Good` file (`1 + 1 = 2`) and a `Bad` file (`1 + 1 = 3`) -- over several
staggered rounds. Every Good check must come back clean and every Bad check must
report an error attributed to the Bad file. On the old single-shared-queue
daemon this is exactly what broke: different files starve each other to a 900s
timeout, and same-stem/same-content races can hand thread A a verdict computed
from thread B's document. `LEAN_CHECK_TIMEOUT=30` here so that starvation fails
fast instead of after 15 minutes.

This needs the real toolchain + a built workspace, so it is opt-in. It runs when
invoked directly if `lake` is on PATH; set `LEA_SKIP_LEAN_TESTS=1` to skip.

Run:  uv run python -m tests.lsp.test_concurrent_checks
Exits 0 if every check passes (or the suite is skipped), 1 otherwise.
"""
import os
import shutil
import sys
import threading
from pathlib import Path

os.environ.setdefault("LEAN_CHECK_TIMEOUT", "30")

import lea.lsp_daemon as lsp_daemon  # noqa: E402
from lea.lsp_daemon import check_via_lsp  # noqa: E402

_FAILURES: list[str] = []

WORKSPACE = (Path(__file__).resolve().parents[2] / "workspace").resolve()
PROOFS = WORKSPACE / "proofs" / "Lea"
GOOD = PROOFS / "_ConcGood.lean"
BAD = PROOFS / "_ConcBad.lean"

GOOD_SRC = "import Mathlib\n\nnamespace Lea.ConcGood\n\nexample : 1 + 1 = 2 := by rfl\n"
BAD_SRC = "import Mathlib\n\nnamespace Lea.ConcBad\n\nexample : 1 + 1 = 3 := by rfl\n"

ROUNDS = 3


def note(msg: str) -> None:
    print(f"  {msg}")


def fail(msg: str) -> None:
    print(f"  FAIL {msg}")
    _FAILURES.append(msg)


def _skip(reason: str) -> None:
    print(f"lsp_daemon concurrent real-Lean test: SKIPPED ({reason})")
    sys.exit(0)


def main():
    if os.environ.get("LEA_SKIP_LEAN_TESTS"):
        _skip("LEA_SKIP_LEAN_TESTS set")
    if shutil.which("lake") is None:
        _skip("lake not on PATH")
    if not (WORKSPACE / "lakefile.lean").exists():
        _skip(f"no workspace at {WORKSPACE}")

    print("lsp_daemon concurrent real-Lean test (this is slow — cold Mathlib load):")
    GOOD.write_text(GOOD_SRC)
    BAD.write_text(BAD_SRC)
    lake_root = str(WORKSPACE)

    verdicts: dict[str, list] = {"good": [], "bad": []}
    errors: list[str] = []
    lock = threading.Lock()

    def hammer(path: Path, src: str, key: str):
        for _ in range(ROUNDS):
            try:
                out = check_via_lsp(str(path), src, lake_root)
            except Exception as e:  # noqa: BLE001
                with lock:
                    errors.append(f"{key}: {e!r}")
                return
            with lock:
                verdicts[key].append(out)

    tg = threading.Thread(target=hammer, args=(GOOD, GOOD_SRC, "good"))
    tb = threading.Thread(target=hammer, args=(BAD, BAD_SRC, "bad"))
    tg.start()
    tb.start()  # staggered only by thread-start latency; opens interleave
    tg.join()
    tb.join()

    try:
        if errors:
            for e in errors:
                fail(f"check raised: {e}")

        note(f"good verdicts: {len(verdicts['good'])}/{ROUNDS}, bad: {len(verdicts['bad'])}/{ROUNDS}")

        if len(verdicts["good"]) != ROUNDS:
            fail(f"expected {ROUNDS} good verdicts, got {len(verdicts['good'])}")
        for i, out in enumerate(verdicts["good"]):
            if "no errors" not in out:
                fail(f"good round {i} not clean: {out!r}")

        if len(verdicts["bad"]) != ROUNDS:
            fail(f"expected {ROUNDS} bad verdicts, got {len(verdicts['bad'])}")
        for i, out in enumerate(verdicts["bad"]):
            # Must be an error, and attributed to the Bad file — not Good's.
            if "error" not in out.lower():
                fail(f"bad round {i} did not report an error: {out!r}")
            elif "_ConcBad.lean" not in out:
                fail(f"bad round {i} verdict not attributed to Bad file: {out!r}")
    finally:
        lsp_daemon._shutdown_all()
        for p in (GOOD, BAD):
            try:
                p.unlink()
            except FileNotFoundError:
                pass

    print()
    if _FAILURES:
        print(f"FAILED ({len(_FAILURES)})")
        sys.exit(1)
    print("Concurrent real-Lean checks passed: Good clean, Bad errored, no cross-talk.")
    sys.exit(0)


if __name__ == "__main__":
    main()
