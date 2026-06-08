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
  "external/lea-prover/pyproject.toml",
  "external/lea-prover is missing. Run git submodule update --init --recursive.",
);

run("Installing UI adapter dependencies", ["uv", "sync"], path.join(root, "server"));
run("Installing bundled Lea API dependencies", ["uv", "sync", "--extra", "api"], path.join(root, "external", "lea-prover"));
run("Downloading Lean workspace cache", ["lake", "exe", "cache", "get"], path.join(root, "external", "lea-prover", "workspace"));
run("Building Lean workspace", ["lake", "build"], path.join(root, "external", "lea-prover", "workspace"));

console.log("[setup] Done.");
