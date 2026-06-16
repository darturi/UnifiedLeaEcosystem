import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

const resetScripts = [
  {
    label: "Lea UI SQLite database and Lean workspace state",
    script: path.join(root, "apps", "lea-ui", "scripts", "reset-local-state.mjs")
  },
  {
    label: "Overleaf companion jobs, cache, backups, and LaTeX context",
    script: path.join(root, "apps", "overleaf-extension", "companion", "reset-local-state.mjs")
  }
];

for (const { label, script } of resetScripts) {
  console.log(`[reset] ${label}`);
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    stdio: "inherit"
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log(`[reset] Ecosystem local state ${dryRun ? "dry run" : "reset"} complete.`);
