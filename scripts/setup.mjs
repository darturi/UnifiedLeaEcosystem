import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MONOREPO_ROOT, ROOT_ENV_PATH, patchEnvFile, readDotEnv } from "./env.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OVERLEAF_ROOT = path.join(MONOREPO_ROOT, "apps", "overleaf-extension");
const UI_ROOT = path.join(MONOREPO_ROOT, "apps", "lea-ui");
const UI_SERVER_ROOT = path.join(UI_ROOT, "server");
const ENV_EXAMPLE_PATH = path.join(MONOREPO_ROOT, ".env.example");
const OVERLEAF_SETTINGS_PATH = path.join(OVERLEAF_ROOT, ".overleaf-lean-stub", "settings.json");
const ROOT_ENV = readDotEnv(ROOT_ENV_PATH);
const LEA_ROOT = resolveMonorepoPath(process.env.LEA_ROOT || ROOT_ENV.LEA_ROOT || "vendor/lea-prover");
const LEA_WORKSPACE = path.join(LEA_ROOT, "workspace");
const MATHLIB_PACKAGE_PATH = path.join(LEA_WORKSPACE, ".lake", "packages", "mathlib");
const MATHLIB_OLEAN_PATH = path.join(MATHLIB_PACKAGE_PATH, ".lake", "build", "lib", "lean", "Mathlib.olean");
const VALID_TARGETS = new Set(["all", "ui", "overleaf"]);
const DEFAULT_ENV = {
  LEA_ROOT: "vendor/lea-prover",
  LEA_API_BASE_URL: "http://127.0.0.1:8000",
  LEA_UI_API_BASE_URL: "http://127.0.0.1:8001",
  OVERLEAF_COMPANION_URL: "http://127.0.0.1:31245",
  LEA_PROVIDER: "openai",
  LEA_MODEL: "o4-mini",
  LEA_MAX_TURNS: "20",
  LEA_JOB_TIMEOUT_SECONDS: "900",
  LEA_THEOREM_TRANSLATION_MAX_RETRIES: "3",
  LEA_PERMISSION_TIER: "theorem_translation",
  LEA_NARRATE_TOOL_STEPS: "true",
};
const DEFAULT_OVERLEAF_LATEX_CONTEXT_MODE = "off";

const options = parseArgs(process.argv.slice(2));

await main();

async function main() {
  console.log(`Lea ecosystem setup (${options.target})\n`);

  await installNodeDependencies();
  await ensureLeaRepo();
  await writeRootEnv();
  await syncLeaApiEnvironment();
  await fetchMathlib();

  if (options.target === "all" || options.target === "ui") {
    await syncUiEnvironment();
  }

  if (options.target === "all" || options.target === "overleaf") {
    await writeOverleafSettings();
  }

  console.log("\nSetup complete.");
  console.log("Next steps:");
  console.log("1. Put your provider API key in the monorepo root .env.");
  console.log("2. Run `npm run doctor` from the monorepo root.");
  console.log("3. Start the app you need with `npm run dev:ui` or `npm run dev:overleaf`.");
}

async function installNodeDependencies() {
  console.log("Installing monorepo Node dependencies...");
  await run("npm", ["install"], { cwd: MONOREPO_ROOT });
}

async function ensureLeaRepo() {
  await fs.mkdir(path.dirname(LEA_ROOT), { recursive: true });
  const defaultLeaRoot = path.join(MONOREPO_ROOT, "vendor", "lea-prover");
  const isDefaultLeaRoot = path.resolve(LEA_ROOT) === defaultLeaRoot;

  if (existsSync(path.join(LEA_ROOT, ".git"))) {
    if (!isDefaultLeaRoot) {
      console.log(`Using existing Lea checkout at ${LEA_ROOT}.`);
      return;
    }
    console.log("Updating Lea submodule to the commit pinned by this checkout...");
    await run("git", ["submodule", "sync", "--recursive", relativeToMonorepo(LEA_ROOT)], { cwd: MONOREPO_ROOT });
    await run("git", ["submodule", "update", "--init", "--recursive", relativeToMonorepo(LEA_ROOT)], { cwd: MONOREPO_ROOT });
    return;
  }

  if (existsSync(LEA_ROOT)) {
    throw new Error(`${LEA_ROOT} exists but is not a git checkout. Move it aside and rerun setup.`);
  }
  if (!isDefaultLeaRoot) {
    throw new Error(`${LEA_ROOT} does not exist. Create that Lea checkout or unset LEA_ROOT to use vendor/lea-prover.`);
  }

  console.log(`Initializing Lea submodule at ${relativeToMonorepo(LEA_ROOT)}...`);
  await run("git", ["submodule", "update", "--init", "--recursive", relativeToMonorepo(LEA_ROOT)], { cwd: MONOREPO_ROOT });
}

