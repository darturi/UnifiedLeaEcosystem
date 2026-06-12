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
const SETTINGS_PATH = path.join(APP_DIR, "settings.json");
const JOBS_PATH = path.join(APP_DIR, "jobs.json");
const JOB_LOG_DIR = path.join(APP_DIR, "jobs");
const DEFAULT_LEA_PROVIDER = "openai";
const DEFAULT_LEA_MODEL = "o4-mini";
const DEFAULT_LEA_API_BASE_URL = "http://127.0.0.1:8000";
const DEFAULT_LEA_MAX_TURNS = 20;
const DEFAULT_LEA_JOB_TIMEOUT_SECONDS = 900;

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

  const { overleafProjectId, theoremLabel, theoremText } = validation;
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

  const cleanup = await cleanupPreviousRunArtifacts({
    leaRepoPath: state.settings.leaRepoPath,
    target,
    theoremText,
    jobs: state.jobs || {}
  });
  const job = await createLeaJob({ state, target, theoremText });
  job.retryCleanup = cleanup;
  state.jobs[job.jobId] = job;
  await writeJson(state.jobsPath, state.jobs);

  runLeaJob({ state, job, target, theoremText }).catch(async (error) => {
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
  const validation = await validateLeaRepo(state.settings.leaRepoPath);
  state.settings.leaWorkspacePath = validation.ok ? validation.leaWorkspacePath : buildLeaWorkspacePath(state.settings.leaRepoPath);
  await writeJson(state.settingsPath, state.settings);
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
    const payload = await readBodyJson(request);
    const leaRepoPath = String(payload.leaRepoPath || "").trim();
    const validation = await validateLeaRepo(leaRepoPath);
    if (!validation.ok) {
      sendJson(response, 400, { error: "invalid_lea_path", message: validation.message });
      return;
    }

    state.settings.leaRepoPath = path.resolve(leaRepoPath);
    state.settings.leaWorkspacePath = validation.leaWorkspacePath;
    state.settings.leaApiBaseUrl = normalizeLeaApiBaseUrl(
      payload.leaApiBaseUrl || state.settings.leaApiBaseUrl || DEFAULT_LEA_API_BASE_URL
    );
    state.settings.leaApiKey = String(payload.leaApiKey || state.settings.leaApiKey || "");
    state.settings.leaProvider = String(payload.leaProvider || DEFAULT_LEA_PROVIDER);
    state.settings.leaModel = String(payload.leaModel || DEFAULT_LEA_MODEL);
    state.settings.leaMaxTurns = Number.parseInt(String(payload.leaMaxTurns || DEFAULT_LEA_MAX_TURNS), 10);
    state.settings.leaJobTimeoutSeconds = Number.parseInt(
      String(payload.leaJobTimeoutSeconds || state.settings.leaJobTimeoutSeconds || DEFAULT_LEA_JOB_TIMEOUT_SECONDS),
      10
    );
    await writeJson(state.settingsPath, state.settings);
    sendJson(response, 200, buildSettingsResponse(state));
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

function buildSettingsResponse(state) {
  const leaRepoPath = state.settings.leaRepoPath || "";
  return {
    ok: true,
    leaRepoPath,
    leaWorkspacePath: leaRepoPath ? buildLeaWorkspacePath(leaRepoPath) : "",
    leaApiBaseUrl: state.settings.leaApiBaseUrl || DEFAULT_LEA_API_BASE_URL,
    leaApiKeyConfigured: Boolean(state.settings.leaApiKey),
    leaProvider: state.settings.leaProvider || DEFAULT_LEA_PROVIDER,
    leaModel: state.settings.leaModel || DEFAULT_LEA_MODEL,
    leaMaxTurns: state.settings.leaMaxTurns || DEFAULT_LEA_MAX_TURNS,
    leaJobTimeoutSeconds: state.settings.leaJobTimeoutSeconds || DEFAULT_LEA_JOB_TIMEOUT_SECONDS
  };
}

function validateLeaPayload(payload) {
  const overleafProjectId = String(payload.overleafProjectId || "");
  const theoremLabel = String(payload.theoremLabel || "");
  const theoremText = String(payload.theoremText || "");
  if (!overleafProjectId.trim()) {
    return { ok: false, error: "missing_project_id", message: "overleafProjectId is required." };
  }
  if (!isValidLeanIdentifier(theoremLabel)) {
    return { ok: false, error: "invalid_label", message: "Theorem label must be a valid Lean identifier." };
  }
  if (!theoremText.trim()) {
    return { ok: false, error: "missing_theorem_text", message: "Theorem text is required." };
  }
  return { ok: true, overleafProjectId, theoremLabel, theoremText };
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
  if (requireApiKey && !state.env?.OPENAI_API_KEY) {
    return { ok: false, error: "missing_openai_key", message: "OPENAI_API_KEY must be set before running Lea." };
  }
  try {
    normalizeLeaApiBaseUrl(state.settings.leaApiBaseUrl || DEFAULT_LEA_API_BASE_URL);
  } catch {
    return { ok: false, error: "invalid_lea_api_url", message: "Lea API base URL must be an absolute http(s) URL." };
  }
  return { ok: true };
}

async function createLeaJob({ state, target, theoremText }) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jobId = `${target.theoremLabel}-${timestamp}`;
  const logPath = path.join(JOB_LOG_DIR, `${jobId}.log`);
  const declarationNameHint = inferLeanDeclarationName(theoremText);

  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, "", "utf8");

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
    theoremTextHash: hashTheoremText(theoremText),
    relativePath: target.relativePath,
    absolutePath: target.absolutePath,
    logPath,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    leaRepoPath: state.settings.leaRepoPath,
    leaWorkspacePath: buildLeaWorkspacePath(state.settings.leaRepoPath),
    leaApiBaseUrl: state.settings.leaApiBaseUrl || DEFAULT_LEA_API_BASE_URL,
    leaApiKeyConfigured: Boolean(state.settings.leaApiKey),
    leaProvider: state.settings.leaProvider || DEFAULT_LEA_PROVIDER,
    leaModel: state.settings.leaModel || DEFAULT_LEA_MODEL,
    leaMaxTurns: state.settings.leaMaxTurns || DEFAULT_LEA_MAX_TURNS,
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

async function runLeaJob({ state, job, target, theoremText }) {
  const beforeMarkers = await readProjectTheoremEntries(target.projectMarkdownPath);
  const prompt = buildLeaPrompt({
    projectSlug: target.projectSlug,
    theoremLabel: target.theoremLabel,
    theoremText,
    declarationNameHint: job.declarationNameHint || ""
  });
  await appendLog(job.logPath, `$ POST ${job.leaApiBaseUrl}/v1/runs\n\n${prompt}\n\n`);
  const exit = await runLeaApiProofJob({
    fetchImpl: state.fetchImpl || fetch,
    baseUrl: job.leaApiBaseUrl,
    apiKey: state.settings.leaApiKey,
    model: job.leaModel,
    maxTurns: job.leaMaxTurns,
    openAiApiKey: state.env?.OPENAI_API_KEY,
    prompt,
    project: {
      project_id: target.projectSlug,
      project_path: target.relativePath,
      record_on_success: true
    },
    logPath: job.logPath,
    timeoutMs: job.leaJobTimeoutSeconds * 1000
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
  let proofComplete = status.status === "formalized";
  if (proofComplete && status.absolutePath) {
    job.leanCheck = await runLeanCheck(job.leaWorkspacePath, status.absolutePath);
    proofComplete = job.leanCheck.ok;
  }
  const nextJobStatus = exit.ok && proofComplete ? "formalized" : "failed";
  job.finalStatus = status.status;
  job.apiRunId = exit.apiRunId || null;
  job.exitCode = nextJobStatus === "formalized" ? 0 : 1;
  job.timedOut = exit.timedOut;
  if (nextJobStatus === "failed") {
    job.error = exit.error ||
      artifact?.error ||
      job.leanCheck?.message ||
      `Lea API run completed but final status is ${status.status}.`;
  }
  job.finishedAt = new Date().toISOString();
  const exitSummary = exit.timedOut
    ? `Lea timed out after ${job.leaJobTimeoutSeconds} seconds`
    : `Lea API run ${exit.ok ? "completed" : "failed"}`;
  await appendLog(job.logPath, `\n[backend] ${exitSummary}; final status ${status.status}\n`);
  if (job.error) {
    await appendLog(job.logPath, `[backend] ${job.error}\n`);
  }
  job.status = nextJobStatus;
  await writeJson(state.jobsPath, state.jobs);
}

function buildLeaPrompt({ projectSlug, theoremLabel, theoremText, declarationNameHint }) {
  const naming = declarationNameHint
    ? `The theorem text appears to specify Lean declaration name ${declarationNameHint}; use that name.`
    : `If the theorem text does not specify a Lean declaration name, use ${theoremLabel}.`;
  const proofTarget = declarationNameHint || theoremLabel;

  return `Formalize the Overleaf theorem labeled ${theoremLabel} in project ${projectSlug}.
${naming}

${theoremText}

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
  openAiApiKey,
  prompt,
  project,
  logPath,
  timeoutMs
}) {
  const started = Date.now();
  const headers = { "Content-Type": "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const body = {
    task: prompt,
    config: {
      model: {
        name: model,
        ...(openAiApiKey ? { model_kwargs: { api_key: openAiApiKey } } : {})
      },
      agent: {
        max_turns: maxTurns,
        narrate_tool_steps: false,
        permission_tier: "none",
        theorem_translation_max_retries: 3
      }
    },
    project
  };

  const startResponse = await fetchJson(fetchImpl, `${baseUrl}/v1/runs`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  if (!startResponse.ok) {
    return { ok: false, timedOut: false, error: startResponse.error };
  }

  const apiRunId = startResponse.body?.run_id;
  if (!apiRunId) {
    return { ok: false, timedOut: false, error: "Lea API did not return a run_id." };
  }
  await appendLog(logPath, `[backend] Lea API run started: ${apiRunId}\n`);

  while (Date.now() - started < timeoutMs) {
    await delay(Math.min(1000, Math.max(1, timeoutMs - (Date.now() - started))));
    const statusResponse = await fetchJson(fetchImpl, `${baseUrl}/v1/runs/${encodeURIComponent(apiRunId)}`, {
      method: "GET",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
    });
    if (!statusResponse.ok) {
      return { ok: false, timedOut: false, apiRunId, error: statusResponse.error };
    }

    const run = statusResponse.body || {};
    const status = String(run.status || run.state || "").toLowerCase();
    const message = extractRunMessage(run);
    if (message) {
      await appendLog(logPath, `[lea-api] ${message}\n`);
    }
    if (["completed", "succeeded", "success", "done"].includes(status)) {
      const reason = String(run.result?.reason || "").toLowerCase();
      if (reason && !["success", "succeeded", "done", "completed"].includes(reason)) {
        return { ok: false, timedOut: false, apiRunId, error: message || `Lea API completed with reason: ${reason}` };
      }
      return { ok: true, timedOut: false, apiRunId };
    }
    if (["failed", "error", "cancelled", "canceled", "timeout", "timed_out"].includes(status)) {
      return { ok: false, timedOut: false, apiRunId, error: message || `Lea API status: ${status}` };
    }
  }

  return { ok: false, timedOut: true, apiRunId, error: "Lea API run timed out." };
}

function extractRunMessage(run) {
  return run.final_text || run.error || run.message || run.result?.text || "";
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

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
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
  return {
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
}

async function getTheoremStatus({
  leaRepoPath,
  overleafProjectId = "unknown",
  theoremLabel,
  jobs = {}
}) {
  const target = buildLeaTarget({ leaRepoPath, overleafProjectId, theoremLabel });
  const projectStatus = await getLeaProjectTheoremStatus({ leaRepoPath, target });
  const directProofStatus = await getLeaDirectProofStatus({ leaRepoPath, target });
  const mappedStatus = await getLatestMappedJobStatus({ leaRepoPath, target, jobs });

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

  if (mappedStatus) {
    return mappedStatus;
  }

  if (directProofStatus?.status === "formalized") {
    return directProofStatus;
  }

  const failedJob = findLatestJob(jobs, target.jobKey, "failed");
  if (failedJob) {
    return {
      ...buildJobResponse({ job: failedJob, status: "failed", target }),
      logTail: await readLogTail(failedJob.logPath)
    };
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
      status: "in_progress",
      ...responseBase
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
      status: "in_progress",
      ...responseBase
    };
  }

  return {
    status: "formalized",
    ...responseBase,
    leanStatement: extractLeanStatement(content, declarationName)
  };
}

async function getLatestMappedJobStatus({ leaRepoPath, target, jobs }) {
  const mappedJob = Object.values(jobs || {})
    .filter((job) => (
      job.jobKey === target.jobKey &&
      job.status === "formalized" &&
      job.declarationName &&
      job.recordedProofPath
    ))
    .sort((a, b) => String(b.finishedAt || b.startedAt).localeCompare(String(a.finishedAt || a.startedAt)))[0] || null;

  if (!mappedJob) {
    return null;
  }

  return getLeaProofStatusFromEntry({
    leaRepoPath,
    target,
    entry: {
      name: mappedJob.declarationName,
      proofPath: mappedJob.recordedProofPath,
      moduleName: mappedJob.moduleName || null
    }
  });
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
