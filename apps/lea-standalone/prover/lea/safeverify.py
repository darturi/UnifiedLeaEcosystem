"""SafeVerify integration — kernel-level audit of a finished proof.

Plain `lean_check` only confirms a file *compiles*. SafeVerify additionally
replays the proof through the Lean kernel and checks it depends only on the
whitelisted axioms — catching `sorry`, `axiom`/`opaque` smuggling,
`native_decide`, `local notation` shadows, `abbrev` redefinitions, and
`partial`/`unsafe` tricks that a plain compile lets through.

It is *comparison-style*: it checks a *submission* file against a *target*
signature. `interface.verify(path)` derives the target from the proof's own main
theorem (header + `:= by sorry`), so the check is universal — it catches a
tampered *proof*. (Catching a tampered *statement* would need a separately
trusted target; a later follow-up.)

This is the low-level subsystem (parallels `lsp_daemon.py`): it returns plain
`(ok, detail)` tuples and knows nothing about the typed events — `interface.py`
maps the result to a `VerifyResult`. Recovered from the prover's former
`eval/utils/verify.py` (the eval harnesses moved to the separate Lea+eval repo).

The SafeVerify binary must be pre-built (`lake build` in
`third_party/SafeVerify`, pinned to the workspace's Lean toolchain). If it is
absent, `is_available()` returns False and callers degrade gracefully.

Known limitation: SafeVerify compares declaration types syntactically, not up to
alpha-renaming of universe parameters or instance hygiene names. This wrapper
detects and accepts that specific false-positive class (`_universe_alpha_equiv`).
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

PROVER_ROOT = Path(__file__).resolve().parent.parent
SAFE_VERIFY_DIR = PROVER_ROOT / "third_party" / "SafeVerify"
WORKSPACE = PROVER_ROOT / "workspace"


# --- availability -----------------------------------------------------------

def safe_verify_binary() -> Path | None:
    """The pre-built SafeVerify executable, or None if it hasn't been built."""
    binary = SAFE_VERIFY_DIR / ".lake" / "build" / "bin" / "safe_verify"
    return binary if binary.exists() else None


def is_available() -> bool:
    """True iff the SafeVerify binary is built and ready to run."""
    return safe_verify_binary() is not None


# --- target derivation ------------------------------------------------------

# A top-level `theorem`/`lemma` signature: from the keyword up to the proof body
# `:=`. Theorem *types* don't contain `:=`, so the first one is the body delimiter.
_THEOREM_RE = re.compile(
    r"(?ms)^\s*(?:@\[[^\]]*\]\s*)?(?:theorem|lemma)\s+[A-Za-z_][\w']*.*?:=",
)


def theorem_signature(code: str) -> str | None:
    """The proof's main theorem signature (last top-level theorem/lemma), with
    the proof body stripped — i.e. everything up to but excluding `:=`."""
    matches = list(_THEOREM_RE.finditer(code))
    if not matches:
        return None
    decl = matches[-1].group(0)
    # `.strip()` (not just rstrip): the `^\s*` in the regex can swallow the
    # newline before the keyword, leaving a leading blank.
    return decl[: decl.rfind(":=")].strip()


# A `namespace X` / `namespace X.Y` opener (its own line). The matching `end X`
# closes it. Interactive proofs are wrapped in `namespace Lea.Misc`, so the
# theorem's real name is `Lea.Misc.<name>`.
_NAMESPACE_RE = re.compile(r"(?m)^[ \t]*namespace[ \t]+([\w.]+)[ \t]*$")


def namespace_context(code: str) -> tuple[str, str]:
    """The `namespace …` wrapper(s) around the proof, as ``(open_block, close_block)``.

    A target built from the bare signature must land in the SAME namespace, or its
    fully-qualified declaration name won't match the submission and SafeVerify
    reports ``declaration not found in submission``. Returns ``("", "")`` for a
    top-level proof. Nested namespaces are reproduced outermost-first and closed in
    reverse, mirroring how the submission opened them.
    """
    names = _NAMESPACE_RE.findall(code)
    if not names:
        return "", ""
    open_block = "".join(f"namespace {n}\n" for n in names) + "\n"
    close_block = "\n" + "".join(f"end {n}\n" for n in reversed(names))
    return open_block, close_block


# --- the grader (recovered from eval/utils/verify.py) -----------------------

_UNIV_RE = re.compile(r"\bu_\d+\b")
_HYG_RE = re.compile(r"inst\._@\.[\w.\-]+\._hygCtx\._hyg\.\d+")


def _normalize_for_alpha(s: str) -> str:
    """Canonicalize universe-param names and instance hygiene names so two
    types that differ only in those auto-generated identifiers compare equal."""
    seen_u: dict[str, str] = {}

    def _u(m: re.Match) -> str:
        name = m.group(0)
        if name not in seen_u:
            seen_u[name] = f"u_X{len(seen_u)}"
        return seen_u[name]

    seen_h: dict[str, str] = {}

    def _h(m: re.Match) -> str:
        name = m.group(0)
        if name not in seen_h:
            seen_h[name] = f"inst._@.HYG_{len(seen_h)}"
        return seen_h[name]

    s = _UNIV_RE.sub(_u, s)
    s = _HYG_RE.sub(_h, s)
    return s


