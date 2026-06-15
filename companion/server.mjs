import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildLeaProjectMarkdownPath,
  buildLeaProofPath,
  buildLeaWorkspacePath,
  GENERATOR_VERSION,
  LEA_PROOFS_DIR,
  relativeToLeaRepo,
  slugProjectId
} from "../shared/leanStub.mjs";
import {
  hashTheoremText,
  inferLeanDeclarationName,
  isValidLeanIdentifier
} from "../shared/theoremParser.mjs";
import { applyEnvDefaults, loadDotEnv } from "./config.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 31245;
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = path.join(PROJECT_ROOT, ".overleaf-lean-stub");
const ENV_PATH = path.join(PROJECT_ROOT, ".env");
const SETTINGS_PATH = path.join(APP_DIR, "settings.json");
const JOBS_PATH = path.join(APP_DIR, "jobs.json");
const JOB_LOG_DIR = path.join(APP_DIR, "jobs");
const DEFAULT_LEA_MODEL = "o4-mini";
const DEFAULT_LEA_API_BASE_URL = "http://127.0.0.1:8000";
const DEFAULT_LEA_MAX_TURNS = 20;
const DEFAULT_LEA_JOB_TIMEOUT_SECONDS = 900;
const DEFAULT_LEA_MODEL_MAX_TOKENS = 16384;
const PROVIDER_KEY_VALIDATION_TIMEOUT_MS = 5000;
const LEA_MODEL_FAMILIES = [
  { id: "openai", label: "OpenAI", envVars: ["OPENAI_API_KEY"] },
  { id: "gemini", label: "Gemini", envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
  { id: "anthropic", label: "Anthropic", envVars: ["ANTHROPIC_API_KEY"] }
];
export const LEA_MODEL_OPTIONS = [
  { id: "o4-mini", label: "o4-mini", family: "openai", tag: "Current default" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", family: "openai", tag: "Fast" },
  { id: "gpt-5.4", label: "GPT-5.4", family: "openai", tag: "Balanced" },
  { id: "gpt-5.5", label: "GPT-5.5", family: "openai", tag: "Most capable" },
  { id: "gemini/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview", family: "gemini", tag: "Research" },
  { id: "gemini/gemini-2.5-pro", label: "Gemini 2.5 Pro", family: "gemini", tag: "Capable" },
  { id: "gemini/gemini-2.5-flash", label: "Gemini 2.5 Flash", family: "gemini", tag: "Fast" },
  { id: "anthropic/claude-opus-4-8", label: "Claude Opus 4.8", family: "anthropic", tag: "Most capable" },
  { id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6", family: "anthropic", tag: "Balanced" }
];
const LEA_MODEL_BY_ID = new Map(LEA_MODEL_OPTIONS.map((model) => [model.id, model]));
const LEA_MODEL_FAMILY_BY_ID = new Map(LEA_MODEL_FAMILIES.map((family) => [family.id, family]));
const LEGACY_LEA_MODEL_ALIASES = new Map([
  ["anthropic/claude-opus-4-20250514", "anthropic/claude-opus-4-8"],
  ["anthropic/claude-sonnet-4-20250514", "anthropic/claude-sonnet-4-6"]
]);

export async function createServer({
  settingsPath = SETTINGS_PATH,
  jobsPath = JOBS_PATH,
  fetchImpl = fetch,
  env = process.env
} = {}) {
  const state = {
    settingsPath,
    jobsPath,
    fetchImpl,
    env,
    settings: applyEnvDefaults(await readJson(settingsPath, {}), env),
    jobs: await readJson(jobsPath, {})
  };
  await ensureStartupLeaRuntime(state);
  await recoverInterruptedJobs(state);

  return http.createServer(async (request, response) => {
    try {
      await routeRequest(request, response, state);
    } catch (error) {
      sendJson(response, 500, {
        error: "internal_error",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });
}

export async function recoverInterruptedJobs(state) {
  const jobs = state.jobs || {};
  const interruptedAt = new Date().toISOString();
  let changed = false;

  for (const job of Object.values(jobs)) {
    if (job.status !== "in_progress") continue;
    job.status = "failed";
    job.finalStatus = "interrupted";
    job.error = "Companion restarted before this Lea job finished.";
    job.finishedAt = interruptedAt;
    if (job.logPath) {
      await appendLog(job.logPath, `\n[backend] ${job.error}\n`);
    }
    changed = true;
  }

  if (changed) {
    await writeJson(state.jobsPath, jobs);
  }
}

export async function handleGetStatuses(payload, state) {
  const leaValidation = validateLeaRuntime(state, { requireApiKey: false });
  if (!leaValidation.ok) {
    return errorResponse(400, leaValidation.error, leaValidation.message);
  }

  const theorems = Array.isArray(payload.theorems) ? payload.theorems : [];
  const statuses = {};

  for (const theorem of theorems) {
    const theoremLabel = String(theorem.theoremLabel || "");
    const theoremText = String(theorem.theoremText || "");
    if (!isValidLeanIdentifier(theoremLabel) || !theoremText.trim()) {
      continue;
    }

    statuses[theoremLabel] = await getTheoremStatus({
      leaRepoPath: state.settings.leaRepoPath,
      overleafProjectId: payload.overleafProjectId || "unknown",
      theoremLabel,
      jobs: state.jobs || {}
    });
  }

  return { statusCode: 200, body: { statuses } };
}

export async function handleFormalize(payload, state) {
  const validation = validateLeaPayload(payload);
  if (!validation.ok) {
    return errorResponse(400, validation.error, validation.message);
  }

  const { overleafProjectId, theoremLabel, theoremText, theoremUses, theoremContext } = validation;
  const expectedHash = hashTheoremText(theoremText);
  if (payload.sourceHash && payload.sourceHash !== expectedHash) {
    return errorResponse(400, "source_hash_mismatch", "sourceHash does not match theoremText.");
  }

  const leaValidation = validateLeaRuntime(state, { requireApiKey: true });
  if (!leaValidation.ok) {
    return errorResponse(400, leaValidation.error, leaValidation.message);
  }

  const target = buildLeaTarget({
    leaRepoPath: state.settings.leaRepoPath,
    overleafProjectId,
    theoremLabel
  });
  const activeJob = findActiveJob(state.jobs || {}, target.jobKey);
  if (activeJob) {
    return {
      statusCode: 200,
      body: buildJobResponse({ job: activeJob, status: "in_progress", target })
    };
  }

  const resumed = await maybeResumeStubFormalization({
    state,
    target,
    theoremText,
    theoremContext,
    theoremUses
  });
  if (resumed) {
    return resumed;
  }

  const usesResolution = await resolveTheoremUses({
    leaRepoPath: state.settings.leaRepoPath,
    overleafProjectId,
    theoremUses,
    jobs: state.jobs || {}
  });
  if (!usesResolution.ok) {
    return errorResponse(400, usesResolution.error, usesResolution.message);
  }

  const cleanup = await cleanupPreviousRunArtifacts({
    leaRepoPath: state.settings.leaRepoPath,
    target,
    theoremText,
    jobs: state.jobs || {}
  });
  const job = await createLeaJob({ state, target, theoremText, theoremContext, resolvedUses: usesResolution.resolvedUses });
  job.retryCleanup = cleanup;
  state.jobs[job.jobId] = job;
  await writeJson(state.jobsPath, state.jobs);

  runLeaJob({ state, job, target, theoremText, theoremContext, resolvedUses: usesResolution.resolvedUses }).catch(async (error) => {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    job.finishedAt = new Date().toISOString();
    await appendLog(job.logPath, `\n[backend] ${job.error}\n`);
    await writeJson(state.jobsPath, state.jobs);
  });

  return {
    statusCode: 200,
    body: buildJobResponse({ job, status: "in_progress", target })
  };
}

export async function handleStub(payload, state) {
  const validation = validateLeaPayload(payload);
  if (!validation.ok) {
    return errorResponse(400, validation.error, validation.message);
  }

  const { overleafProjectId, theoremLabel, theoremText, theoremContext } = validation;
  const expectedHash = hashTheoremText(theoremText);
  if (payload.sourceHash && payload.sourceHash !== expectedHash) {
    return errorResponse(400, "source_hash_mismatch", "sourceHash does not match theoremText.");
  }

  const leaValidation = validateLeaRuntime(state, { requireApiKey: true });
  if (!leaValidation.ok) {
    return errorResponse(400, leaValidation.error, leaValidation.message);
  }

  const target = buildLeaTarget({
    leaRepoPath: state.settings.leaRepoPath,
    overleafProjectId,
    theoremLabel
  });
  const activeJob = findActiveJob(state.jobs || {}, target.jobKey);
  if (activeJob) {
    return errorResponse(409, "job_in_progress", "Lea is already working on this theorem.");
  }

  const currentStatus = await getTheoremStatus({
    leaRepoPath: state.settings.leaRepoPath,
    overleafProjectId,
    theoremLabel,
    jobs: state.jobs || {}
  });
  const equivalentStatus = getEquivalentTheoremStatus(currentStatus);
  if (equivalentStatus.status !== "unformalized") {
    return errorResponse(409, "not_unformalized", "Stub is only available for unformalized theorems.");
  }

  const cleanup = await cleanupPreviousRunArtifacts({
    leaRepoPath: state.settings.leaRepoPath,
    target,
    theoremText,
    jobs: state.jobs || {}
  });
  const job = await createLeaJob({ state, target, theoremText, theoremContext });
  job.kind = "stub";
  job.retryCleanup = cleanup;
  state.jobs[job.jobId] = job;
  await writeJson(state.jobsPath, state.jobs);

  try {
    await createStubJob({ state, job, target, theoremText, theoremContext });
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    job.finishedAt = new Date().toISOString();
    await appendLog(job.logPath, `\n[backend] ${job.error}\n`);
    await writeJson(state.jobsPath, state.jobs);
    return errorResponse(500, "stub_failed", job.error);
  }

  return {
    statusCode: 200,
    body: buildJobResponse({ job, status: "sorry_stub", target })
  };
}

export async function handleUpdateLeaSettings(payload, state) {
  const leaRepoPath = String(payload.leaRepoPath || "").trim();
  const validation = await validateLeaRepo(leaRepoPath);
  if (!validation.ok) {
    return errorResponse(400, "invalid_lea_path", validation.message);
  }

  const model = normalizeLeaModelId(payload.leaModel || DEFAULT_LEA_MODEL);
  const modelInfo = LEA_MODEL_BY_ID.get(model);
  if (!modelInfo) {
    return errorResponse(400, "invalid_lea_model", "Lea model must be one of the supported models.");
  }

  let leaApiBaseUrl;
  try {
    leaApiBaseUrl = normalizeLeaApiBaseUrl(
      payload.leaApiBaseUrl || state.settings.leaApiBaseUrl || DEFAULT_LEA_API_BASE_URL
    );
  } catch {
    return errorResponse(400, "invalid_lea_api_url", "Lea API base URL must be an absolute http(s) URL.");
  }

  const providerEnvPatch = buildProviderEnvPatch(payload.leaProviderApiKeys);
  const nextSettings = {
    ...state.settings,
    leaRepoPath: path.resolve(leaRepoPath),
    leaWorkspacePath: validation.leaWorkspacePath,
    leaApiBaseUrl,
    leaProvider: modelInfo.family,
    leaModel: model,
    leaMaxTurns: normalizeLeaMaxTurns(payload.leaMaxTurns || DEFAULT_LEA_MAX_TURNS),
    leaJobTimeoutSeconds: Number.parseInt(
    String(payload.leaJobTimeoutSeconds || state.settings.leaJobTimeoutSeconds || DEFAULT_LEA_JOB_TIMEOUT_SECONDS),
    10
    )
  };
  const nextState = { ...state, settings: nextSettings, env: { ...(state.env || {}), ...providerEnvPatch } };
  if (!getProviderApiKey(nextState, modelInfo.family)) {
    return errorResponse(
      400,
      `missing_${modelInfo.family}_key`,
      `${LEA_MODEL_FAMILY_BY_ID.get(modelInfo.family)?.label || modelInfo.family} API key must be set in .env or the companion process environment before selecting this model.`
    );
  }
  const keyValidation = await validateProviderApiKeys({
    fetchImpl: state.fetchImpl || fetch,
    providerEnvPatch,
    selectedFamilyId: modelInfo.family,
    state: nextState
  });
  if (!keyValidation.ok) {
    return errorResponse(400, keyValidation.error, keyValidation.message);
  }
  if (Object.keys(providerEnvPatch).length > 0) {
    await persistEnvPatch(state.envPath || ENV_PATH, providerEnvPatch);
    state.env ||= {};
    Object.assign(state.env, providerEnvPatch);
  }
  state.settings = nextSettings;
  await writeJson(state.settingsPath, sanitizeSettingsForStorage(state.settings));
  return { statusCode: 200, body: buildSettingsResponse(state) };
}

export function handleGetUsage(payload, state) {
  const overleafProjectId = String(payload.overleafProjectId || "unknown");
  return {
    statusCode: 200,
    body: {
      project: aggregateUsage(state.jobs || {}, { overleafProjectId }),
      allTime: aggregateUsage(state.jobs || {}, {})
    }
  };
}

export async function validateLeaRepo(leaRepoPath) {
  if (!leaRepoPath || !path.isAbsolute(leaRepoPath)) {
    return { ok: false, message: "Lea repo path must be absolute." };
  }
  if (!existsSync(path.join(leaRepoPath, "pyproject.toml"))) {
    return { ok: false, message: "Lea repo path must contain pyproject.toml." };
  }
  const leaWorkspacePath = buildLeaWorkspacePath(leaRepoPath);
  if (!existsSync(path.join(leaWorkspacePath, "lean-toolchain"))) {
    return { ok: false, message: "Lea workspace must contain lean-toolchain." };
  }
  if (!existsSync(path.join(leaWorkspacePath, "lakefile.lean")) && !existsSync(path.join(leaWorkspacePath, "lakefile.toml"))) {
    return { ok: false, message: "Lea workspace must contain lakefile.lean or lakefile.toml." };
  }
  return { ok: true, leaWorkspacePath };
}

export async function ensureStartupLeaRuntime(state) {
  const legacyProviderEnvPatch = buildLegacyProviderEnvPatch(state);
  if (state.settings?.leaApiKey && !getProviderApiKey(state, "openai") && !legacyProviderEnvPatch.OPENAI_API_KEY) {
    legacyProviderEnvPatch.OPENAI_API_KEY = String(state.settings.leaApiKey).trim();
  }
  if (Object.keys(legacyProviderEnvPatch).length > 0) {
    await persistEnvPatch(state.envPath || ENV_PATH, legacyProviderEnvPatch);
    state.env ||= {};
    Object.assign(state.env, legacyProviderEnvPatch);
  }
  state.settings = sanitizeRuntimeSettings(state.settings || {});
  const validation = await validateLeaRepo(state.settings.leaRepoPath);
  state.settings.leaWorkspacePath = validation.ok ? validation.leaWorkspacePath : buildLeaWorkspacePath(state.settings.leaRepoPath);
  await writeJson(state.settingsPath, sanitizeSettingsForStorage(state.settings));
  return {
    leaRepoPath: state.settings.leaRepoPath,
    leaWorkspacePath: state.settings.leaWorkspacePath,
    ok: validation.ok,
    message: validation.message || ""
  };
}

async function routeRequest(request, response, state) {
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url || "/", "http://127.0.0.1");

  if (request.method === "GET" && url.pathname === "/health") {
    const validation = await validateLeaRepo(state.settings.leaRepoPath);
    sendJson(response, 200, {
      ok: true,
      generatorVersion: GENERATOR_VERSION,
      leaRepoConfigured: validation.ok,
      leaWorkspacePath: validation.ok ? validation.leaWorkspacePath : state.settings.leaWorkspacePath || ""
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/settings") {
    sendJson(response, 200, buildSettingsResponse(state));
    return;
  }

  if (request.method === "POST" && url.pathname === "/settings/lea") {
    const result = await handleUpdateLeaSettings(await readBodyJson(request), state);
    sendJson(response, result.statusCode, result.body);
    return;
  }

  if (request.method === "GET" && url.pathname === "/usage") {
    const result = handleGetUsage({
      overleafProjectId: url.searchParams.get("overleafProjectId") || "unknown"
    }, state);
    sendJson(response, result.statusCode, result.body);
    return;
  }

  if (request.method === "POST" && url.pathname === "/statuses") {
    const result = await handleGetStatuses(await readBodyJson(request), state);
    sendJson(response, result.statusCode, result.body);
    return;
  }

  if (request.method === "POST" && url.pathname === "/formalize") {
    const result = await handleFormalize(await readBodyJson(request), state);
    sendJson(response, result.statusCode, result.body);
    return;
  }

  if (request.method === "POST" && url.pathname === "/stub") {
    const result = await handleStub(await readBodyJson(request), state);
    sendJson(response, result.statusCode, result.body);
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/jobs/")) {
    const jobId = decodeURIComponent(url.pathname.slice("/jobs/".length));
    const job = state.jobs?.[jobId];
    if (!job) {
      sendJson(response, 404, { error: "job_not_found", message: "Unknown job." });
      return;
    }
    sendJson(response, 200, {
      ...job,
      logTail: await readLogTail(job.logPath)
    });
    return;
  }

  sendJson(response, 404, { error: "not_found", message: "Unknown endpoint." });
}

export function buildSettingsResponse(state) {
  const leaRepoPath = state.settings.leaRepoPath || "";
  const model = normalizeLeaModelId(state.settings.leaModel || DEFAULT_LEA_MODEL);
  const modelInfo = LEA_MODEL_BY_ID.get(model) || LEA_MODEL_BY_ID.get(DEFAULT_LEA_MODEL);
  return {
    ok: true,
    leaRepoPath,
    leaWorkspacePath: leaRepoPath ? buildLeaWorkspacePath(leaRepoPath) : "",
    leaApiBaseUrl: state.settings.leaApiBaseUrl || DEFAULT_LEA_API_BASE_URL,
    leaApiKeyConfigured: Boolean(getProviderApiKey(state, modelInfo.family)),
    leaProvider: modelInfo.family,
    leaProviderFamily: modelInfo.family,
    leaProviderKeys: buildProviderKeyStatus(state),
    leaModel: modelInfo.id,
    leaModelOptions: LEA_MODEL_OPTIONS,
    leaMaxTurns: state.settings.leaMaxTurns || DEFAULT_LEA_MAX_TURNS,
    leaJobTimeoutSeconds: state.settings.leaJobTimeoutSeconds || DEFAULT_LEA_JOB_TIMEOUT_SECONDS
  };
}

function buildProviderKeyStatus(state) {
  const status = {};
  for (const family of LEA_MODEL_FAMILIES) {
    status[family.id] = {
      label: family.label,
      configured: Boolean(getProviderApiKey(state, family.id))
    };
  }
  return status;
}

function getProviderApiKey(state, familyId) {
  const family = LEA_MODEL_FAMILY_BY_ID.get(familyId);
  for (const envVar of family?.envVars || []) {
    const value = String(state.env?.[envVar] || "").trim();
    if (value) return value;
  }
  return "";
}

async function validateProviderApiKeys({ fetchImpl, providerEnvPatch, selectedFamilyId, state }) {
  const requests = new Map();
  for (const [envVar, apiKey] of Object.entries(providerEnvPatch || {})) {
    const family = LEA_MODEL_FAMILIES.find((candidate) => candidate.envVars.includes(envVar));
    if (!family || !apiKey) continue;
    requests.set(`${family.id}:${apiKey}`, { familyId: family.id, apiKey });
  }

  const selectedApiKey = getProviderApiKey(state, selectedFamilyId);
  if (selectedApiKey) {
    requests.set(`${selectedFamilyId}:${selectedApiKey}`, {
      familyId: selectedFamilyId,
      apiKey: selectedApiKey
    });
  }

  for (const request of requests.values()) {
    const result = await validateProviderApiKey(fetchImpl, request);
    if (!result.ok) return result;
  }
  return { ok: true };
}

async function validateProviderApiKey(fetchImpl, { familyId, apiKey }) {
  const family = LEA_MODEL_FAMILY_BY_ID.get(familyId);
  const label = family?.label || familyId;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_KEY_VALIDATION_TIMEOUT_MS);

  try {
    const response = await fetchImpl(providerValidationUrl(familyId, apiKey), {
      method: "GET",
      headers: providerValidationHeaders(familyId, apiKey),
      signal: controller.signal
    });
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        error: `invalid_${familyId}_key`,
        message: `${label} API key was rejected by ${label}. Check the key and try again.`
      };
    }
    if (!response.ok) {
      return providerKeyVerificationError(familyId, label);
    }
    if (text) {
      try {
        JSON.parse(text);
      } catch {
        return providerKeyVerificationError(familyId, label);
      }
    }
    return { ok: true };
  } catch {
    return providerKeyVerificationError(familyId, label);
  } finally {
    clearTimeout(timer);
  }
}

function providerValidationUrl(familyId, apiKey) {
  if (familyId === "openai") return "https://api.openai.com/v1/models";
  if (familyId === "gemini") {
    return `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  }
  if (familyId === "anthropic") return "https://api.anthropic.com/v1/models";
  return "";
}

function providerValidationHeaders(familyId, apiKey) {
  if (familyId === "openai") {
    return { Authorization: `Bearer ${apiKey}` };
  }
  if (familyId === "anthropic") {
    return {
      "anthropic-version": "2023-06-01",
      "x-api-key": apiKey
    };
  }
  return {};
}

function providerKeyVerificationError(familyId, label) {
  return {
    ok: false,
    error: `${familyId}_key_verification_failed`,
    message: `Could not verify ${label} API key. Check your network connection or try again.`
  };
}

function buildProviderEnvPatch(patchKeys) {
  const patch = {};
  if (!patchKeys || typeof patchKeys !== "object" || Array.isArray(patchKeys)) {
    return patch;
  }
  for (const family of LEA_MODEL_FAMILIES) {
    if (!Object.prototype.hasOwnProperty.call(patchKeys, family.id)) continue;
    const value = String(patchKeys[family.id] || "").trim();
    if (!value) continue;
    const envVar = family.envVars[0];
    patch[envVar] = value;
  }
  return patch;
}

function buildLegacyProviderEnvPatch(state) {
  const patch = {};
  const patchKeys = state.settings?.leaProviderApiKeys;
  if (!patchKeys || typeof patchKeys !== "object" || Array.isArray(patchKeys)) {
    return patch;
  }
  for (const family of LEA_MODEL_FAMILIES) {
    if (getProviderApiKey(state, family.id)) continue;
    const value = String(patchKeys[family.id] || "").trim();
    if (value) {
      patch[family.envVars[0]] = value;
    }
  }
  return patch;
}

async function persistEnvPatch(envPath, patch) {
  let content = "";
  try {
    content = await fs.readFile(envPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const lines = content ? content.split(/\r?\n/) : [];
  const seen = new Set();
  const nextLines = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match || !Object.prototype.hasOwnProperty.call(patch, match[1])) {
      return line;
    }
    seen.add(match[1]);
    return `${match[1]}=${formatEnvValue(patch[match[1]])}`;
  });

  for (const [key, value] of Object.entries(patch)) {
    if (!seen.has(key)) {
      nextLines.push(`${key}=${formatEnvValue(value)}`);
    }
  }

  await fs.writeFile(envPath, `${nextLines.filter((line, index) => line || index < nextLines.length - 1).join("\n")}\n`, "utf8");
}

function formatEnvValue(value) {
  const text = String(value);
  return /[\s#"'\\]/.test(text) ? JSON.stringify(text) : text;
}

function normalizeLeaModelId(modelId) {
  const raw = String(modelId || DEFAULT_LEA_MODEL);
  return LEGACY_LEA_MODEL_ALIASES.get(raw) || raw;
}

function sanitizeRuntimeSettings(settings) {
  const {
    leaApiKey: _leaApiKey,
    leaProviderApiKeys: _leaProviderApiKeys,
    ...rest
  } = settings || {};
  return {
    ...rest,
    leaModel: normalizeLeaModelId(rest.leaModel || DEFAULT_LEA_MODEL)
  };
}

function sanitizeSettingsForStorage(settings) {
  return sanitizeRuntimeSettings(settings);
}

function validateLeaPayload(payload) {
  const overleafProjectId = String(payload.overleafProjectId || "");
  const theoremLabel = String(payload.theoremLabel || "");
  const theoremText = String(payload.theoremText || "");
  const theoremContext = String(payload.theoremContext || "").trim();
  const theoremUses = Array.isArray(payload.theoremUses)
    ? payload.theoremUses.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  if (!overleafProjectId.trim()) {
    return { ok: false, error: "missing_project_id", message: "overleafProjectId is required." };
  }
  if (!isValidLeanIdentifier(theoremLabel)) {
    return { ok: false, error: "invalid_label", message: "Theorem label must be a valid Lean identifier." };
  }
  const invalidUse = theoremUses.find((value) => !isValidLeanIdentifier(value));
  if (invalidUse) {
    return { ok: false, error: "invalid_uses", message: `Theorem dependency label must be a valid Lean identifier: ${invalidUse}.` };
  }
  if (!theoremText.trim()) {
    return { ok: false, error: "missing_theorem_text", message: "Theorem text is required." };
  }
  return { ok: true, overleafProjectId, theoremLabel, theoremText, theoremUses, theoremContext };
}

function buildLeaTarget({ leaRepoPath, overleafProjectId, theoremLabel }) {
  const projectSlug = slugProjectId(overleafProjectId);
  const projectMarkdownPath = buildLeaProjectMarkdownPath({ leaRepoPath, overleafProjectId });
  return {
    overleafProjectId,
    projectId: overleafProjectId,
    projectSlug,
    theoremLabel,
    declarationName: theoremLabel,
    projectMarkdownPath,
    relativePath: relativeToLeaRepo({ leaRepoPath, absolutePath: projectMarkdownPath }),
    absolutePath: projectMarkdownPath,
    jobKey: `${projectSlug}:${theoremLabel}`
  };
}

function findActiveJob(jobs, jobKey) {
  return Object.values(jobs).find((job) => job.jobKey === jobKey && job.status === "in_progress");
}

function findLatestJob(jobs, jobKey, status) {
  return Object.values(jobs)
    .filter((job) => job.jobKey === jobKey && job.status === status)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0] || null;
}

function findLatestFinishedJob(jobs, jobKey) {
  return Object.values(jobs || {})
    .filter((job) => job.jobKey === jobKey && job.status !== "in_progress")
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0] || null;
}

function findLatestStubJob(jobs, jobKey) {
  return Object.values(jobs || {})
    .filter((job) => (
      job.jobKey === jobKey &&
      job.status === "sorry_stub" &&
      job.declarationName &&
      job.recordedProofPath
    ))
    .sort((a, b) => String(b.finishedAt || b.startedAt).localeCompare(String(a.finishedAt || a.startedAt)))[0] || null;
}

async function resolveTheoremUses({ leaRepoPath, overleafProjectId, theoremUses, jobs }) {
  const resolvedUses = [];
  const unresolvedUses = [];

  for (const theoremLabel of theoremUses) {
    const status = await getTheoremStatus({
      leaRepoPath,
      overleafProjectId,
      theoremLabel,
      jobs
    });

    const equivalentStatus = getEquivalentTheoremStatus(status);
    if (!["formalized", "sorry_stub"].includes(equivalentStatus.status) || !equivalentStatus.absolutePath || !equivalentStatus.declarationName) {
      unresolvedUses.push(theoremLabel);
      continue;
    }

    resolvedUses.push({
      theoremLabel,
      declarationName: equivalentStatus.declarationName,
      relativePath: equivalentStatus.recordedProofPath || equivalentStatus.relativePath || "",
      absolutePath: equivalentStatus.absolutePath,
      moduleName: equivalentStatus.moduleName || null,
      status: equivalentStatus.status
    });
  }

  if (unresolvedUses.length > 0) {
    return {
      ok: false,
      error: "unresolved_uses",
      message: `Formalize referenced theorem${unresolvedUses.length === 1 ? "" : "s"} first: ${unresolvedUses.join(", ")}.`
    };
  }

  return { ok: true, resolvedUses };
}

function validateLeaRuntime(state, { requireApiKey }) {
  if (!state.settings.leaRepoPath || !path.isAbsolute(state.settings.leaRepoPath)) {
    return { ok: false, error: "lea_unconfigured", message: "Configure an absolute Lea repo path first." };
  }
  if (!existsSync(path.join(state.settings.leaRepoPath, "pyproject.toml"))) {
    return { ok: false, error: "invalid_lea_path", message: "Lea repo path must contain pyproject.toml." };
  }
  const leaWorkspacePath = buildLeaWorkspacePath(state.settings.leaRepoPath);
  if (!existsSync(path.join(leaWorkspacePath, "lakefile.lean")) && !existsSync(path.join(leaWorkspacePath, "lakefile.toml"))) {
    return { ok: false, error: "invalid_lea_workspace", message: "Lea workspace must contain a lakefile." };
  }
  try {
    normalizeLeaApiBaseUrl(state.settings.leaApiBaseUrl || DEFAULT_LEA_API_BASE_URL);
  } catch {
    return { ok: false, error: "invalid_lea_api_url", message: "Lea API base URL must be an absolute http(s) URL." };
  }
  const modelInfo = LEA_MODEL_BY_ID.get(normalizeLeaModelId(state.settings.leaModel || DEFAULT_LEA_MODEL));
  if (!modelInfo) {
    return { ok: false, error: "invalid_lea_model", message: "Lea model must be one of the supported models." };
  }
  if (requireApiKey && !getProviderApiKey(state, modelInfo.family)) {
    const family = LEA_MODEL_FAMILY_BY_ID.get(modelInfo.family);
    const envList = family?.envVars?.join(" or ") || "provider API key";
    return {
      ok: false,
      error: `missing_${modelInfo.family}_key`,
      message: `${family?.label || modelInfo.family} API key must be set in .env or the companion process environment as ${envList}.`
    };
  }
  return { ok: true };
}

async function createLeaJob({ state, target, theoremText, theoremContext = "", resolvedUses = [] }) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jobId = `${target.theoremLabel}-${timestamp}`;
  const logPath = path.join(JOB_LOG_DIR, `${jobId}.log`);
  const declarationNameHint = inferLeanDeclarationName(theoremText);

  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, "", "utf8");
  const modelInfo = LEA_MODEL_BY_ID.get(normalizeLeaModelId(state.settings.leaModel || DEFAULT_LEA_MODEL)) || LEA_MODEL_BY_ID.get(DEFAULT_LEA_MODEL);

  return {
    jobId,
    jobKey: target.jobKey,
    status: "in_progress",
    overleafProjectId: target.overleafProjectId,
    projectId: target.projectId,
    projectSlug: target.projectSlug,
    projectMarkdownPath: target.projectMarkdownPath,
    theoremLabel: target.theoremLabel,
    declarationName: target.theoremLabel,
    declarationNameHint: declarationNameHint || null,
    theoremUses: resolvedUses,
    theoremContext,
    theoremTextHash: hashTheoremText(theoremText),
    relativePath: target.relativePath,
    absolutePath: target.absolutePath,
    logPath,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    leaRepoPath: state.settings.leaRepoPath,
    leaWorkspacePath: buildLeaWorkspacePath(state.settings.leaRepoPath),
    leaApiBaseUrl: state.settings.leaApiBaseUrl || DEFAULT_LEA_API_BASE_URL,
    leaApiKeyConfigured: Boolean(getProviderApiKey(state, modelInfo.family)),
    leaProvider: modelInfo.family,
    leaProviderFamily: modelInfo.family,
    leaModel: modelInfo.id,
    leaMaxTurns: state.settings.leaMaxTurns || DEFAULT_LEA_MAX_TURNS,
    leaCurrentTurn: null,
    leaJobTimeoutSeconds: state.settings.leaJobTimeoutSeconds || DEFAULT_LEA_JOB_TIMEOUT_SECONDS
  };
}

async function cleanupPreviousRunArtifacts({ leaRepoPath, target, theoremText, jobs }) {
  const previousJob = findLatestFinishedJob(jobs, target.jobKey);
  if (!previousJob) {
    return { removedProofPaths: [], removedProjectEntries: [] };
  }

  const declarationHint = inferLeanDeclarationName(theoremText);
  const candidateNames = new Set([
    previousJob.declarationName,
    previousJob.declarationNameHint,
    declarationHint,
    target.theoremLabel
  ].filter(Boolean));
  const candidateProofPaths = new Set([
    previousJob.recordedProofPath
  ].filter(Boolean));

  const entries = await readProjectTheoremEntries(target.projectMarkdownPath);
  const entriesToRemove = entries.filter((entry) => (
    candidateNames.has(entry.name) || candidateProofPaths.has(entry.proofPath)
  ));
  for (const entry of entriesToRemove) {
    candidateProofPaths.add(entry.proofPath);
  }

  const removedProofPaths = [];
  for (const proofPath of candidateProofPaths) {
    if (await removeLeaProofFile({ leaRepoPath, proofPath })) {
      removedProofPaths.push(proofPath);
    }
  }

  const removedProjectEntries = await removeProjectTheoremEntries({
    projectMarkdownPath: target.projectMarkdownPath,
    entriesToRemove
  });

  return { removedProofPaths, removedProjectEntries };
}

async function removeLeaProofFile({ leaRepoPath, proofPath }) {
  if (!String(proofPath || "").startsWith(`${LEA_PROOFS_DIR}${path.sep}`)) {
    return false;
  }
  const absolutePath = buildLeaProofPath({ leaRepoPath, proofPath });
  if (!absolutePath || !existsSync(absolutePath)) {
    return false;
  }

  try {
    await fs.rm(absolutePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function removeProjectTheoremEntries({ projectMarkdownPath, entriesToRemove }) {
  if (entriesToRemove.length === 0 || !existsSync(projectMarkdownPath)) {
    return [];
  }

  const markdown = await fs.readFile(projectMarkdownPath, "utf8");
  const keysToRemove = new Set(entriesToRemove.map(markerKey));
  const sections = findProjectTheoremSections(markdown)
    .filter((section) => keysToRemove.has(markerKey(section.entry)));
  if (sections.length === 0) {
    return [];
  }

  let nextMarkdown = markdown;
  for (const section of [...sections].sort((a, b) => b.start - a.start)) {
    nextMarkdown = `${nextMarkdown.slice(0, section.start)}${nextMarkdown.slice(section.end)}`;
  }
  await fs.writeFile(projectMarkdownPath, nextMarkdown.replace(/\n{3,}/g, "\n\n"), "utf8");
  return sections.map((section) => section.entry.name);
}

async function runLeaJob({ state, job, target, theoremText, theoremContext = "", resolvedUses = [] }) {
  const beforeMarkers = await readProjectTheoremEntries(target.projectMarkdownPath);
  const prompt = buildLeaPrompt({
    projectSlug: target.projectSlug,
    theoremLabel: target.theoremLabel,
    theoremText,
    theoremContext,
    declarationNameHint: job.declarationNameHint || "",
    resolvedUses
  });
  await appendLog(job.logPath, `$ POST ${job.leaApiBaseUrl}/v1/runs\n\n${prompt}\n\n`);
  const exit = await runLeaApiProofJob({
    fetchImpl: state.fetchImpl || fetch,
    baseUrl: job.leaApiBaseUrl,
    apiKey: state.env?.LEA_API_KEY,
    model: job.leaModel,
    maxTurns: job.leaMaxTurns,
    providerApiKey: getProviderApiKey(state, job.leaProviderFamily),
    prompt,
    project: {
      project_id: target.projectSlug,
      project_path: target.relativePath,
      record_on_success: true
    },
    logPath: job.logPath,
    timeoutMs: job.leaJobTimeoutSeconds * 1000,
    onUsageUpdated: async (usage) => {
      if (usage.delta) {
        recordJobUsageDelta(job, usage);
      } else {
        recordJobUsageSnapshot(job, usage);
      }
      await writeJson(state.jobsPath, state.jobs);
    },
    onProgressUpdated: async (progress) => {
      if (!recordJobTurnProgress(job, progress)) return;
      await writeJson(state.jobsPath, state.jobs);
    }
  });

  const artifact = exit.ok
    ? await identifyLeaArtifact({
      leaRepoPath: state.settings.leaRepoPath,
      target,
      beforeMarkers,
      job
    })
    : null;

  if (artifact?.ok) {
    job.declarationName = artifact.entry.name;
    job.recordedProofPath = artifact.entry.proofPath;
    job.moduleName = artifact.entry.moduleName || null;
  }
  recordJobUsage(job, exit);

  const status = artifact?.ok
    ? await getLeaProofStatusFromEntry({
      leaRepoPath: state.settings.leaRepoPath,
      target,
      entry: artifact.entry
    })
    : artifact?.error
      ? {
        status: "unformalized",
        theoremLabel: target.theoremLabel,
        declarationName: target.declarationName,
        relativePath: target.relativePath,
        absolutePath: target.absolutePath,
        projectId: target.projectId,
        projectSlug: target.projectSlug,
        projectMarkdownPath: target.projectMarkdownPath
      }
      : await getTheoremStatus({
        leaRepoPath: state.settings.leaRepoPath,
        overleafProjectId: target.overleafProjectId,
        theoremLabel: target.theoremLabel,
        jobs: {}
      });
  const effectiveStatus = (
    status.status === "unformalized" &&
    job.declarationName &&
    job.recordedProofPath
  )
    ? await getLeaProofStatusFromEntry({
      leaRepoPath: state.settings.leaRepoPath,
      target,
      entry: {
        name: job.declarationName,
        proofPath: job.recordedProofPath,
        moduleName: job.moduleName || null
      }
    })
    : status;
  let proofComplete = effectiveStatus.status === "formalized";
  if (proofComplete && effectiveStatus.absolutePath) {
    job.leanCheck = await runLeanCheck(job.leaWorkspacePath, effectiveStatus.absolutePath);
    proofComplete = job.leanCheck.ok;
  }
  const nextJobStatus = exit.ok && proofComplete ? "formalized" : "failed";
  job.stubbedTheoremUses = nextJobStatus === "formalized"
    ? await findImportedStubbedTheoremUses({
      proofPath: effectiveStatus.absolutePath,
      resolvedUses
    })
    : [];
  job.finalStatus = effectiveStatus.status;
  job.apiRunId = exit.apiRunId || null;
  job.exitCode = nextJobStatus === "formalized" ? 0 : 1;
  job.timedOut = exit.timedOut;
  if (nextJobStatus === "failed") {
    job.error = exit.error ||
      artifact?.error ||
      job.leanCheck?.message ||
      `Lea API run completed but final status is ${effectiveStatus.status}.`;
  }
  job.finishedAt = new Date().toISOString();
  const exitSummary = exit.timedOut
    ? `Lea timed out after ${job.leaJobTimeoutSeconds} seconds`
    : `Lea API run ${exit.ok ? "completed" : "failed"}`;
  await appendLog(job.logPath, `\n[backend] ${exitSummary}; final status ${effectiveStatus.status}\n`);
  if (job.error) {
    await appendLog(job.logPath, `[backend] ${job.error}\n`);
  }
  job.status = nextJobStatus;
  await writeJson(state.jobsPath, state.jobs);
}

async function maybeResumeStubFormalization({ state, target, theoremText, theoremContext = "", theoremUses = [] }) {
  const stubJob = findLatestStubJob(state.jobs || {}, target.jobKey);
  if (!stubJob?.apiRunId || !stubJob?.approvalId) {
    return null;
  }

  const run = await getLeaApiRun({
    fetchImpl: state.fetchImpl || fetch,
    baseUrl: stubJob.leaApiBaseUrl || state.settings.leaApiBaseUrl || DEFAULT_LEA_API_BASE_URL,
    apiKey: state.env?.LEA_API_KEY,
    apiRunId: stubJob.apiRunId
  });
  const runStatus = String(run.body?.status || run.body?.state || "").toLowerCase();
  const pendingApprovalId = run.body?.pending_approval?.approval_id;
  if (!run.ok || runStatus !== "paused" || pendingApprovalId !== stubJob.approvalId) {
    return null;
  }

  const usesResolution = await resolveTheoremUses({
    leaRepoPath: state.settings.leaRepoPath,
    overleafProjectId: target.overleafProjectId,
    theoremUses,
    jobs: state.jobs || {}
  });
  if (!usesResolution.ok) {
    return errorResponse(400, usesResolution.error, usesResolution.message);
  }

  stubJob.status = "in_progress";
  stubJob.kind = "formalize_after_stub";
  stubJob.theoremContext = theoremContext;
  stubJob.theoremUses = usesResolution.resolvedUses;
  stubJob.theoremTextHash = hashTheoremText(theoremText);
  stubJob.startedAt = new Date().toISOString();
  stubJob.finishedAt = null;
  stubJob.error = null;
  stubJob.exitCode = null;
  await writeJson(state.jobsPath, state.jobs);

  runLeaJobFromApproval({ state, job: stubJob, target }).catch(async (error) => {
    stubJob.status = "failed";
    stubJob.error = error instanceof Error ? error.message : String(error);
    stubJob.finishedAt = new Date().toISOString();
    await appendLog(stubJob.logPath, `\n[backend] ${stubJob.error}\n`);
    await writeJson(state.jobsPath, state.jobs);
  });

  return {
    statusCode: 200,
    body: buildJobResponse({ job: stubJob, status: "in_progress", target })
  };
}

async function createStubJob({ state, job, target, theoremText, theoremContext = "" }) {
  const prompt = buildLeaPrompt({
    projectSlug: target.projectSlug,
    theoremLabel: target.theoremLabel,
    theoremText,
    theoremContext,
    declarationNameHint: job.declarationNameHint || "",
    resolvedUses: []
  });
  await appendLog(job.logPath, `$ POST ${job.leaApiBaseUrl}/v1/runs (theorem translation approval)\n\n${prompt}\n\n`);
  const pause = await runLeaApiApprovalStubJob({
    fetchImpl: state.fetchImpl || fetch,
    baseUrl: job.leaApiBaseUrl,
    apiKey: state.env?.LEA_API_KEY,
    model: job.leaModel,
    maxTurns: job.leaMaxTurns,
    providerApiKey: getProviderApiKey(state, job.leaProviderFamily),
    prompt,
    project: {
      project_id: target.projectSlug,
      project_path: target.relativePath,
      record_on_success: true
    },
    logPath: job.logPath,
    timeoutMs: job.leaJobTimeoutSeconds * 1000,
    onUsageUpdated: async (usage) => {
      if (usage.delta) {
        recordJobUsageDelta(job, usage);
      } else {
        recordJobUsageSnapshot(job, usage);
      }
      await writeJson(state.jobsPath, state.jobs);
    },
    onProgressUpdated: async (progress) => {
      if (!recordJobTurnProgress(job, progress)) return;
      await writeJson(state.jobsPath, state.jobs);
    }
  });

  if (!pause.ok) {
    throw new Error(pause.error || "Lea did not produce a theorem-translation approval.");
  }

  recordJobUsage(job, pause);
  const entry = await persistStubApproval({
    leaRepoPath: state.settings.leaRepoPath,
    target,
    theoremText,
    theoremContext,
    approval: pause.approval
  });

  job.status = "sorry_stub";
  job.finalStatus = "sorry_stub";
  job.apiRunId = pause.apiRunId;
  job.approvalId = pause.approval.approval_id;
  job.declarationName = entry.name;
  job.recordedProofPath = entry.proofPath;
  job.moduleName = entry.moduleName || null;
  job.approvalLeanCode = pause.approval.lean_code;
  job.approvalCheckResult = pause.approval.check_result || "";
  job.finishedAt = new Date().toISOString();
  job.exitCode = 0;
  await appendLog(job.logPath, `\n[backend] Stub recorded at ${entry.proofPath}; Lea run paused for approval ${job.approvalId}\n`);
  await writeJson(state.jobsPath, state.jobs);
}

async function runLeaJobFromApproval({ state, job, target }) {
  const beforeMarkers = await readProjectTheoremEntries(target.projectMarkdownPath);
  const resume = await acceptLeaApproval({
    fetchImpl: state.fetchImpl || fetch,
    baseUrl: job.leaApiBaseUrl,
    apiKey: state.env?.LEA_API_KEY,
    apiRunId: job.apiRunId,
    approvalId: job.approvalId
  });
  if (!resume.ok) {
    throw new Error(resume.error || "Could not approve the saved Lea theorem translation.");
  }
  await appendLog(job.logPath, `\n[backend] Accepted Lea approval ${job.approvalId}; resuming run ${job.apiRunId}\n`);

  const exit = await waitForLeaApiProofJob({
    fetchImpl: state.fetchImpl || fetch,
    baseUrl: job.leaApiBaseUrl,
    apiKey: state.env?.LEA_API_KEY,
    apiRunId: job.apiRunId,
    maxTurns: job.leaMaxTurns,
    logPath: job.logPath,
    timeoutMs: job.leaJobTimeoutSeconds * 1000,
    onUsageUpdated: async (usage) => {
      if (usage.delta) {
        recordJobUsageDelta(job, usage);
      } else {
        recordJobUsageSnapshot(job, usage);
      }
      await writeJson(state.jobsPath, state.jobs);
    },
    onProgressUpdated: async (progress) => {
      if (!recordJobTurnProgress(job, progress)) return;
      await writeJson(state.jobsPath, state.jobs);
    }
  });

  await finishLeaProofJob({ state, job, target, beforeMarkers, exit });
}

async function finishLeaProofJob({ state, job, target, beforeMarkers, exit }) {
  const artifact = exit.ok
    ? await identifyLeaArtifact({
      leaRepoPath: state.settings.leaRepoPath,
      target,
      beforeMarkers,
      job
    })
    : null;

  if (artifact?.ok) {
    job.declarationName = artifact.entry.name;
    job.recordedProofPath = artifact.entry.proofPath;
    job.moduleName = artifact.entry.moduleName || null;
  }
  recordJobUsage(job, exit);

  const status = artifact?.ok
    ? await getLeaProofStatusFromEntry({
      leaRepoPath: state.settings.leaRepoPath,
      target,
      entry: artifact.entry
    })
    : artifact?.error
      ? {
        status: "unformalized",
        theoremLabel: target.theoremLabel,
        declarationName: target.declarationName,
        relativePath: target.relativePath,
        absolutePath: target.absolutePath,
        projectId: target.projectId,
        projectSlug: target.projectSlug,
        projectMarkdownPath: target.projectMarkdownPath
      }
      : await getTheoremStatus({
        leaRepoPath: state.settings.leaRepoPath,
        overleafProjectId: target.overleafProjectId,
        theoremLabel: target.theoremLabel,
        jobs: {}
      });
  const effectiveStatus = (
    status.status === "unformalized" &&
    job.declarationName &&
    job.recordedProofPath
  )
    ? await getLeaProofStatusFromEntry({
      leaRepoPath: state.settings.leaRepoPath,
      target,
      entry: {
        name: job.declarationName,
        proofPath: job.recordedProofPath,
        moduleName: job.moduleName || null
      }
    })
    : status;
  let proofComplete = effectiveStatus.status === "formalized";
  if (proofComplete && effectiveStatus.absolutePath) {
    job.leanCheck = await runLeanCheck(job.leaWorkspacePath, effectiveStatus.absolutePath);
    proofComplete = job.leanCheck.ok;
  }
  const nextJobStatus = exit.ok && proofComplete ? "formalized" : "failed";
  job.stubbedTheoremUses = nextJobStatus === "formalized"
    ? await findImportedStubbedTheoremUses({
      proofPath: effectiveStatus.absolutePath,
      resolvedUses: job.theoremUses || []
    })
    : [];
  job.finalStatus = effectiveStatus.status;
  job.apiRunId = exit.apiRunId || job.apiRunId || null;
  job.exitCode = nextJobStatus === "formalized" ? 0 : 1;
  job.timedOut = exit.timedOut;
  if (nextJobStatus === "failed") {
    job.error = exit.error ||
      artifact?.error ||
      job.leanCheck?.message ||
      `Lea API run completed but final status is ${effectiveStatus.status}.`;
  }
  job.finishedAt = new Date().toISOString();
  const exitSummary = exit.timedOut
    ? `Lea timed out after ${job.leaJobTimeoutSeconds} seconds`
    : `Lea API run ${exit.ok ? "completed" : "failed"}`;
  await appendLog(job.logPath, `\n[backend] ${exitSummary}; final status ${effectiveStatus.status}\n`);
  if (job.error) {
    await appendLog(job.logPath, `[backend] ${job.error}\n`);
  }
  job.status = nextJobStatus;
  await writeJson(state.jobsPath, state.jobs);
}

function buildLeaPrompt({ projectSlug, theoremLabel, theoremText, theoremContext = "", declarationNameHint, resolvedUses = [] }) {
  const naming = declarationNameHint
    ? `The theorem text appears to specify Lean declaration name ${declarationNameHint}; use that name.`
    : `If the theorem text does not specify a Lean declaration name, use ${theoremLabel}.`;
  const proofTarget = declarationNameHint || theoremLabel;
  const usesGuidance = resolvedUses.length === 0
    ? ""
    : `\n${resolvedUses.map((use) => (
      `To formalize the theorem make use of the ${use.declarationName} theorem at ${use.absolutePath}.`
    )).join("\n")}\n`;
  const formalizationGuidance = theoremContext.trim()
    ? `\nFormalization Guidance: ${theoremContext.trim()}\n`
    : "";

  return `Formalize the Overleaf theorem labeled ${theoremLabel} in project ${projectSlug}.
${naming}
${usesGuidance}

${theoremText}
${formalizationGuidance}

The final file must compile with no sorry/admit in theorem ${proofTarget}.
Use the Lea project context to choose the project namespace and proof path.
Do not edit the project markdown during proof search; Lea will record the final result after the proof succeeds.
Do not create placeholder files outside Lea's workspace. If you cannot complete the proof, leave the best partial Lean file in the Lea project proof directory.`;
}

async function runLeaApiProofJob({
  fetchImpl,
  baseUrl,
  apiKey,
  model,
  maxTurns,
  providerApiKey,
  prompt,
  project,
  logPath,
  timeoutMs,
  onUsageUpdated = null,
  onProgressUpdated = null
}) {
  const startResponse = await startLeaApiRun({
    fetchImpl,
    baseUrl,
    apiKey,
    model,
    maxTurns,
    providerApiKey,
    prompt,
    project,
    permissionTier: "none"
  });
  if (!startResponse.ok) {
    return { ok: false, timedOut: false, error: startResponse.error };
  }

  const apiRunId = startResponse.body?.run_id;
  if (!apiRunId) {
    return { ok: false, timedOut: false, error: "Lea API did not return a run_id." };
  }
  await appendLog(logPath, `[backend] Lea API run started: ${apiRunId}\n`);

  return waitForLeaApiProofJob({
    fetchImpl,
    baseUrl,
    apiKey,
    apiRunId,
    maxTurns,
    logPath,
    timeoutMs,
    onUsageUpdated,
    onProgressUpdated
  });
}

async function runLeaApiApprovalStubJob({
  fetchImpl,
  baseUrl,
  apiKey,
  model,
  maxTurns,
  providerApiKey,
  prompt,
  project,
  logPath,
  timeoutMs,
  onUsageUpdated = null,
  onProgressUpdated = null
}) {
  const startResponse = await startLeaApiRun({
    fetchImpl,
    baseUrl,
    apiKey,
    model,
    maxTurns,
    providerApiKey,
    prompt,
    project,
    permissionTier: "theorem_translation"
  });
  if (!startResponse.ok) {
    return { ok: false, timedOut: false, error: startResponse.error };
  }

  const apiRunId = startResponse.body?.run_id;
  if (!apiRunId) {
    return { ok: false, timedOut: false, error: "Lea API did not return a run_id." };
  }
  await appendLog(logPath, `[backend] Lea API theorem-translation run started: ${apiRunId}\n`);

  return waitForLeaApiApprovalPause({
    fetchImpl,
    baseUrl,
    apiKey,
    apiRunId,
    maxTurns,
    logPath,
    timeoutMs,
    onUsageUpdated,
    onProgressUpdated
  });
}

async function startLeaApiRun({
  fetchImpl,
  baseUrl,
  apiKey,
  model,
  maxTurns,
  providerApiKey,
  prompt,
  project,
  permissionTier
}) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const body = {
    task: prompt,
    config: {
      model: {
        name: model,
        model_kwargs: {
          max_tokens: DEFAULT_LEA_MODEL_MAX_TOKENS,
          ...(providerApiKey ? { api_key: providerApiKey } : {})
        }
      },
      agent: {
        max_turns: maxTurns,
        narrate_tool_steps: false,
        permission_tier: permissionTier,
        theorem_translation_max_retries: 3
      }
    },
    project
  };

  return fetchJson(fetchImpl, `${baseUrl}/v1/runs`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
}

async function waitForLeaApiProofJob({
  fetchImpl,
  baseUrl,
  apiKey,
  apiRunId,
  maxTurns,
  logPath,
  timeoutMs,
  onUsageUpdated = null,
  onProgressUpdated = null,
  refTimers = false
}) {
  const started = Date.now();
  const usageAbort = new AbortController();
  const eventsPromise = tailLeaRunUsageEvents({
    fetchImpl,
    baseUrl,
    apiKey,
    apiRunId,
    logPath,
    maxTurns,
    onUsageUpdated,
    onProgressUpdated,
    signal: usageAbort.signal
  });

  while (Date.now() - started < timeoutMs) {
    await delay(Math.min(1000, Math.max(1, timeoutMs - (Date.now() - started))), { ref: refTimers });
    const statusResponse = await fetchJson(fetchImpl, `${baseUrl}/v1/runs/${encodeURIComponent(apiRunId)}`, {
      method: "GET",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
    });
    if (!statusResponse.ok) {
      usageAbort.abort();
      return { ok: false, timedOut: false, apiRunId, error: statusResponse.error };
    }

    const run = statusResponse.body || {};
    await notifyTurnProgress(onProgressUpdated, run, maxTurns);
    const status = String(run.status || run.state || "").toLowerCase();
    const message = extractRunMessage(run);
    if (message) {
      await appendLog(logPath, `[lea-api] ${message}\n`);
    }
    if (["completed", "succeeded", "success", "done"].includes(status)) {
      const reason = String(run.result?.reason || "").toLowerCase();
      if (reason && !["success", "succeeded", "done", "completed"].includes(reason)) {
        usageAbort.abort();
        await settleUsageEvents(eventsPromise);
        return {
          ok: false,
          timedOut: false,
          apiRunId,
          error: message || `Lea API completed with reason: ${reason}`,
          ...extractRunUsage(run)
        };
      }
      usageAbort.abort();
      await settleUsageEvents(eventsPromise);
      return { ok: true, timedOut: false, apiRunId, ...extractRunUsage(run) };
    }
    if (["failed", "error", "cancelled", "canceled", "timeout", "timed_out"].includes(status)) {
      usageAbort.abort();
      await settleUsageEvents(eventsPromise);
      return {
        ok: false,
        timedOut: false,
        apiRunId,
        error: message || `Lea API status: ${status}`,
        ...extractRunUsage(run)
      };
    }
  }

  usageAbort.abort();
  return { ok: false, timedOut: true, apiRunId, error: "Lea API run timed out." };
}

async function waitForLeaApiApprovalPause({
  fetchImpl,
  baseUrl,
  apiKey,
  apiRunId,
  maxTurns,
  logPath,
  timeoutMs,
  onUsageUpdated = null,
  onProgressUpdated = null,
  refTimers = true
}) {
  const started = Date.now();
  const usageAbort = new AbortController();
  const eventsPromise = tailLeaRunUsageEvents({
    fetchImpl,
    baseUrl,
    apiKey,
    apiRunId,
    logPath,
    maxTurns,
    onUsageUpdated,
    onProgressUpdated,
    signal: usageAbort.signal
  });

  while (Date.now() - started < timeoutMs) {
    await delay(Math.min(1000, Math.max(1, timeoutMs - (Date.now() - started))), { ref: refTimers });
    const statusResponse = await getLeaApiRun({ fetchImpl, baseUrl, apiKey, apiRunId });
    if (!statusResponse.ok) {
      usageAbort.abort();
      return { ok: false, timedOut: false, apiRunId, error: statusResponse.error };
    }

    const run = statusResponse.body || {};
    await notifyTurnProgress(onProgressUpdated, run, maxTurns);
    const status = String(run.status || run.state || "").toLowerCase();
    const message = extractRunMessage(run);
    if (message) {
      await appendLog(logPath, `[lea-api] ${message}\n`);
    }
    if (status === "paused" && run.pending_approval?.type === "approval_requested") {
      usageAbort.abort();
      await settleUsageEvents(eventsPromise);
      return {
        ok: true,
        timedOut: false,
        apiRunId,
        approval: run.pending_approval,
        ...extractRunUsage(run)
      };
    }
    if (["completed", "succeeded", "success", "done"].includes(status)) {
      usageAbort.abort();
      await settleUsageEvents(eventsPromise);
      return {
        ok: false,
        timedOut: false,
        apiRunId,
        error: message || "Lea completed without pausing for theorem approval.",
        ...extractRunUsage(run)
      };
    }
    if (["failed", "error", "cancelled", "canceled", "timeout", "timed_out"].includes(status)) {
      usageAbort.abort();
      await settleUsageEvents(eventsPromise);
      return {
        ok: false,
        timedOut: false,
        apiRunId,
        error: message || `Lea API status: ${status}`,
        ...extractRunUsage(run)
      };
    }
  }

  usageAbort.abort();
  return { ok: false, timedOut: true, apiRunId, error: "Lea API run timed out waiting for theorem approval." };
}

function getLeaApiRun({ fetchImpl, baseUrl, apiKey, apiRunId }) {
  return fetchJson(fetchImpl, `${baseUrl}/v1/runs/${encodeURIComponent(apiRunId)}`, {
    method: "GET",
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
  });
}

function acceptLeaApproval({ fetchImpl, baseUrl, apiKey, apiRunId, approvalId }) {
  return fetchJson(fetchImpl, `${baseUrl}/v1/runs/${encodeURIComponent(apiRunId)}/approvals/${encodeURIComponent(approvalId)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({ decision: "accept" })
  });
}

async function tailLeaRunUsageEvents({
  fetchImpl,
  baseUrl,
  apiKey,
  apiRunId,
  logPath,
  maxTurns,
  onUsageUpdated,
  onProgressUpdated,
  signal
}) {
  if (!onUsageUpdated && !onProgressUpdated) return;

  try {
    const response = await fetchImpl(`${baseUrl}/v1/runs/${encodeURIComponent(apiRunId)}/events`, {
      method: "GET",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal
    });
    if (!response?.ok || !response.body) {
      return;
    }

    let buffer = "";
    for await (const chunk of iterateResponseBody(response.body)) {
      buffer += decodeChunk(chunk);
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || "";
      for (const frame of frames) {
        const shouldContinue = await handleLeaEventFrame(frame, { maxTurns, onUsageUpdated, onProgressUpdated });
        if (!shouldContinue) return;
      }
    }
    if (buffer.trim()) {
      await handleLeaEventFrame(buffer, { maxTurns, onUsageUpdated, onProgressUpdated });
    }
  } catch (error) {
    if (error?.name === "AbortError") return;
    await appendLog(logPath, `[backend] Lea usage event stream unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

async function handleLeaEventFrame(frame, { maxTurns, onUsageUpdated, onProgressUpdated }) {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n")
    .trim();
  if (!data) return true;

  let event;
  try {
    event = JSON.parse(data);
  } catch {
    return true;
  }

  await notifyTurnProgress(onProgressUpdated, event, maxTurns);

  if (event.type === "usage_updated") {
    if (onUsageUpdated) {
      await onUsageUpdated({
        inputTokens: event.input_tokens,
        outputTokens: event.output_tokens,
        totalTokens: toNonNegativeNumber(event.input_tokens) + toNonNegativeNumber(event.output_tokens),
        costUsd: event.cost,
        delta: true
      });
    }
    return true;
  }
  if (event.type === "finished") {
    if (onUsageUpdated && (event.usage || event.cost !== undefined)) {
      await onUsageUpdated(extractEventUsage(event));
    }
    return false;
  }
  if (event.type === "error") {
    return false;
  }
  return true;
}

function extractEventUsage(event) {
  const usage = event?.usage || event || {};
  const inputTokens = toNonNegativeNumber(usage.input_tokens);
  const outputTokens = toNonNegativeNumber(usage.output_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd: toNonNegativeNumber(event?.cost)
  };
}

async function notifyTurnProgress(onProgressUpdated, payload, defaultMaxTurns = null) {
  if (!onProgressUpdated) return;
  const progress = extractTurnProgress(payload, defaultMaxTurns);
  if (!progress) return;
  await onProgressUpdated(progress);
}

async function settleUsageEvents(eventsPromise) {
  if (!eventsPromise) return;
  try {
    await Promise.race([eventsPromise, delay(25)]);
  } catch {
    // Usage events are best-effort; terminal run polling remains authoritative.
  }
}

async function* iterateResponseBody(body) {
  if (body?.[Symbol.asyncIterator]) {
    yield* body;
    return;
  }
  if (!body?.getReader) return;

  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock?.();
  }
}

function decodeChunk(chunk) {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return new TextDecoder().decode(chunk);
  return String(chunk);
}

function extractRunMessage(run) {
  return run.final_text || run.error || run.message || run.result?.text || "";
}

function extractRunUsage(run) {
  const usage = run?.result?.usage || {};
  const inputTokens = toNonNegativeNumber(usage.input_tokens);
  const outputTokens = toNonNegativeNumber(usage.output_tokens);
  const costUsd = toNonNegativeNumber(run?.result?.cost);
  return {
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens
    },
    costUsd
  };
}

function recordJobUsage(job, exit) {
  if (!exit?.usage) return;
  recordJobUsageSnapshot(job, {
    ...exit.usage,
    costUsd: exit.costUsd
  });
}

function recordJobUsageSnapshot(job, usage) {
  job.usage = {
    inputTokens: toNonNegativeNumber(usage.inputTokens),
    outputTokens: toNonNegativeNumber(usage.outputTokens),
    totalTokens: toNonNegativeNumber(usage.totalTokens) ||
      toNonNegativeNumber(usage.inputTokens) + toNonNegativeNumber(usage.outputTokens)
  };
  job.costUsd = toNonNegativeNumber(usage.costUsd);
}

function recordJobUsageDelta(job, usage) {
  const current = job.usage || {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0
  };
  const inputTokens = toNonNegativeNumber(current.inputTokens) + toNonNegativeNumber(usage.inputTokens);
  const outputTokens = toNonNegativeNumber(current.outputTokens) + toNonNegativeNumber(usage.outputTokens);
  job.usage = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens
  };
  job.costUsd = Number((toNonNegativeNumber(job.costUsd) + toNonNegativeNumber(usage.costUsd)).toFixed(6));
}

function recordJobTurnProgress(job, progress) {
  const current = toPositiveInteger(progress?.current);
  const max = toPositiveInteger(progress?.max) || toPositiveInteger(job.leaMaxTurns);
  if (!current || !max) return false;
  if (job.leaCurrentTurn === current && job.leaMaxTurns === max) return false;
  job.leaCurrentTurn = current;
  job.leaMaxTurns = max;
  return true;
}

function extractTurnProgress(payload, defaultMaxTurns = null) {
  const current = firstPositiveInteger(payload, [
    "current_turn",
    "currentTurn",
    "turn",
    "turn_index",
    "turnIndex",
    "agent_turn",
    "agentTurn"
  ]);
  const max = firstPositiveInteger(payload, [
    "max_turns",
    "maxTurns",
    "maximum_turns",
    "maximumTurns"
  ]) || toPositiveInteger(defaultMaxTurns);
  if (!current || !max) return null;
  return { current, max };
}

function firstPositiveInteger(payload, keys) {
  for (const source of turnProgressSources(payload)) {
    for (const key of keys) {
      const value = toPositiveInteger(source?.[key]);
      if (value) return value;
    }
  }
  return 0;
}

function turnProgressSources(payload) {
  if (!payload || typeof payload !== "object") return [];
  return [
    payload,
    payload.progress,
    payload.result,
    payload.result?.progress,
    payload.agent,
    payload.agent?.progress
  ].filter((source) => source && typeof source === "object");
}

function aggregateUsage(jobs, { overleafProjectId } = {}) {
  const projectSlug = overleafProjectId ? slugProjectId(overleafProjectId) : "";
  const aggregate = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    runCount: 0
  };

  for (const job of Object.values(jobs || {})) {
    if (overleafProjectId && job.overleafProjectId !== overleafProjectId && job.projectSlug !== projectSlug) {
      continue;
    }
    if (!job.usage) {
      continue;
    }
    aggregate.inputTokens += toNonNegativeNumber(job.usage.inputTokens);
    aggregate.outputTokens += toNonNegativeNumber(job.usage.outputTokens);
    aggregate.totalTokens += toNonNegativeNumber(job.usage.totalTokens);
    aggregate.costUsd += toNonNegativeNumber(job.costUsd);
    aggregate.runCount += 1;
  }

  aggregate.costUsd = Number(aggregate.costUsd.toFixed(6));
  return aggregate;
}

function toNonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function toPositiveInteger(value) {
  const number = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(number) && number >= 1 ? number : 0;
}

function normalizeLeaMaxTurns(value) {
  const parsed = Number.parseInt(String(value || DEFAULT_LEA_MAX_TURNS), 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_LEA_MAX_TURNS;
}

async function fetchJson(fetchImpl, url, options) {
  try {
    const response = await fetchImpl(url, options);
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;
    if (!response.ok) {
      return { ok: false, error: `Lea API returned HTTP ${response.status}: ${text}` };
    }
    return { ok: true, body };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function runLeanCheck(leaWorkspacePath, proofPath) {
  return new Promise((resolve) => {
    const child = spawn("lake", ["env", "lean", proofPath], {
      cwd: leaWorkspacePath,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({
        ok: false,
        exitCode: null,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        message: "Lean check timed out."
      });
    }, 60_000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: null,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        message: error.message
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      resolve({
        ok: code === 0,
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        message: code === 0 ? "Lean check passed." : output || `Lean exited with code ${code}.`
      });
    });
  });
}

function normalizeLeaApiBaseUrl(value) {
  const text = String(value || DEFAULT_LEA_API_BASE_URL).trim().replace(/\/+$/, "");
  const parsed = new URL(text);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Lea API base URL must be http(s).");
  }
  return text;
}

function delay(ms, { ref = true } = {}) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (!ref) {
      timer.unref?.();
    }
  });
}

async function appendLog(logPath, text) {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, text, "utf8");
}

