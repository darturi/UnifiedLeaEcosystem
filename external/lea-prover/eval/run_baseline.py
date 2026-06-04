"""Non-agentic FQB baseline — single API call per attempt, no tools, no loop.

Asks each model once for a full Lean proof, writes it, verifies with `lake env lean`.
Best-of-N sampling with early stop.

Usage:
    uv run python -m eval.run_baseline --models gemini-3.1-pro-preview
    uv run python -m eval.run_baseline \\
        --models gemini-3.1-pro-preview claude-opus-4-7 gpt-5.4-pro-2026-03-05 \\
        --n 5
    uv run python -m eval.run_baseline --models gemini-3.1-pro-preview \\
        --problems DeBruijnErdos JordanDerangementTheorem  # subset for speed
"""

import argparse
import json
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

from lea.providers import stream, TextDelta, Done

REPO_ROOT = Path(__file__).resolve().parent.parent
FQB_DIR = REPO_ROOT / "FormalQualBench"
PROBLEMS_DIR = FQB_DIR / "FormalQualBench"
RESULTS_DIR = REPO_ROOT / "eval" / "results"

BANNED = ["sorry", "axiom ", "native_decide", "exact?", "apply?", "simp?", "decide?"]

SYSTEM_PROMPT = (
    "You are an expert Lean 4 theorem prover. Given a theorem statement, "
    "produce a complete proof.\n\n"
    "Requirements:\n"
    "- Return ONE self-contained Lean 4 file (include `import Mathlib` if needed)\n"
    "- No `sorry`, no `axiom`, no tactic queries (`exact?`, `apply?`, `simp?`, `decide?`)\n"
    "- Must compile under `lake env lean` with Mathlib v4.29.0\n\n"
    "Respond with just the Lean file inside a ```lean code block. No commentary."
)

USER_TEMPLATE = (
    "Prove this theorem:\n\n```lean\n{statement}\n```"
)


def extract_lean(resp: str) -> str:
    m = re.search(r"```lean\s*\n(.*?)```", resp, re.DOTALL)
    if m:
        return m.group(1).rstrip()
    m = re.search(r"```\s*\n(.*?)```", resp, re.DOTALL)
    if m:
        return m.group(1).rstrip()
    return resp.strip()


def query_model(model: str, statement: str) -> tuple[str, dict]:
    messages = [{"role": "user", "content": USER_TEMPLATE.format(statement=statement)}]
    parts, usage = [], {}
    for ev in stream(model, SYSTEM_PROMPT, messages, tools=[]):
        if isinstance(ev, TextDelta):
            parts.append(ev.text)
        elif isinstance(ev, Done):
            usage = {"input_tokens": ev.usage.input_tokens, "output_tokens": ev.usage.output_tokens}
    return "".join(parts), usage


def verify(path: Path) -> tuple[bool, str]:
    if not path.exists():
        return False, "no file"
    content = path.read_text()
    for b in BANNED:
        if b in content:
            return False, f"banned: {b!r}"
    try:
        r = subprocess.run(
            ["lake", "env", "lean", str(path)],
            capture_output=True, text=True, timeout=600, cwd=str(FQB_DIR),
        )
        out = (r.stdout + r.stderr).strip()
        if r.returncode != 0 or "error" in out.lower():
            return False, out[:400] or f"exit {r.returncode}"
        return True, "OK"
    except subprocess.TimeoutExpired:
        return False, "lake timeout (600s)"


def read_problem(pdir: Path) -> tuple[str, str]:
    text = (pdir / "Main.lean").read_text()
    stmt = text.replace(":= by\n  sorry", "").replace(":= by sorry", "").strip()
    return pdir.name, stmt


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--models", nargs="+", required=True)
    p.add_argument("--n", type=int, default=5)
    p.add_argument("--problems", nargs="+", default=None)
    args = p.parse_args()

    all_probs = sorted(
        d for d in PROBLEMS_DIR.iterdir()
        if d.is_dir() and (d / "Main.lean").exists()
    )
    if args.problems:
        want = set(args.problems)
        all_probs = [d for d in all_probs if d.name in want]

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    results_path = RESULTS_DIR / f"baseline_{ts}.json"
    all_results = {}

    for model in args.models:
        safe = re.sub(r"[^a-zA-Z0-9_-]", "_", model)
        proof_dir = FQB_DIR / f"eval_proofs_baseline_{safe}_{ts}"
        proof_dir.mkdir(parents=True, exist_ok=True)
        model_results = {}
        for pdir in all_probs:
            name, stmt = read_problem(pdir)
            attempts = []
            for i in range(1, args.n + 1):
                print(f"[{model}] [{name}] attempt {i}/{args.n}", flush=True)
                start = time.time()
                try:
                    resp, usage = query_model(model, stmt)
                except Exception as e:
                    attempts.append({
                        "attempt": i, "success": False,
                        "error": f"{type(e).__name__}: {e}",
                        "time_s": round(time.time() - start, 1),
                    })
                    print(f"  ERROR {type(e).__name__}: {e}", flush=True)
                    continue
                code = extract_lean(resp)
                path = proof_dir / f"{name}_attempt{i}.lean"
                path.write_text(code)
                ok, detail = verify(path)
                attempts.append({
                    "attempt": i, "success": ok,
                    "time_s": round(time.time() - start, 1),
                    "usage": usage, "detail": detail[:300],
                })
                print(f"  {'PASS' if ok else 'FAIL'} ({attempts[-1]['time_s']}s) {detail[:80]}", flush=True)
                if ok:
                    break
            model_results[name] = {
                "attempts": attempts,
                "solved": any(a.get("success") for a in attempts),
            }
            # Incremental save after each problem
            all_results[model] = model_results
            results_path.write_text(json.dumps(
                {"models": args.models, "n": args.n, "results": all_results}, indent=2,
            ))
        solved = sum(1 for r in model_results.values() if r["solved"])
        total_cost = 0.0
        try:
            from lea.agent import MODEL_PRICING, DEFAULT_PRICING
            ip, op = MODEL_PRICING.get(model, DEFAULT_PRICING)
            for r in model_results.values():
                for a in r["attempts"]:
                    u = a.get("usage", {})
                    total_cost += (u.get("input_tokens", 0) * ip + u.get("output_tokens", 0) * op) / 1e6
        except Exception:
            pass
        print(f"\n=== {model}: {solved}/{len(all_probs)} solved (~${total_cost:.2f}) ===\n", flush=True)

    print(f"Results saved to {results_path}")


if __name__ == "__main__":
    main()
