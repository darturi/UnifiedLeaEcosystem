import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_LEA_REPO_PATH = path.join(PROJECT_ROOT, "vendor", "lea-prover");

export function loadDotEnv(projectRoot) {
  const envPath = path.join(projectRoot, ".env");
  if (!fs.existsSync(envPath)) return { loaded: false, path: envPath };

  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equals = trimmed.indexOf("=");
    if (equals === -1) continue;

    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if (!key || process.env[key] !== undefined) continue;

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }

  return { loaded: true, path: envPath };
}

export function applyEnvDefaults(settings, env = process.env) {
  return {
    ...settings,
    leaRepoPath: settings.leaRepoPath || env.LEA_REPO_PATH || DEFAULT_LEA_REPO_PATH,
    leaApiBaseUrl: settings.leaApiBaseUrl || env.LEA_API_BASE_URL || "http://127.0.0.1:8000",
    leaProvider: settings.leaProvider || env.LEA_PROVIDER || "openai",
    leaModel: settings.leaModel || env.LEA_MODEL || "o4-mini",
    leaMaxTurns: settings.leaMaxTurns || parseInt(env.LEA_MAX_TURNS || "20", 10),
    leaJobTimeoutSeconds: settings.leaJobTimeoutSeconds || parseInt(env.LEA_JOB_TIMEOUT_SECONDS || "900", 10)
  };
}