async function readLogTail(logPath, maxChars = 4000) {
  try {
    const content = await fs.readFile(logPath, "utf8");
    return content.slice(-maxChars);
  } catch {
    return "";
  }
}

function buildJobResponse({ job, status, target }) {
  const declarationName = job.declarationName || target.declarationName || target.theoremLabel;
  const response = {
    status,
    jobId: job.jobId,
    theoremLabel: target.theoremLabel,
    declarationName,
    relativePath: job.recordedProofPath || target.relativePath,
    absolutePath: job.recordedProofPath
      ? buildLeaProofPath({ leaRepoPath: job.leaRepoPath, proofPath: job.recordedProofPath }) || target.absolutePath
      : target.absolutePath,
    projectId: target.projectId,
    projectSlug: target.projectSlug,
    projectMarkdownPath: target.projectMarkdownPath,
    recordedProofPath: job.recordedProofPath || null,
    moduleName: job.moduleName || null,
    logTail: "",
    startedAt: job.startedAt,
    finishedAt: job.finishedAt
  };
  addStubbedTheoremUses(response, job.stubbedTheoremUses);
  const turnProgress = buildTurnProgress(job, status);
  if (turnProgress) {
    response.turnProgress = turnProgress;
  }
  return response;
}

function addStubbedTheoremUses(response, stubbedTheoremUses) {
  if (!Array.isArray(stubbedTheoremUses) || stubbedTheoremUses.length === 0) {
    return response;
  }
  response.stubbedTheoremUses = stubbedTheoremUses;
  response.hasStubbedTheoremUses = true;
  return response;
}

