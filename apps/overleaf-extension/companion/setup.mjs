import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const monorepoRoot = path.resolve(projectRoot, "../..");
const rootSetup = path.join(monorepoRoot, "scripts", "setup.mjs");
const args = ["--target", "overleaf", ...process.argv.slice(2)];

const result = spawnSync(process.execPath, [rootSetup, ...args], {
  cwd: monorepoRoot,
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
