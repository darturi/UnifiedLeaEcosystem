"""Smoke-test the LSP daemon path through lea.tools.lean_check.

Tests both project-tree files (Main.lean) AND off-tree eval_proofs/ files
(which is what the agent actually writes during evals).
"""
import os, time
from pathlib import Path
from lea.tools import lean_check

REPO = "/scratch/spp9399/lean/lea-prover-og/lea-prover"
A = f"{REPO}/FormalQualBench/FormalQualBench/BanachStoneTheorem/Main.lean"
B = f"{REPO}/FormalQualBench/FormalQualBench/GreenTaoTheorem/Main.lean"

# Simulate the agent writing a proof to eval_proofs/, then iterating
EVAL_DIR = Path(REPO) / "FormalQualBench" / "eval_proofs"
EVAL_DIR.mkdir(parents=True, exist_ok=True)
EVAL_FILE = EVAL_DIR / "_verify_BanachStone.lean"
EVAL_FILE.write_text(
    "import Mathlib.Topology.ContinuousMap.Algebra\n"
    "import Mathlib.Topology.ContinuousMap.Compact\n"
    "import Mathlib.Analysis.Normed.Operator.LinearIsometry\n"
    "\n"
    "namespace BanachStoneTheorem\n"
    "\n"
    "theorem MainTheorem (X Y : Type*) [TopologicalSpace X] [CompactSpace X] [T2Space X]\n"
    "    [TopologicalSpace Y] [CompactSpace Y] [T2Space Y]\n"
    "    (e : C(X, ℝ) ≃ₗᵢ[ℝ] C(Y, ℝ)) :\n"
    "    Nonempty (X ≃ₜ Y) := by\n"
    "  sorry\n"
    "\n"
    "end BanachStoneTheorem\n"
)

CASES = [
    ("1: cold spawn + first didOpen on Main.lean", A),
    ("2: warm didChange on same Main.lean",        A),
    ("3: didOpen on different Main.lean",          B),
    ("4: didOpen on eval_proofs/_verify_BanachStone.lean (off-tree path)", str(EVAL_FILE)),
    ("5: didChange on same eval_proofs file",      str(EVAL_FILE)),
]

print(f"LEA_DISABLE_LSP={os.environ.get('LEA_DISABLE_LSP', '(unset)')}", flush=True)
print(f"LEAN_CHECK_TIMEOUT={os.environ.get('LEAN_CHECK_TIMEOUT', '(default 900)')}", flush=True)
print()

for label, path in CASES:
    print(f"=== {label} ===", flush=True)
    t = time.time()
    out = lean_check(path)
    elapsed = time.time() - t
    print(f"  wall={elapsed:.2f}s", flush=True)
    snippet = out if len(out) < 200 else out[:200] + "..."
    print(f"  output: {snippet}", flush=True)
    print()