function buildTurnProgress(job, status) {
  if (status !== "in_progress") return null;
  const current = toPositiveInteger(job.leaCurrentTurn);
  const max = toPositiveInteger(job.leaMaxTurns);
  if (!current || !max) return null;
  return { current, max };
}

async function findImportedStubbedTheoremUses({ proofPath, resolvedUses = [] }) {
  const stubbedUses = resolvedUses.filter((use) => use?.status === "sorry_stub" && use.moduleName);
  if (!proofPath || stubbedUses.length === 0) {
    return [];
  }

  let content = "";
  try {
    content = await fs.readFile(proofPath, "utf8");
  } catch {
    return [];
  }

  const imports = parseLeanImports(content);
  return stubbedUses
    .filter((use) => imports.has(use.moduleName))
    .map((use) => ({
      theoremLabel: use.theoremLabel,
      declarationName: use.declarationName,
      moduleName: use.moduleName,
      relativePath: use.relativePath || "",
      absolutePath: use.absolutePath || ""
    }));
}

async function findImportedCurrentlyStubbedTheoremUses({
  leaRepoPath,
  overleafProjectId,
  proofPath,
  resolvedUses = [],
  jobs = {}
}) {
  const candidateUses = resolvedUses
    .map((use) => ({
      theoremLabel: String(use?.theoremLabel || "").trim(),
      moduleName: use?.moduleName || null
    }))
    .filter((use) => use.theoremLabel && use.moduleName);
  if (!proofPath || candidateUses.length === 0) {
    return [];
  }

  let content = "";
  try {
    content = await fs.readFile(proofPath, "utf8");
  } catch {
    return [];
  }

  const imports = parseLeanImports(content);
  const importedUses = candidateUses.filter((use) => imports.has(use.moduleName));
  if (importedUses.length === 0) {
    return [];
  }

  const stubbedUses = [];
  for (const use of importedUses) {
    const status = getEquivalentTheoremStatus(await getCurrentTheoremProofStatus({
      leaRepoPath,
      overleafProjectId,
      theoremLabel: use.theoremLabel,
      jobs
    }));
    if (status?.status !== "sorry_stub") {
      continue;
    }

    stubbedUses.push({
      theoremLabel: use.theoremLabel,
      declarationName: status.declarationName,
      moduleName: status.moduleName || use.moduleName,
      relativePath: status.recordedProofPath || status.relativePath || "",
      absolutePath: status.absolutePath || ""
    });
  }

  return stubbedUses;
}

