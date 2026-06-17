import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile, ROOT_ENV_PATH } from "../../../scripts/env.mjs";
import { normalizeModelFamilyId } from "../../../packages/lea-model-catalog/index.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MONOREPO_ROOT = path.resolve(PROJECT_ROOT, "../..");
const DEFAULT_LEA_REPO_PATH = path.resolve(MONOREPO_ROOT, "vendor", "lea-prover");

export function loadDotEnv(projectRoot = MONOREPO_ROOT, target = process.env) {
  const envRoot = projectRoot === PROJECT_ROOT ? MONOREPO_ROOT : projectRoot;
  return loadEnvFile(path.join(envRoot, ".env"), target);
}

export function loadRootDotEnv(target = process.env) {
  return loadEnvFile(ROOT_ENV_PATH, target);
}

export function applyEnvDefaults(settings, env = process.env) {
  const leaMaxSpendUsd = normalizeOptionalNonNegativeNumber(
    env.LEA_MAX_SPEND_USD !== undefined
      ? env.LEA_MAX_SPEND_USD
      : settings.leaMaxSpendUsd,
    "leaMaxSpendUsd"
  );
  const leaUiServerDir = resolveUnderMonorepo(
    env.LEA_UI_SERVER_DIR || settings.leaUiServerDir,
    path.join("apps", "lea-ui", "server")
  );
  return {
    ...settings,
    leaRepoPath: resolveLeaRoot(env.LEA_REPO_PATH || env.LEA_ROOT || settings.leaRepoPath),
    leaSharedState: normalizeBoolean(
      env.LEA_SHARED_STATE !== undefined ? env.LEA_SHARED_STATE : settings.leaSharedState,
      false
    ),
    leaUiServerDir,
    leaRecorderPython:
      env.LEA_RECORDER_PYTHON ||
      settings.leaRecorderPython ||
      path.join(leaUiServerDir, ".venv", "bin", "python"),
    leaApiBaseUrl: env.LEA_API_BASE_URL || settings.leaApiBaseUrl || "http://127.0.0.1:8000",
    leaProvider: normalizeModelFamilyId(env.LEA_PROVIDER || settings.leaProvider || "openai"),
    leaModel: env.LEA_MODEL || settings.leaModel || "o4-mini",
    leaMaxTurns: parseInt(env.LEA_MAX_TURNS || settings.leaMaxTurns || "20", 10),
    leaTheoremTranslationMaxRetries: parseInt(env.LEA_THEOREM_TRANSLATION_MAX_RETRIES || settings.leaTheoremTranslationMaxRetries || "3", 10),
    leaJobTimeoutSeconds: parseInt(env.LEA_JOB_TIMEOUT_SECONDS || settings.leaJobTimeoutSeconds || "900", 10),
    leaLatexContextMode: normalizeLeaLatexContextMode(settings.leaLatexContextMode || env.LEA_LATEX_CONTEXT_MODE || "off"),
    leaMaxSpendUsd
  };
}

function resolveLeaRoot(value) {
  if (!value) return DEFAULT_LEA_REPO_PATH;
  return path.isAbsolute(value) ? value : path.resolve(MONOREPO_ROOT, value);
}

function resolveUnderMonorepo(value, fallbackRelative) {
  const target = value || fallbackRelative;
  return path.isAbsolute(target) ? target : path.resolve(MONOREPO_ROOT, target);
}

export function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(text)) return true;
  if (["false", "0", "no", "off"].includes(text)) return false;
  return fallback;
}

export function normalizeLeaLatexContextMode(value) {
  const mode = String(value || "off").trim();
  if (mode === "off" || mode === "active_file") return mode;
  throw new Error("leaLatexContextMode must be off or active_file");
}

function normalizeOptionalNonNegativeNumber(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${fieldName} must be greater than or equal to 0`);
  }
  return number;
}
