import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = path.join(PROJECT_ROOT, ".overleaf-lean-stub");
const SETTINGS_PATH = path.join(APP_DIR, "settings.json");
const ENV_PATH = path.join(PROJECT_ROOT, ".env");
const LEA_REPO_URL = "https://github.com/darturi/lea-prover.git";
const LEA_REPO_BRANCH = "main";
const LEA_REPO_PATH = path.join(PROJECT_ROOT, "vendor", "lea-prover");
const LEA_WORKSPACE_PATH = path.join(LEA_REPO_PATH, "workspace");
const MATHLIB_PACKAGE_PATH = path.join(LEA_WORKSPACE_PATH, ".lake", "packages", "mathlib");
const REFRESH_LEAN_DEPS = process.argv.includes("--refresh-lean-deps");
const DEFAULTS = {
  OPENAI_API_KEY: "your_openai_key_here",
  ANTHROPIC_API_KEY: "your_anthropic_key_here",
  GEMINI_API_KEY: "your_gemini_key_here",
  LEA_API_BASE_URL: "http://127.0.0.1:8000",
  LEA_PROVIDER: "openai",
  LEA_MODEL: "o4-mini",
  LEA_MAX_TURNS: "20",
  LEA_JOB_TIMEOUT_SECONDS: "900"
};

await main();

async function main() {
  console.log("Overleaf Lea Formalizer setup\n");

  await ensureLeaRepo();
  await syncLeaEnvironment();
  await fetchMathlib();
  await writeLocalEnv();
  await writeLocalSettings();

  console.log("\nSetup complete.");
  console.log("Next steps:");
  console.log("1. Put your API key in .env as OPENAI_API_KEY=...");
  console.log("2. Run `npm run doctor`.");
  console.log("3. Run `npm start`.");
  console.log("4. Load the extension/ folder in Chrome.");
}

async function ensureLeaRepo() {
  await fs.mkdir(path.dirname(LEA_REPO_PATH), { recursive: true });

  if (existsSync(path.join(LEA_REPO_PATH, ".git"))) {
    console.log("Updating Lea submodule checkout...");
    await run("git", ["remote", "set-url", "origin", LEA_REPO_URL], { cwd: LEA_REPO_PATH });
    await run("git", ["fetch", "origin", LEA_REPO_BRANCH], { cwd: LEA_REPO_PATH });
    await run("git", ["checkout", LEA_REPO_BRANCH], { cwd: LEA_REPO_PATH });
    await run("git", ["pull", "--ff-only"], { cwd: LEA_REPO_PATH });
    return;
  }

  if (existsSync(LEA_REPO_PATH)) {
    throw new Error(`${LEA_REPO_PATH} exists but is not a git checkout. Move it aside and rerun setup.`);
  }

  console.log("Initializing Lea submodule at vendor/lea-prover...");
  await run("git", ["submodule", "update", "--init", "--recursive", LEA_REPO_PATH], { cwd: PROJECT_ROOT });
}

async function syncLeaEnvironment() {
  console.log("Installing Lea API Python dependencies with uv...");
  await run("uv", ["sync", "--extra", "api"], { cwd: LEA_REPO_PATH });
}

async function fetchMathlib() {
  if (REFRESH_LEAN_DEPS || !existsSync(MATHLIB_PACKAGE_PATH)) {
    console.log("Fetching Lea workspace Mathlib dependencies...");
    await run("lake", ["update"], { cwd: LEA_WORKSPACE_PATH });
  } else {
    console.log("Lea workspace Mathlib dependencies already present; skipping `lake update`.");
    console.log("Run `npm run update-lean-deps` to refresh Lean dependencies.");
  }

  console.log("Fetching Lea workspace Mathlib compiled cache...");
  await run("lake", ["exe", "cache", "get"], { cwd: LEA_WORKSPACE_PATH });
  await verifyMathlibCache();
}

async function verifyMathlibCache() {
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "overleaf-lea-mathlib-"));
  const scratchFile = path.join(scratchDir, "ImportMathlib.lean");

  try {
    await fs.writeFile(scratchFile, "import Mathlib\n\n#check Nat\n", "utf8");
    console.log("Verifying Lea workspace Mathlib compiled cache...");
    await run("lake", ["env", "lean", scratchFile], { cwd: LEA_WORKSPACE_PATH });
  } catch (error) {
    throw new Error(
      `${error.message}\nMathlib is present but the compiled cache is not usable. ` +
      "Run `npm run update-lean-deps` and wait for `lake exe cache get` to finish."
    );
  } finally {
    await fs.rm(scratchDir, { recursive: true, force: true });
  }
}

async function writeLocalEnv() {
  const existing = await readEnvFile(ENV_PATH);
  const merged = { ...DEFAULTS, ...existing };
  merged.LEA_API_BASE_URL = merged.LEA_API_BASE_URL || DEFAULTS.LEA_API_BASE_URL;
  merged.LEA_PROVIDER = merged.LEA_PROVIDER || DEFAULTS.LEA_PROVIDER;
  merged.LEA_MODEL = merged.LEA_MODEL || DEFAULTS.LEA_MODEL;
  merged.LEA_MAX_TURNS = merged.LEA_MAX_TURNS || DEFAULTS.LEA_MAX_TURNS;
  merged.LEA_JOB_TIMEOUT_SECONDS = merged.LEA_JOB_TIMEOUT_SECONDS || DEFAULTS.LEA_JOB_TIMEOUT_SECONDS;

  await fs.writeFile(ENV_PATH, formatEnv(merged), "utf8");
  console.log("Wrote .env path defaults.");
}

async function writeLocalSettings() {
  const settings = await readJson(SETTINGS_PATH, {});
  const next = {
    ...settings,
    leaRepoPath: LEA_REPO_PATH,
    leaWorkspacePath: LEA_WORKSPACE_PATH,
    leaApiBaseUrl: settings.leaApiBaseUrl || DEFAULTS.LEA_API_BASE_URL,
    leaProvider: settings.leaProvider || DEFAULTS.LEA_PROVIDER,
    leaModel: settings.leaModel || DEFAULTS.LEA_MODEL,
    leaMaxTurns: settings.leaMaxTurns || Number(DEFAULTS.LEA_MAX_TURNS),
    leaJobTimeoutSeconds: settings.leaJobTimeoutSeconds || Number(DEFAULTS.LEA_JOB_TIMEOUT_SECONDS)
  };

  await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await fs.writeFile(SETTINGS_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  console.log("Wrote companion settings.");
}

function run(command, args, { cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: process.env
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
    });
  });
}

async function readEnvFile(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const values = {};
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const equals = trimmed.indexOf("=");
      if (equals === -1) continue;
      const key = trimmed.slice(0, equals).trim();
      const value = trimmed.slice(equals + 1).trim();
      if (key) values[key] = value;
    }
    return values;
  } catch (error) {
    if (error && error.code === "ENOENT") return {};
    throw error;
  }
}

function formatEnv(values) {
  const lines = [
    ["OPENAI_API_KEY", values.OPENAI_API_KEY || DEFAULTS.OPENAI_API_KEY],
    ["LEA_API_BASE_URL", values.LEA_API_BASE_URL],
    ["LEA_PROVIDER", values.LEA_PROVIDER],
    ["LEA_MODEL", values.LEA_MODEL],
    ["LEA_MAX_TURNS", values.LEA_MAX_TURNS],
    ["LEA_JOB_TIMEOUT_SECONDS", values.LEA_JOB_TIMEOUT_SECONDS]
  ];
  return `${lines.map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return fallback;
    throw error;
  }
}