function parseLeanImports(content) {
  const imports = new Set();
  for (const line of String(content || "").split(/\r?\n/)) {
    const match = line.match(/^\s*import\s+(.+?)\s*(?:--.*)?$/);
    if (!match) continue;
    for (const moduleName of match[1].trim().split(/\s+/)) {
      if (moduleName) {
        imports.add(moduleName);
      }
    }
  }
  return imports;
}

async function getTheoremStatus({
  leaRepoPath,
  overleafProjectId = "unknown",
  theoremLabel,
  jobs = {}
}) {
  const target = buildLeaTarget({ leaRepoPath, overleafProjectId, theoremLabel });
  const { projectStatus, directProofStatus, mappedStatus } = await getCurrentTheoremProofStatuses({
    leaRepoPath,
    target,
    jobs,
    includeStubbedTheoremUses: true
  });
  const failedJob = findLatestJob(jobs, target.jobKey, "failed");

  const activeJob = findActiveJob(jobs, target.jobKey);
  if (activeJob) {
    if (
      mappedStatus?.status === "formalized" ||
      projectStatus?.status === "formalized" ||
      directProofStatus?.status === "formalized"
    ) {
      return mappedStatus?.status === "formalized"
        ? mappedStatus
        : projectStatus?.status === "formalized"
          ? projectStatus
          : directProofStatus;
    }
    return buildJobResponse({ job: activeJob, status: "in_progress", target });
  }

  if (mappedStatus?.status === "formalized") {
    return mappedStatus;
  }

  if (directProofStatus?.status === "formalized") {
    return directProofStatus;
  }

  if (failedJob) {
    return buildFailedTheoremStatus({
      failedJob,
      target,
      equivalentStatus: mappedStatus || projectStatus || directProofStatus,
      logTail: await readLogTail(failedJob.logPath)
    });
  }

  if (mappedStatus) {
    return mappedStatus;
  }

  if (projectStatus) {
    return projectStatus;
  }
  if (directProofStatus) {
    return directProofStatus;
  }

  return {
    status: "unformalized",
    theoremLabel,
    declarationName: theoremLabel,
    relativePath: target.relativePath,
    absolutePath: target.absolutePath,
    projectId: target.projectId,
    projectSlug: target.projectSlug,
    projectMarkdownPath: target.projectMarkdownPath
  };
}

