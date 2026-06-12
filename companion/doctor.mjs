import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyEnvDefaults, loadDotEnv } from "./config.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SETTINGS_PATH = path.join(PROJECT_ROOT, ".overleaf-lean-stub", "settings.json");

const dotenv = loadDotEnv(PROJECT_ROOT);
const settings = applyEnvDefaults(readJson(SETTINGS_PATH, {}));
const checks = [];

checkCommand("node", ["--version"]);
checkCommand("git", ["--version"]);
checkCommand("uv", ["--version"]);
checkCommand("lean", ["--version"]);
checkCommand("lake", ["--version"]);

checkEnv("OPENAI_API_KEY");
checkPath("Lean workspace", settings.workspacePath || PROJECT_ROOT, (dir) => (
  fs.existsSync(path.join(dir, "lean-toolchain")) &&
  (fs.existsSync(path.join(dir, "lakefile.lean")) || fs.existsSync(path.join(dir, "lakefile.toml")))
), "must contain lean-toolchain and lakefile.lean or lakefile.toml");
checkMathlib(settings.workspacePath || PROJECT_ROOT);
checkPath("Lea repo", settings.leaRepoPath, (dir) => (
  fs.existsSync(path.join(dir, "pyproject.toml")) &&
  fs.existsSync(path.join(dir, "lea_api"))
), "must point at the Lea API-enabled lea-prover checkout");
checkPath("Lea API virtualenv", settings.leaRepoPath ? path.join(settings.leaRepoPath, ".venv", "bin", "python") : "", () => true, "run `npm run setup:api`");
checkUrl("Lea API URL", settings.leaApiBaseUrl || "http://127.0.0.1:8000");

console.log("Overleaf Lea Formalizer doctor\n");
console.log(`${dotenv.loaded ? "✓" : "•"} .env ${dotenv.loaded ? `loaded from ${dotenv.path}` : "not found; using shell/settings only"}`);
for (const check of checks) {
  console.log(`${check.ok ? "✓" : "✗"} ${check.label}${check.detail ? `: ${check.detail}` : ""}`);
}

const failed = checks.filter((check) => !check.ok);
if (failed.length > 0) {
  console.log("\nFix the failed checks above, then run `npm run doctor` again.");
  process.exitCode = 1;
} else {
  console.log("\nAll checks passed. Start with `npm start`.");
}

function checkCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  checks.push({
    ok: result.status === 0,
    label: `${command} available`,
    detail: result.status === 0
      ? firstLine(result.stdout || result.stderr)
      : "not found on PATH"
  });
}

function checkEnv(name) {
  checks.push({
    ok: Boolean(process.env[name]),
    label: `${name} set`,
    detail: process.env[name] ? "present" : "missing"
  });
}

function checkPath(label, value, predicate, requirement) {
  const ok = Boolean(value) && path.isAbsolute(value) && fs.existsSync(value) && predicate(value);
  checks.push({
    ok,
    label,
    detail: ok ? value : `${value || "unset"} (${requirement})`
  });
}

function checkUrl(label, value) {
  let ok = false;
  try {
    const parsed = new URL(value);
    ok = ["http:", "https:"].includes(parsed.protocol);
  } catch {
    ok = false;
  }
  checks.push({
    ok,
    label,
    detail: ok ? value : `${value || "unset"} (must be absolute http(s) URL)`
  });
}

function checkMathlib(workspacePath) {
  const workspace = workspacePath || PROJECT_ROOT;
  const lakefilePath = path.join(workspace, "lakefile.lean");
  const manifestPath = path.join(workspace, "lake-manifest.json");
  const mathlibPackagePath = path.join(workspace, ".lake", "packages", "mathlib");
  const lakefile = readText(lakefilePath);
  const manifest = readText(manifestPath);
  const configured = /require\s+mathlib\b/.test(lakefile) || /"name"\s*:\s*"mathlib"/.test(manifest);
  const fetched = fs.existsSync(mathlibPackagePath);

  checks.push({
    ok: configured,
    label: "Mathlib dependency configured",
    detail: configured ? "require mathlib found" : "add `require mathlib` to lakefile.lean"
  });
  checks.push({
    ok: fetched,
    label: "Mathlib package fetched",
    detail: fetched ? mathlibPackagePath : "run `lake update` and `lake exe cache get`"
  });
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function firstLine(text) {
  return String(text).trim().split(/\r?\n/)[0] || "ok";
}
