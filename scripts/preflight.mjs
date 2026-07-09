import { spawnSync } from "node:child_process";

// Preflight prerequisite check.
//
// `npm run setup` shells out to `uv`, `elan`/`lake`, and needs a recent Node —
// none of which it installs. Without this check a missing toolchain surfaces as a
// cryptic mid-run failure ("uv: command not found") deep inside setup-api.mjs.
// Run this FIRST so a missing prerequisite prints an actionable install hint and
// stops before anything else runs.
//
// Runnable standalone (`node scripts/preflight.mjs`) or imported by setup.mjs.

const REQUIRED_NODE_MAJOR = 22; // matches .nvmrc; we accept >=20 but nudge to 22.
const MIN_NODE_MAJOR = 20;

const CHECKS = [
  {
    name: "Node.js",
    detect: () => {
      const major = Number(process.versions.node.split(".")[0]);
      if (major >= MIN_NODE_MAJOR) {
        const note = major === REQUIRED_NODE_MAJOR ? "" : ` (v${process.versions.node}; ${REQUIRED_NODE_MAJOR} LTS recommended — see .nvmrc)`;
        return { ok: true, detail: `v${process.versions.node}${note}` };
      }
      return { ok: false, detail: `v${process.versions.node} is too old` };
    },
    hint: [
      `Node ${MIN_NODE_MAJOR}+ is required (${REQUIRED_NODE_MAJOR} LTS recommended).`,
      "  Install via nvm:  nvm install && nvm use   (uses .nvmrc)",
      "  Or download:      https://nodejs.org/en/download",
    ],
  },
  {
    name: "git",
    detect: () => versionOf("git", ["--version"]),
    hint: [
      "git is required (lake fetches Mathlib over git).",
      "  macOS:  xcode-select --install",
      "  Linux:  sudo apt-get install -y git",
    ],
  },
  {
    name: "uv",
    detect: () => versionOf("uv", ["--version"]),
    hint: [
      "uv (Python env manager) is required to build the adapter + prover venvs.",
      "  curl -LsSf https://astral.sh/uv/install.sh | sh",
      "  then restart your shell (or source your profile) so `uv` is on PATH.",
    ],
  },
  {
    name: "elan / lake",
    detect: () => {
      // lake is the entrypoint we actually call; elan provides it. Check lake.
      const lake = versionOf("lake", ["--version"]);
      if (lake.ok) return lake;
      return { ok: false, detail: "lake not found (Lean toolchain missing)" };
    },
    hint: [
      "The Lean toolchain (elan, which provides `lake`) is required.",
      "  curl -fsSL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh | sh -s -- -y",
      "  then restart your shell so `lake` is on PATH.",
    ],
  },
];

export function preflight({ exitOnFailure = true } = {}) {
  console.log("Checking prerequisites...\n");
  const missing = [];

  for (const check of CHECKS) {
    let result;
    try {
      result = check.detect();
    } catch (error) {
      result = { ok: false, detail: error?.message || String(error) };
    }
    const marker = result.ok ? "OK  " : "MISS";
    console.log(`  [${marker}] ${check.name}${result.detail ? ` - ${result.detail}` : ""}`);
    if (!result.ok) missing.push(check);
  }

  if (missing.length === 0) {
    console.log("\nAll prerequisites present.\n");
    return true;
  }

  console.error(`\nMissing ${missing.length} prerequisite(s). Install these, then re-run setup:\n`);
  for (const check of missing) {
    console.error(`- ${check.name}`);
    for (const line of check.hint) console.error(`  ${line}`);
    console.error("");
  }
  console.error("Prefer a one-shot bootstrap? Run ./install.sh from the repo root.\n");

  if (exitOnFailure) process.exit(1);
  return false;
}

function versionOf(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return { ok: false, detail: result.error?.code === "ENOENT" ? "not found on PATH" : (result.stderr?.trim() || "not runnable") };
  }
  const line = (result.stdout || result.stderr || "").split(/\r?\n/)[0].trim();
  return { ok: true, detail: line };
}

// Allow `node scripts/preflight.mjs` as a standalone check.
if (import.meta.url === `file://${process.argv[1]}`) {
  preflight({ exitOnFailure: true });
}