async function getCurrentTheoremProofStatuses({
  leaRepoPath,
  target,
  jobs = {},
  includeStubbedTheoremUses = false
}) {
  const projectStatus = await getLeaProjectTheoremStatus({ leaRepoPath, target });
  const directProofStatus = await getLeaDirectProofStatus({ leaRepoPath, target });
  const mappedStatus = await getLatestMappedJobStatus({
    leaRepoPath,
    target,
    jobs,
    includeStubbedTheoremUses
  });
  return { projectStatus, directProofStatus, mappedStatus };
}

async function getCurrentTheoremProofStatus({
  leaRepoPath,
  overleafProjectId = "unknown",
  theoremLabel,
  jobs = {}
}) {
  const target = buildLeaTarget({ leaRepoPath, overleafProjectId, theoremLabel });
  const { mappedStatus, projectStatus, directProofStatus } = await getCurrentTheoremProofStatuses({
    leaRepoPath,
    target,
    jobs
  });
  return mappedStatus || projectStatus || directProofStatus || {
    status: "unformalized",
    theoremLabel,
    declarationName: theoremLabel,
    relativePath: target.relativePath,
    absolutePath: target.absolutePath,
    projectId: target.projectId,
    projectSlug: target.projectSlug,
    projectMarkdownPath: target.projectMarkdownPath
  };
}

