"""Unit tests for A6: the standalone verify(path) capability (interface.py).

The fast green gate stubs the expensive SafeVerify grader (safeverify.verify_proof
/ is_available), so it needs no Lean toolchain — verify()'s job here is the
orchestration + the (ok, detail) -> VerifyResult mapping.

A real, opt-in integration test (actually runs the built binary, ~minutes) is
guarded behind LEA_RUN_SV_INTEGRATION=1 and the binary being present.

Run:  uv run python -m tests.interface.test_verify
      LEA_RUN_SV_INTEGRATION=1 uv run python -m tests.interface.test_verify   # + real grader
"""

import os
import sys
import tempfile
from pathlib import Path

import lea.interface as interface
from lea import safeverify
from lea.events import VerifyResult

_FAILURES: list[str] = []
_ORIG = {"is_available": safeverify.is_available, "verify_proof": safeverify.verify_proof}


def check(name: str, cond: bool) -> None:
    print(f"  ok   {name}" if cond else f"  FAIL {name}")
    if not cond:
        _FAILURES.append(name)


def _restore():
    safeverify.is_available = _ORIG["is_available"]
    safeverify.verify_proof = _ORIG["verify_proof"]


def _verify_with(code: str, *, available=True, proof_result=None, raises=False):
    """Run interface.verify on a temp file with the grader stubbed."""
    safeverify.is_available = lambda: available

    def fake_verify_proof(*a, **k):
        if raises:
            raise RuntimeError("boom")
        return proof_result

    safeverify.verify_proof = fake_verify_proof
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "Proof.lean"
        f.write_text(code)
        try:
            return interface.verify(str(f))
        finally:
            _restore()


# --- pure: target derivation -------------------------------------------------

def test_theorem_signature():
    sig = safeverify.theorem_signature("import Mathlib\n\ntheorem foo (n : Nat) : n = n := by rfl\n")
    check("signature strips body", sig == "theorem foo (n : Nat) : n = n")
    sig2 = safeverify.theorem_signature("lemma bar : True := by trivial")
    check("lemma works", sig2 == "lemma bar : True")
    multi = "theorem a : True := by trivial\ntheorem b : 1 = 1 := by rfl\n"
    check("picks the last theorem", safeverify.theorem_signature(multi) == "theorem b : 1 = 1")
    check("no theorem -> None", safeverify.theorem_signature("import Mathlib\n#check Nat") is None)


def test_namespace_context():
    op, cl = safeverify.namespace_context("import Mathlib\ntheorem t : True := by trivial\n")
    check("top-level -> no wrapper", (op, cl) == ("", ""))
    code = "import Mathlib\n\nnamespace Lea.Misc\n\ntheorem t : True := by trivial\n\nend Lea.Misc\n"
    op2, cl2 = safeverify.namespace_context(code)
    check("opens the namespace", "namespace Lea.Misc\n" in op2)
    check("closes the namespace", cl2.strip() == "end Lea.Misc")


def test_target_reproduces_submission_namespace():
    """Regression (the n³-n false reject): a namespaced proof's target must be
    built inside the SAME namespace, or SafeVerify looks up a root-level `div_6`,
    can't find it in a proof that defines `Lea.Misc.div_6`, and rejects a valid
    proof with 'declaration not found in submission'."""
    captured: dict[str, str] = {}

    def fake_verify_proof(target, submission, workspace, **k):
        captured["target"] = Path(target).read_text()
        return (True, "OK")

    safeverify.is_available = lambda: True
    safeverify.verify_proof = fake_verify_proof
    code = "import Mathlib\n\nnamespace Lea.Misc\n\ntheorem div_6 (n : Int) : True := by trivial\n\nend Lea.Misc\n"
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "Div6.lean"
        f.write_text(code)
        try:
            interface.verify(str(f))
        finally:
            _restore()
    target = captured.get("target", "")
    check("target opens the namespace", "namespace Lea.Misc" in target)
    check("target closes the namespace", "end Lea.Misc" in target)
    check("target keeps the signature + sorry", "theorem div_6" in target and "sorry" in target)


# --- pure: replay LEAN_PATH augmentation -------------------------------------

def test_replay_env_adds_workspace_build_lib():
    """The `lake exe safe_verify` replay runs under SafeVerify's Lake project,
    which can't see the workspace's compiled `Lea.*` oleans. `_replay_env` must
    prepend the workspace build lib to LEAN_PATH so a sibling-importing proof
    (`import Lea.<Project>.Foo`) resolves instead of failing 'unknown module
    prefix Lea'. Pure: just exercises the path math + env merge."""
    with tempfile.TemporaryDirectory() as d:
        proj = Path(d)
        build_lib = proj / ".lake" / "build" / "lib" / "lean"
        build_lib.mkdir(parents=True)
        prior = os.environ.get("LEAN_PATH")
        os.environ["LEAN_PATH"] = "/pre/existing"
        try:
            env = safeverify._replay_env(proj)
        finally:
            if prior is None:
                os.environ.pop("LEAN_PATH", None)
            else:
                os.environ["LEAN_PATH"] = prior
        entries = env["LEAN_PATH"].split(os.pathsep)
        check("build lib is first on LEAN_PATH", entries[0] == str(build_lib.resolve()))
        check("inherited LEAN_PATH preserved", "/pre/existing" in entries)