def _universe_alpha_equiv(safe_verify_output: str) -> bool:
    """Return True iff SafeVerify's failure is a universe/hygiene-only false
    positive — i.e. the Expected and Got types are alpha-equivalent after
    canonicalizing universe parameter names and instance hygiene names. Anything
    else (real shadows, axiom additions, structural mismatches) falls through to
    a normal FAIL."""
    m = re.search(
        r"Expected type:\s*(.*?)\s*Got type:\s*(.*?)(?:\s*Expected level params|\s*-{3,}|\Z)",
        safe_verify_output, re.DOTALL,
    )
    if not m:
        return False
    expected = _normalize_for_alpha(m.group(1).strip())
    got = _normalize_for_alpha(m.group(2).strip())
    return expected == got


def _replay_env(lake_project: Path) -> dict[str, str]:
    """Subprocess env for the `lake exe safe_verify` replay, with the main
    workspace's compiled `Lea.*` oleans added to `LEAN_PATH`.

    The replay runs under SafeVerify's own Lake project, whose search path knows
    only its packages + Mathlib — not the workspace where project proofs live. A
    submission that `import`s a sibling lemma (`import Lea.<Project>.Foo`) would
    otherwise fail with `unknown module prefix 'Lea'`. `lake exe` preserves and
    appends to an inherited `LEAN_PATH`, so prepending the workspace build lib
    lets the kernel resolve those oleans without disturbing Mathlib resolution
    (the build lib holds only `Lea/*`). Mathlib-only proofs are unaffected — the
    extra entry is consulted only when an earlier one doesn't satisfy the import.

    The sibling olean must already be built; the gating submission-compile step
    (`lake env lean`, which sees the same build lib) enforces this — a missing
    sibling fails there first with a clear `Submission compile failed`.
    """
    env = dict(os.environ)
    build_lib = lake_project / ".lake" / "build" / "lib" / "lean"
    if build_lib.is_dir():
        existing = env.get("LEAN_PATH")
        env["LEAN_PATH"] = str(build_lib.resolve()) + (os.pathsep + existing if existing else "")
    return env


def _compile_to_olean(source: Path, out: Path, lake_project: Path, timeout: int) -> tuple[bool, str]:
    try:
        result = subprocess.run(
            ["lake", "env", "lean", "-o", str(out.resolve()), str(source.resolve())],
            capture_output=True, text=True, timeout=timeout,
            cwd=str(lake_project),
        )
    except subprocess.TimeoutExpired:
        return False, f"Compilation timed out ({timeout}s)"
    output = (result.stdout + "\n" + result.stderr).strip()
    if result.returncode != 0 or not out.exists():
        return False, output if output else f"Exit code {result.returncode}"
    return True, output


def verify_proof(
    target_src: Path,
    submission_src: Path,
    lake_project: Path,
    scratch_dir: Path | None = None,
    compile_timeout: int = 600,
    safe_verify_timeout: int = 600,
) -> tuple[bool, str]:
    """Verify `submission_src` against `target_src` using SafeVerify.

    `lake_project` is the Lake project (with Mathlib) that both files compile in.
    `scratch_dir` defaults to `<lake_project>/.sv_scratch/`. Returns
    `(success, detail)`. Cleans up scratch oleans on exit.
    """
    if not submission_src.exists():
        return False, "Proof file not found"
    if not target_src.exists():
        return False, f"Target file not found: {target_src}"

    scratch = scratch_dir or (lake_project / ".sv_scratch")
    scratch.mkdir(parents=True, exist_ok=True)
    stem = submission_src.stem
    target_olean = scratch / f"{stem}_target.olean"
    submission_olean = scratch / f"{stem}_submission.olean"
    report_path = scratch / f"{stem}_report.json"

    try:
        ok, out = _compile_to_olean(target_src, target_olean, lake_project, compile_timeout)
        if not ok:
            return False, f"Target compile failed: {out}"

        ok, out = _compile_to_olean(submission_src, submission_olean, lake_project, compile_timeout)
        if not ok:
            return False, f"Submission compile failed: {out}"

        try:
            result = subprocess.run(
                ["lake", "exe", "safe_verify", "-v",
                 str(target_olean.resolve()), str(submission_olean.resolve()),
                 "--disallow-partial", "-s", str(report_path.resolve())],
                capture_output=True, text=True, timeout=safe_verify_timeout,
                cwd=str(SAFE_VERIFY_DIR), env=_replay_env(lake_project),
            )
        except subprocess.TimeoutExpired:
            return False, f"SafeVerify timed out ({safe_verify_timeout}s)"

        output = (result.stdout + "\n" + result.stderr).strip()
        if result.returncode == 0:
            return True, "OK (SafeVerify passed)"
        if "theorem type mismatch" in output and _universe_alpha_equiv(output):
            return True, "OK (SafeVerify rejected on universe/hygiene-only naming difference; types alpha-equivalent)"
        return False, output if output else f"SafeVerify exit code {result.returncode}"
    finally:
        for p in (target_olean, submission_olean, report_path):
            p.unlink(missing_ok=True)