async function writeRootEnv() {
  if (!existsSync(ROOT_ENV_PATH) && existsSync(ENV_EXAMPLE_PATH)) {
    await fs.copyFile(ENV_EXAMPLE_PATH, ROOT_ENV_PATH);
    console.log("Created root .env from .env.example.");
  }

  const existing = await readEnvFile(ROOT_ENV_PATH);
  const patch = {};

  for (const [key, value] of Object.entries(DEFAULT_ENV)) {
    patch[key] = existing[key] || value;
  }

  await patchEnvFile(ROOT_ENV_PATH, patch);
  console.log(`Wrote root .env defaults at ${path.relative(MONOREPO_ROOT, ROOT_ENV_PATH)}.`);
}

async function syncLeaApiEnvironment() {
  console.log("Installing bundled Lea API Python dependencies with uv...");
  await run("uv", ["sync", "--extra", "api"], { cwd: LEA_ROOT });
}

async function syncUiEnvironment() {
  console.log("Installing UI adapter dependencies with uv...");
  await run("uv", ["sync"], { cwd: UI_SERVER_ROOT });
}

async function fetchMathlib() {
  if (options.refreshLeanDeps || !existsSync(MATHLIB_PACKAGE_PATH)) {
    console.log("Fetching Lea workspace Mathlib dependencies...");
    await run("lake", ["update"], { cwd: LEA_WORKSPACE });
  } else {
    console.log("Lea workspace Mathlib dependencies already present; skipping `lake update`.");
    console.log("Run `npm run update-lean-deps` to refresh Lean dependencies.");
  }

  console.log("Fetching Lea workspace Mathlib compiled cache...");
  await run("lake", ["exe", "cache", "get"], { cwd: LEA_WORKSPACE });
  await verifyMathlibCache();
}

async function verifyMathlibCache() {
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "lea-ecosystem-mathlib-"));
  const scratchFile = path.join(scratchDir, "ImportMathlib.lean");

  try {
    await fs.writeFile(scratchFile, "import Mathlib\n\n#check Nat\n", "utf8");
    console.log("Verifying Lea workspace Mathlib compiled cache...");
    await run("lake", ["env", "lean", scratchFile], { cwd: LEA_WORKSPACE });
  } catch (error) {
    throw new Error(
      `${error.message}\nMathlib is present but the compiled cache is not usable. ` +
        "Run `npm run update-lean-deps` and wait for `lake exe cache get` to finish."
    );
  } finally {
    await fs.rm(scratchDir, { recursive: true, force: true });
  }

  if (!existsSync(MATHLIB_OLEAN_PATH)) {
    throw new Error("Lean Mathlib cache is missing after cache download.");
  }
}

async function writeOverleafSettings() {
  const env = readDotEnv(ROOT_ENV_PATH);
  const settings = await readJson(OVERLEAF_SETTINGS_PATH, {});
  const next = {
    ...settings,
    leaRepoPath: LEA_ROOT,
    leaWorkspacePath: LEA_WORKSPACE,
    leaApiBaseUrl: settings.leaApiBaseUrl || env.LEA_API_BASE_URL || DEFAULT_ENV.LEA_API_BASE_URL,
    leaProvider: settings.leaProvider || env.LEA_PROVIDER || DEFAULT_ENV.LEA_PROVIDER,
    leaModel: settings.leaModel || env.LEA_MODEL || DEFAULT_ENV.LEA_MODEL,
    leaMaxTurns: settings.leaMaxTurns || Number(env.LEA_MAX_TURNS || DEFAULT_ENV.LEA_MAX_TURNS),
    leaLatexContextMode: settings.leaLatexContextMode || DEFAULT_OVERLEAF_LATEX_CONTEXT_MODE,
    leaJobTimeoutSeconds: settings.leaJobTimeoutSeconds || Number(env.LEA_JOB_TIMEOUT_SECONDS || DEFAULT_ENV.LEA_JOB_TIMEOUT_SECONDS),
  };

  await fs.mkdir(path.dirname(OVERLEAF_SETTINGS_PATH), { recursive: true });
  await fs.writeFile(OVERLEAF_SETTINGS_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  console.log("Wrote Overleaf companion settings.");
}

function parseArgs(args) {
  const parsed = {
    target: "all",
    refreshLeanDeps: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--refresh-lean-deps") {
      parsed.refreshLeanDeps = true;
      continue;
    }
    if (arg === "--target") {
      const value = args[index + 1];
      if (!value) usage("Missing value for --target.");
      parsed.target = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--target=")) {
      parsed.target = arg.slice("--target=".length);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usage();
    }
    usage(`Unknown argument: ${arg}`);
  }

  if (!VALID_TARGETS.has(parsed.target)) {
    usage(`Invalid --target "${parsed.target}".`);
  }

  return parsed;
}

function usage(error) {
  if (error) {
    console.error(`[setup] ${error}\n`);
  }
  console.error(`Usage: node ${path.relative(MONOREPO_ROOT, path.join(SCRIPT_DIR, "setup.mjs"))} [--target all|ui|overleaf] [--refresh-lean-deps]`);
  process.exit(error ? 1 : 0);
}

function run(command, args, { cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: process.env,
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
    return readDotEnv(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function resolveMonorepoPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(MONOREPO_ROOT, value);
}

function relativeToMonorepo(value) {
  return path.relative(MONOREPO_ROOT, value) || ".";
}