function buildFailedTheoremStatus({ failedJob, target, equivalentStatus, logTail = "" }) {
  const fallback = buildJobResponse({ job: failedJob, status: "failed", target });
  const effectiveStatus = failedJob.finalStatus === "sorry_stub" && failedJob.declarationName && failedJob.recordedProofPath
    ? "sorry_stub"
    : equivalentStatus?.status === "sorry_stub"
      ? "sorry_stub"
      : "unformalized";
  const base = effectiveStatus === "sorry_stub" && equivalentStatus?.status === "sorry_stub"
    ? { ...fallback, ...equivalentStatus }
    : fallback;

  return {
    ...base,
    status: "failed",
    effectiveStatus,
    jobId: failedJob.jobId,
    logTail,
    startedAt: failedJob.startedAt,
    finishedAt: failedJob.finishedAt
  };
}

function getEquivalentTheoremStatus(status) {
  if (status?.status !== "failed") {
    return status || { status: "unformalized" };
  }
  return {
    ...status,
    status: status.effectiveStatus || "unformalized"
  };
}

async function getLeaProjectTheoremStatus({ leaRepoPath, target }) {
  if (!leaRepoPath || !path.isAbsolute(leaRepoPath)) {
    return null;
  }
  if (!existsSync(target.projectMarkdownPath)) {
    return null;
  }

  const markdown = await fs.readFile(target.projectMarkdownPath, "utf8");
  const entry = findProjectTheoremEntry(markdown, target.declarationName || target.theoremLabel);
  if (!entry) {
    return null;
  }

  return getLeaProofStatusFromEntry({ leaRepoPath, target, entry });
}

