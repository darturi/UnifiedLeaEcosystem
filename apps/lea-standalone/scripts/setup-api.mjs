import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();

function fail(message) {
  console.error(`\n[setup] ${message}`);
  process.exit(1);
}

function ensure(pathname, message) {
  if (!existsSync(path.join(root, pathname))) {
    fail(message);
  }
}

function run(label, args, cwd) {
  console.log(`[setup] ${label}`);
  const result = spawnSync(args[0], args.slice(1), {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    fail(`${label} failed with exit code ${result.status ?? "unknown"}.`);
  }
}

ensure(
  "prover/pyproject.toml",
  "prover/ is missing — this is a broken checkout.",
);

// The adapter venv runs the app: `uv sync` here builds the vendored prover
// (lea-prover) as an editable path dep and installs its deps too (D1).
run("Installing UI adapter dependencies (incl. the in-process prover)", ["uv", "sync"], path.join(root, "adapter"));
// The prover's own venv is only needed to run the prover's standalone test suite.
run("Installing prover dependencies (for prover tests)", ["uv", "sync"], path.join(root, "prover"));
run("Downloading Lean workspace cache", ["lake", "exe", "cache", "get"], path.join(root, "prover", "workspace"));
ensure(
  "prover/workspace/.lake/packages/mathlib/.lake/build/lib/lean/Mathlib.olean",
  "Lean Mathlib cache is missing after cache download.",
);

console.log("[setup] Done.");