def test_replay_env_skips_missing_build_lib():
    """No build lib (a fresh project, or a non-workspace lake dir) -> LEAN_PATH
    is left exactly as inherited, never pointed at a nonexistent dir."""
    with tempfile.TemporaryDirectory() as d:
        prior = os.environ.get("LEAN_PATH")
        os.environ["LEAN_PATH"] = "/only/this"
        try:
            env = safeverify._replay_env(Path(d))
        finally:
            if prior is None:
                os.environ.pop("LEAN_PATH", None)
            else:
                os.environ["LEAN_PATH"] = prior
        check("LEAN_PATH unchanged when no build lib", env.get("LEAN_PATH") == "/only/this")


# --- mapping: (ok, detail) -> VerifyResult ----------------------------------

def test_passed_maps_to_ok():
    r = _verify_with("theorem t : True := by trivial\n", proof_result=(True, "OK"))
    check("passed -> VerifyResult", isinstance(r, VerifyResult))
    check("passed -> ok", r.status == "ok")
    check("ok detail is None", r.detail is None)


def test_failed_maps_to_rejected():
    r = _verify_with("theorem t : True := by sorry\n", proof_result=(False, "depends on sorryAx"))
    check("failed -> rejected", r.status == "rejected")
    check("rejected carries detail", r.detail == "depends on sorryAx")


def test_grader_exception_maps_to_error():
    r = _verify_with("theorem t : True := by trivial\n", raises=True)
    check("grader raise -> error", r.status == "error")
    check("error detail mentions cause", "boom" in (r.detail or ""))


def test_unavailable():
    r = _verify_with("theorem t : True := by trivial\n", available=False)
    check("binary missing -> unavailable", r.status == "unavailable")


def test_no_theorem_is_error():
    r = _verify_with("import Mathlib\n#check Nat\n", proof_result=(True, "OK"))
    check("no theorem -> error", r.status == "error")
    check("error detail set", r.detail is not None)


# --- opt-in: the real grader -------------------------------------------------

def test_integration_real_binary():
    if os.environ.get("LEA_RUN_SV_INTEGRATION") != "1":
        print("  skip integration (set LEA_RUN_SV_INTEGRATION=1 to run the real grader)")
        return
    if not safeverify.is_available():
        print("  skip integration (SafeVerify binary not built)")
        return
    scratch = safeverify.WORKSPACE / ".sv_scratch"
    scratch.mkdir(parents=True, exist_ok=True)
    good = scratch / "A6Good.lean"
    bad = scratch / "A6Bad.lean"
    good.write_text("import Mathlib\n\ntheorem a6_demo : True := by trivial\n")
    bad.write_text("import Mathlib\n\ntheorem a6_demo : True := by sorry\n")
    try:
        rg = interface.verify(str(good))
        check("integration: honest proof -> ok", rg.status == "ok")
        rb = interface.verify(str(bad))
        check("integration: sorry proof -> rejected", rb.status == "rejected")
    finally:
        good.unlink(missing_ok=True)
        bad.unlink(missing_ok=True)


def test_integration_sibling_import():
    """The LEAN_PATH fix: a project proof that `import`s a sibling lemma must
    audit, not fail 'unknown module prefix Lea'. Needs the sibling olean built in
    the workspace; skips cleanly if it isn't, so the gate stays portable."""
    if os.environ.get("LEA_RUN_SV_INTEGRATION") != "1":
        print("  skip sibling integration (set LEA_RUN_SV_INTEGRATION=1)")
        return
    if not safeverify.is_available():
        print("  skip sibling integration (SafeVerify binary not built)")
        return
    sibling_module = "Lea.RealAnalysis.two_mul_le_sq_add_sq"
    olean = safeverify.WORKSPACE / ".lake" / "build" / "lib" / "lean" / "Lea" / "RealAnalysis" / "two_mul_le_sq_add_sq.olean"
    if not olean.exists():
        print(f"  skip sibling integration (sibling olean not built: {olean})")
        return
    scratch = safeverify.WORKSPACE / ".sv_scratch"
    scratch.mkdir(parents=True, exist_ok=True)
    proof = scratch / "A6Sibling.lean"
    proof.write_text(
        "import Mathlib\n"
        f"import {sibling_module}\n\n"
        "namespace Lea.Misc\n\n"
        "theorem a6_sibling (a b : Real) : 2 * (a * b) <= a ^ 2 + b ^ 2 := by\n"
        "  exact Lea.RealAnalysis.two_mul_le_sq_add_sq a b\n\n"
        "end Lea.Misc\n"
    )
    try:
        r = interface.verify(str(proof))
        check("integration: sibling-importing proof -> ok", r.status == "ok")
    finally:
        proof.unlink(missing_ok=True)


def main():
    print("interface.verify (A6) tests:")
    test_theorem_signature()
    test_namespace_context()
    test_target_reproduces_submission_namespace()
    test_replay_env_adds_workspace_build_lib()
    test_replay_env_skips_missing_build_lib()
    test_passed_maps_to_ok()
    test_failed_maps_to_rejected()
    test_grader_exception_maps_to_error()
    test_unavailable()
    test_no_theorem_is_error()
    test_integration_real_binary()
    test_integration_sibling_import()
    print()
    if _FAILURES:
        print(f"FAILED ({len(_FAILURES)}): {', '.join(_FAILURES)}")
        sys.exit(1)
    print("All interface.verify tests passed.")
    sys.exit(0)


if __name__ == "__main__":
    main()