async function getLeaProofStatusFromEntry({ leaRepoPath, target, entry }) {
  const absolutePath = buildLeaProofPath({ leaRepoPath, proofPath: entry.proofPath });
  const responseBase = {
    theoremLabel: target.theoremLabel,
    declarationName: entry.name,
    relativePath: entry.proofPath,
    absolutePath: absolutePath || "",
    projectId: target.projectId,
    projectSlug: target.projectSlug,
    projectMarkdownPath: target.projectMarkdownPath,
    recordedProofPath: entry.proofPath,
    moduleName: entry.moduleName || null
  };

  if (!absolutePath || !existsSync(absolutePath)) {
    return {
      status: "unformalized",
      ...responseBase,
      message: "Project markdown entry exists, but the recorded proof file is missing."
    };
  }

  const content = await fs.readFile(absolutePath, "utf8");
  if (/\bsorry\b|admit\b/.test(content)) {
    return {
      status: "sorry_stub",
      ...responseBase,
      leanStatement: extractLeanStatement(content, entry.name)
    };
  }

  return {
    status: "formalized",
    ...responseBase,
    leanStatement: extractLeanStatement(content, entry.name)
  };
}

async function getLeaDirectProofStatus({ leaRepoPath, target }) {
  const declarationName = target.declarationName || target.theoremLabel;
  const proofPath = path.join("workspace", "proofs", `${declarationName}.lean`);
  const absolutePath = buildLeaProofPath({ leaRepoPath, proofPath });
  if (!absolutePath || !existsSync(absolutePath)) {
    return null;
  }

  const content = await fs.readFile(absolutePath, "utf8");
  if (!containsDeclaration(content, declarationName)) {
    return null;
  }

  const responseBase = {
    theoremLabel: target.theoremLabel,
    declarationName,
    relativePath: proofPath,
    absolutePath,
    projectId: target.projectId,
    projectSlug: target.projectSlug,
    projectMarkdownPath: target.projectMarkdownPath,
    recordedProofPath: proofPath,
    moduleName: null
  };

  if (/\bsorry\b|admit\b/.test(content)) {
    return {
      status: "sorry_stub",
      ...responseBase,
      leanStatement: extractLeanStatement(content, declarationName)
    };
  }

  return {
    status: "formalized",
    ...responseBase,
    leanStatement: extractLeanStatement(content, declarationName)
  };
}

async function getLatestMappedJobStatus({
  leaRepoPath,
  target,
  jobs,
  includeStubbedTheoremUses = false
}) {
  const mappedJob = Object.values(jobs || {})
    .filter((job) => (
      job.jobKey === target.jobKey &&
      ["formalized", "sorry_stub"].includes(job.status) &&
      job.declarationName &&
      job.recordedProofPath
    ))
    .sort((a, b) => String(b.finishedAt || b.startedAt).localeCompare(String(a.finishedAt || a.startedAt)))[0] || null;

  if (!mappedJob) {
    return null;
  }

  const status = await getLeaProofStatusFromEntry({
    leaRepoPath,
    target,
    entry: {
      name: mappedJob.declarationName,
      proofPath: mappedJob.recordedProofPath,
      moduleName: mappedJob.moduleName || null
    }
  });
  if (!includeStubbedTheoremUses) {
    return status;
  }
  const stubbedTheoremUses = status.status === "formalized"
    ? await findImportedCurrentlyStubbedTheoremUses({
      leaRepoPath,
      overleafProjectId: target.projectId,
      proofPath: status.absolutePath,
      resolvedUses: Array.isArray(mappedJob.theoremUses) && mappedJob.theoremUses.length > 0
        ? mappedJob.theoremUses
        : mappedJob.stubbedTheoremUses || [],
      jobs
    })
    : [];
  return addStubbedTheoremUses(status, stubbedTheoremUses);
}

function findProjectTheoremEntry(markdown, theoremLabel) {
  for (const entry of parseProjectTheoremEntries(markdown)) {
    if (entry.name !== theoremLabel) {
      continue;
    }
    return entry;
  }
  return null;
}

async function identifyLeaArtifact({ leaRepoPath, target, beforeMarkers, job }) {
  const afterMarkers = await readProjectTheoremEntries(target.projectMarkdownPath);
  if (afterMarkers.length === 0) {
    return null;
  }

  const beforeKeys = new Set(beforeMarkers.map(markerKey));
  const newMarkers = afterMarkers.filter((entry) => !beforeKeys.has(markerKey(entry)));
  const newResult = selectLeaArtifactCandidate({
    candidates: newMarkers,
    job,
    ambiguousMessage: "Lea recorded multiple new theorem entries; could not uniquely identify Lea output."
  });
  if (newResult) {
    return newResult;
  }

  const changedMarkers = [];
  const beforeByName = new Map(beforeMarkers.map((entry) => [entry.name, entry]));
  for (const entry of afterMarkers) {
    const before = beforeByName.get(entry.name);
    if (!before || markerKey(before) === markerKey(entry)) {
      continue;
    }
    if (await proofFileTouchedAfter({ leaRepoPath, proofPath: entry.proofPath, isoTime: job.startedAt })) {
      changedMarkers.push(entry);
    }
  }

  return selectLeaArtifactCandidate({
    candidates: changedMarkers,
    job,
    ambiguousMessage: "Lea changed multiple theorem entries; could not uniquely identify Lea output."
  });
}

function selectLeaArtifactCandidate({ candidates, job, ambiguousMessage }) {
  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length === 1) {
    return { ok: true, entry: candidates[0] };
  }

  if (job.declarationNameHint) {
    const hinted = candidates.filter((entry) => entry.name === job.declarationNameHint);
    if (hinted.length === 1) {
      return { ok: true, entry: hinted[0] };
    }
  }

  return {
    ok: false,
    error: `${ambiguousMessage} Candidates: ${candidates.map((entry) => entry.name).join(", ")}.`
  };
}

async function persistStubApproval({ leaRepoPath, target, theoremText, theoremContext = "", approval }) {
  const leanCode = String(approval?.lean_code || "").trim();
  if (!leanCode) {
    throw new Error("Lea approval did not include Lean code.");
  }
  const declarationName = String(approval?.theorem_name || "").trim() ||
    inferLeanDeclarationName(leanCode) ||
    inferLeanDeclarationName(theoremText) ||
    target.theoremLabel;
  if (!isValidLeanIdentifier(declarationName)) {
    throw new Error(`Lea approval returned an invalid theorem name: ${declarationName}.`);
  }

  const proofPath = stubProofPath({ projectSlug: target.projectSlug, declarationName });
  const absolutePath = buildLeaProofPath({ leaRepoPath, proofPath });
  if (!absolutePath) {
    throw new Error("Could not resolve Lea stub proof path.");
  }
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${leanCode}\n`, "utf8");

  const moduleName = moduleNameFromProofPath(proofPath);
  await upsertProjectTheoremEntry({
    projectMarkdownPath: target.projectMarkdownPath,
    projectId: target.projectSlug,
    theoremName: declarationName,
    proofPath,
    moduleName,
    signature: extractLeanStatement(leanCode, declarationName) || `${declarationName} := by sorry`,
    description: theoremText,
    solvingProcess: [
      "Stub generated from Lea theorem-translation approval.",
      theoremContext ? `Formalization guidance: ${theoremContext}` : "",
      approval.check_result ? `Lean check: ${approval.check_result}` : ""
    ].filter(Boolean).join("\n\n")
  });

  return { name: declarationName, proofPath, moduleName };
}

function stubProofPath({ projectSlug, declarationName }) {
  const projectPart = projectNamespacePart(projectSlug);
  return path.join("workspace", "proofs", "Lea", projectPart, `${declarationName}.lean`);
}

function projectNamespacePart(projectSlug) {
  const part = String(projectSlug || "Project")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((token) => `${token.slice(0, 1).toUpperCase()}${token.slice(1)}`)
    .join("");
  const candidate = part || "Project";
  return /^[A-Za-z_]/.test(candidate) ? candidate : `Project${candidate}`;
}

function moduleNameFromProofPath(proofPath) {
  const parts = String(proofPath || "").split(/[\\/]+/);
  const proofsIndex = parts.indexOf("proofs");
  if (proofsIndex === -1) return null;
  const moduleParts = parts.slice(proofsIndex + 1);
  if (moduleParts.length === 0) return null;
  moduleParts[moduleParts.length - 1] = moduleParts[moduleParts.length - 1].replace(/\.lean$/, "");
  return moduleParts.every((part) => /^[A-Za-z_][A-Za-z0-9_']*$/.test(part))
    ? moduleParts.join(".")
    : null;
}

async function upsertProjectTheoremEntry({
  projectMarkdownPath,
  projectId,
  theoremName,
  proofPath,
  moduleName,
  signature,
  description,
  solvingProcess
}) {
  let existing;
  try {
    existing = await fs.readFile(projectMarkdownPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    existing = `# Lea Project: ${projectId}\n\n<!-- lea:project id="${escapeHtmlAttribute(projectId)}" -->\n`;
  }
  const entry = renderProjectTheoremEntry({
    theoremName,
    proofPath,
    moduleName,
    signature,
    description,
    solvingProcess
  });
  const sections = findProjectTheoremSections(existing);
  const section = sections.find((candidate) => candidate.entry.name === theoremName);
  const next = section
    ? `${existing.slice(0, section.start).trimEnd()}\n\n${entry.trimEnd()}\n${existing.slice(section.end).trimStart() ? `\n${existing.slice(section.end).trimStart()}` : ""}`
    : `${existing.trimEnd()}\n\n${entry.trimEnd()}\n`;
  await fs.mkdir(path.dirname(projectMarkdownPath), { recursive: true });
  await fs.writeFile(projectMarkdownPath, next.replace(/\n{3,}/g, "\n\n"), "utf8");
}

function renderProjectTheoremEntry({
  theoremName,
  proofPath,
  moduleName,
  signature,
  description,
  solvingProcess
}) {
  const attrs = [
    `name="${escapeHtmlAttribute(theoremName)}"`,
    `proof="${escapeHtmlAttribute(proofPath)}"`,
    moduleName ? `module="${escapeHtmlAttribute(moduleName)}"` : ""
  ].filter(Boolean).join(" ");
  return `## Theorem: ${theoremName}

<!-- lea:theorem ${attrs} -->

### Signature

\`\`\`lean
${String(signature || "").trim()}
\`\`\`

### Description

${String(description || "(No description recorded.)").trim()}

### Solving Process

${String(solvingProcess || "(No solving summary recorded.)").trim()}

### Lean Location

\`${proofPath}\`
`;
}

async function readProjectTheoremEntries(projectMarkdownPath) {
  try {
    return parseProjectTheoremEntries(await fs.readFile(projectMarkdownPath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function parseProjectTheoremEntries(markdown) {
  const entries = [];
  const markerPattern = /<!--\s*lea:theorem\s+([^>]*?)-->/g;
  for (const match of String(markdown || "").matchAll(markerPattern)) {
    const attrs = parseMarkerAttrs(match[1]);
    if (!attrs.name || !attrs.proof) {
      continue;
    }
    entries.push({
      name: attrs.name,
      proofPath: attrs.proof,
      moduleName: attrs.module || null
    });
  }
  return entries;
}

function findProjectTheoremSections(markdown) {
  const text = String(markdown || "");
  const sections = [];
  const markerPattern = /<!--\s*lea:theorem\s+([^>]*?)-->/g;
  for (const match of text.matchAll(markerPattern)) {
    const attrs = parseMarkerAttrs(match[1]);
    if (!attrs.name || !attrs.proof) {
      continue;
    }

    const markerStart = match.index || 0;
    const headingStart = findSectionHeadingStart(text, markerStart);
    const nextHeading = text.slice(markerStart).search(/\n## Theorem:/);
    sections.push({
      start: headingStart,
      end: nextHeading === -1 ? text.length : markerStart + nextHeading,
      entry: {
        name: attrs.name,
        proofPath: attrs.proof,
        moduleName: attrs.module || null
      }
    });
  }
  return sections;
}

function findSectionHeadingStart(markdown, markerStart) {
  const beforeMarker = markdown.slice(0, markerStart);
  const headingIndex = beforeMarker.lastIndexOf("\n## Theorem:");
  if (headingIndex !== -1) {
    return headingIndex;
  }
  return beforeMarker.startsWith("## Theorem:") ? 0 : markerStart;
}

function markerKey(entry) {
  return `${entry.name}\u0000${entry.proofPath}\u0000${entry.moduleName || ""}`;
}

async function proofFileTouchedAfter({ leaRepoPath, proofPath, isoTime }) {
  const absolutePath = buildLeaProofPath({ leaRepoPath, proofPath });
  if (!absolutePath) {
    return false;
  }
  try {
    const stat = await fs.stat(absolutePath);
    return stat.mtimeMs >= Date.parse(isoTime);
  } catch {
    return false;
  }
}

function parseMarkerAttrs(text) {
  const attrs = {};
  for (const match of String(text || "").matchAll(/([A-Za-z_][A-Za-z0-9_-]*)="([^"]*)"/g)) {
    attrs[match[1]] = unescapeHtmlAttribute(match[2]);
  }
  return attrs;
}

function escapeHtmlAttribute(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function unescapeHtmlAttribute(value) {
  return String(value || "")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function containsDeclaration(content, theoremLabel) {
  const declarationPattern = new RegExp(
    `(^|\\n)\\s*(?:private\\s+|protected\\s+)?(?:theorem|lemma)\\s+${escapeRegExp(theoremLabel)}\\b`
  );
  return declarationPattern.test(content);
}

function extractLeanStatement(content, theoremLabel) {
  const declarationPattern = new RegExp(
    `(^|\\n)\\s*(?:private\\s+|protected\\s+)?(?:theorem|lemma)\\s+${escapeRegExp(theoremLabel)}\\b[\\s\\S]*?:=`
  );
  const match = content.match(declarationPattern);
  if (!match) return "";

  return match[0]
    .replace(/^\n/, "")
    .replace(/\s*:=\s*$/, "")
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readBodyJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sendJson(response, statusCode, body) {
  setCorsHeaders(response);
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function errorResponse(statusCode, error, message) {
  return { statusCode, body: { error, message } };
}

const isMain = fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const dotenv = loadDotEnv(PROJECT_ROOT);
  if (dotenv.loaded) {
    console.log(`Loaded environment from ${dotenv.path}`);
  }
  const server = await createServer();
  server.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
    console.log(`Overleaf Lea companion listening at http://${DEFAULT_HOST}:${DEFAULT_PORT}`);
    console.log(`Lea workspace: ${buildLeaWorkspacePath(applyEnvDefaults({}, process.env).leaRepoPath)}`);
    if (!process.env.OPENAI_API_KEY) {
      console.log("Warning: OPENAI_API_KEY is not set. Lea jobs will not start.");
    }
    console.log("Run `npm run doctor` if setup fails.");
  });
}
