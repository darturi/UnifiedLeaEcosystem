import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildCacheKey,
  buildGeneratedMetadata,
  buildLeanStub,
  buildProjectRelativeLeanPath,
  buildRelativeLeanPath,
  GENERATOR_VERSION
} from "../shared/leanStub.mjs";
import { hashTheoremText, isValidLeanIdentifier } from "../shared/theoremParser.mjs";
import { applyEnvDefaults, loadDotEnv } from "./config.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 31245;
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = path.join(PROJECT_ROOT, ".overleaf-lean-stub");
const SETTINGS_PATH = path.join(APP_DIR, "settings.json");
const CACHE_PATH = path.join(APP_DIR, "cache.json");
const JOBS_PATH = path.join(APP_DIR, "jobs.json");
const JOB_LOG_DIR = path.join(APP_DIR, "jobs");
const BACKUP_DIR = path.join(APP_DIR, "backups");
const DEFAULT_LEAN_TOOLCHAIN = "leanprover/lean4:v4.30.0";
const DEFAULT_LEA_PROVIDER = "openai";
const DEFAULT_LEA_MODEL = "o4-mini";
const DEFAULT_LEA_MAX_TURNS = 20;
const DEFAULT_LAKEFILE = `import Lake
open Lake DSL

package «overleaf_lean_stub_workspace» where

require mathlib from git
  "https://github.com/leanprover-community/mathlib4.git" @ "v4.30.0"

lean_lib Formalization where
`;

export async function createServer({
  settingsPath = SETTINGS_PATH,
  cachePath = CACHE_PATH,
  jobsPath = JOBS_PATH,
  spawnImpl = spawn,
  env = process.env
} = {}) {
  const state = {
    settingsPath,
    cachePath,
    jobsPath,
    spawnImpl,
    env,
    commandExists,
    settings: applyEnvDefaults(await readJson(settingsPath, {}), env),
    cache: await readJson(cachePath, {}),
    jobs: await readJson(jobsPath, {})
  };
  await ensureStartupWorkspace(state);

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

export async function handleCreateStub(payload, state) {
  const workspacePath = state.settings.workspacePath;
  if (!workspacePath) {
    return errorResponse(400, "workspace_unset", "Configure a Lean workspace before creating stubs.");
  }

  const workspaceValidation = await validateWorkspace(workspacePath);
  if (!workspaceValidation.ok) {
    return errorResponse(400, "invalid_workspace", workspaceValidation.message);
  }

  const theoremLabel = String(payload.theoremLabel || "");
  const theoremText = String(payload.theoremText || "");
  if (!isValidLeanIdentifier(theoremLabel)) {
    return errorResponse(400, "invalid_label", "Theorem label must be a valid Lean identifier.");
  }
  if (!theoremText.trim()) {
    return errorResponse(400, "missing_theorem_text", "Theorem text is required.");
  }

  const expectedHash = hashTheoremText(theoremText);
  if (payload.sourceHash && payload.sourceHash !== expectedHash) {
    return errorResponse(400, "source_hash_mismatch", "sourceHash does not match theoremText.");
  }

  const relativePath = buildRelativeLeanPath(theoremLabel);
  const absolutePath = path.join(path.resolve(workspacePath), relativePath);
  const cacheKey = buildCacheKey({ workspacePath, theoremLabel, theoremText });

  if (existsSync(absolutePath)) {
    const currentStatus = await getTheoremStatus({
      workspacePath,
      theoremLabel,
      theoremText,
      cache: state.cache
    });

    const existingMetadata = await readExistingGeneratedMetadata(absolutePath);
    if (existingMetadata && existingMetadata.theoremHash !== expectedHash) {
      return errorResponse(
        409,
        "stub_conflict",
        `A generated stub already exists for ${theoremLabel} with different theorem text.`
      );
    }

    return {
      statusCode: 200,
      body: {
        ...currentStatus,
        action: "checked"
      }
    };
  }

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, buildLeanStub({ theoremLabel, theoremText }), "utf8");

  const leanCheck = await runOptionalLeanCheck(workspacePath, relativePath);
  const metadata = buildGeneratedMetadata({ theoremLabel, theoremText });
  state.cache[cacheKey] = {
    ...metadata,
    overleafProjectId: payload.overleafProjectId || null,
    relativePath,
    absolutePath,
    leanCheck,
    createdAt: new Date().toISOString()
  };
  await writeJson(state.cachePath, state.cache);

  return {
    statusCode: 200,
    body: {
      status: "sorry_stub",
      action: "created",
      theoremLabel,
      declarationName: theoremLabel,
      relativePath,
      absolutePath,
      leanCheck
    }
  };
}

export async function handleGetStatuses(payload, state) {
  const workspacePath = state.settings.workspacePath;
  if (!workspacePath) {
    return errorResponse(400, "workspace_unset", "Configure a Lean workspace before checking statuses.");
  }

  const workspaceValidation = await validateWorkspace(workspacePath);
  if (!workspaceValidation.ok) {
    return errorResponse(400, "invalid_workspace", workspaceValidation.message);
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
      workspacePath,
      overleafProjectId: payload.overleafProjectId || "unknown",
      theoremLabel,
      theoremText,
      cache: state.cache,
      jobs: state.jobs || {}
    });
  }

  return { statusCode: 200, body: { statuses } };
}

export async function handleFormalize(payload, state) {
  const workspacePath = state.settings.workspacePath;
  if (!workspacePath) {
    return errorResponse(400, "workspace_unset", "Configure a Lean workspace before formalizing.");
  }

  const workspaceValidation = await validateWorkspace(workspacePath);
  if (!workspaceValidation.ok) {
    return errorResponse(400, "invalid_workspace", workspaceValidation.message);
  }

  const validation = validateFormalizationPayload(payload);
  if (!validation.ok) {
    return errorResponse(400, validation.error, validation.message);
  }

  const { overleafProjectId, theoremLabel, theoremText } = validation;
  const expectedHash = hashTheoremText(theoremText);
  if (payload.sourceHash && payload.sourceHash !== expectedHash) {
    return errorResponse(400, "source_hash_mismatch", "sourceHash does not match theoremText.");
  }

  const target = buildFormalizationTarget({ workspacePath, overleafProjectId, theoremLabel });
  const activeJob = findActiveJob(state.jobs || {}, target.jobKey);
  if (activeJob) {
    return {
      statusCode: 200,
      body: buildJobResponse({ job: activeJob, status: "in_progress", target })
    };
  }

  const leaValidation = validateLeaRuntime(state);
  if (!leaValidation.ok) {
    return errorResponse(400, leaValidation.error, leaValidation.message);
  }

  await fs.mkdir(path.dirname(target.absolutePath), { recursive: true });
  const job = await createFormalizationJob({ state, target, theoremText });
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

export async function validateWorkspace(workspacePath) {
  if (!workspacePath || !path.isAbsolute(workspacePath)) {
    return { ok: false, message: "Workspace path must be absolute." };
  }

  const toolchain = path.join(workspacePath, "lean-toolchain");
  const lakefileLean = path.join(workspacePath, "lakefile.lean");
  const lakefileToml = path.join(workspacePath, "lakefile.toml");

  if (!existsSync(toolchain)) {
    return { ok: false, message: "Workspace must contain lean-toolchain." };
  }
  if (!existsSync(lakefileLean) && !existsSync(lakefileToml)) {
    return { ok: false, message: "Workspace must contain lakefile.lean or lakefile.toml." };
  }

  return { ok: true };
}

export async function ensureStartupWorkspace(state, workspacePath = PROJECT_ROOT) {
  const defaultWorkspace = path.resolve(workspacePath);
  const currentValidation = state.settings.workspacePath
    ? await validateWorkspace(state.settings.workspacePath)
    : { ok: false };

  if (currentValidation.ok) {
    return { workspacePath: path.resolve(state.settings.workspacePath), created: false, reusedExistingSetting: true };
  }

  const defaultValidation = await validateWorkspace(defaultWorkspace);
  if (!defaultValidation.ok) {
    await setupMinimalLeanWorkspace(defaultWorkspace);
  }

  state.settings.workspacePath = defaultWorkspace;
  await writeJson(state.settingsPath, state.settings);

  return {
    workspacePath: defaultWorkspace,
    created: !defaultValidation.ok,
    reusedExistingSetting: false
  };
}

export async function setupMinimalLeanWorkspace(workspacePath) {
  await fs.mkdir(path.join(workspacePath, "Formalization"), { recursive: true });

  const toolchainPath = path.join(workspacePath, "lean-toolchain");
  const lakefilePath = path.join(workspacePath, "lakefile.lean");

  if (!existsSync(toolchainPath)) {
    await fs.writeFile(toolchainPath, `${DEFAULT_LEAN_TOOLCHAIN}\n`, "utf8");
  }
  if (!existsSync(lakefilePath) && !existsSync(path.join(workspacePath, "lakefile.toml"))) {
    await fs.writeFile(lakefilePath, DEFAULT_LAKEFILE, "utf8");
  }
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
    sendJson(response, 200, {
      ok: true,
      generatorVersion: GENERATOR_VERSION,
      workspaceConfigured: Boolean(state.settings.workspacePath)
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/settings") {
    sendJson(response, 200, {
      ok: true,
      workspacePath: state.settings.workspacePath || "",
      leaRepoPath: state.settings.leaRepoPath || "",
      leaProvider: state.settings.leaProvider || DEFAULT_LEA_PROVIDER,
      leaModel: state.settings.leaModel || DEFAULT_LEA_MODEL,
      leaMaxTurns: state.settings.leaMaxTurns || DEFAULT_LEA_MAX_TURNS
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/settings/workspace") {
    const payload = await readBodyJson(request);
    const workspacePath = String(payload.workspacePath || "");
    const validation = await validateWorkspace(workspacePath);
    if (!validation.ok) {
      sendJson(response, 400, { error: "invalid_workspace", message: validation.message });
      return;
    }

    state.settings.workspacePath = path.resolve(workspacePath);
    await writeJson(state.settingsPath, state.settings);
    sendJson(response, 200, { ok: true, workspacePath: state.settings.workspacePath });
    return;
  }

  if (request.method === "POST" && url.pathname === "/settings/lea") {
    const payload = await readBodyJson(request);
    const leaRepoPath = String(payload.leaRepoPath || "").trim();
    if (!leaRepoPath || !path.isAbsolute(leaRepoPath)) {
      sendJson(response, 400, { error: "invalid_lea_path", message: "Lea repo path must be absolute." });
      return;
    }
    if (!existsSync(path.join(leaRepoPath, "pyproject.toml"))) {
      sendJson(response, 400, { error: "invalid_lea_path", message: "Lea repo path must contain pyproject.toml." });
      return;
    }

    state.settings.leaRepoPath = path.resolve(leaRepoPath);
    state.settings.leaProvider = String(payload.leaProvider || DEFAULT_LEA_PROVIDER);
    state.settings.leaModel = String(payload.leaModel || DEFAULT_LEA_MODEL);
    state.settings.leaMaxTurns = Number.parseInt(String(payload.leaMaxTurns || DEFAULT_LEA_MAX_TURNS), 10);
    await writeJson(state.settingsPath, state.settings);
    sendJson(response, 200, {
      ok: true,
      leaRepoPath: state.settings.leaRepoPath,
      leaProvider: state.settings.leaProvider,
      leaModel: state.settings.leaModel,
      leaMaxTurns: state.settings.leaMaxTurns
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/stubs") {
    const result = await handleCreateStub(await readBodyJson(request), state);
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

async function readExistingGeneratedMetadata(absolutePath) {
  if (!existsSync(absolutePath)) return null;
  const content = await fs.readFile(absolutePath, "utf8");
  const labelMatch = content.match(/^Label:\s*(.+)$/m);
  const theoremMatch = content.match(/Original theorem:\n\n([\s\S]*?)\n-\/\n/);
  if (!labelMatch || !theoremMatch) return null;
  return buildGeneratedMetadata({
    theoremLabel: labelMatch[1].trim(),
    theoremText: theoremMatch[1].trim()
  });
}

function validateFormalizationPayload(payload) {
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

function buildFormalizationTarget({ workspacePath, overleafProjectId, theoremLabel }) {
  const relativePath = buildProjectRelativeLeanPath({ overleafProjectId, theoremLabel });
  const absolutePath = path.join(path.resolve(workspacePath), relativePath);
  return {
    overleafProjectId,
    theoremLabel,
    declarationName: theoremLabel,
    relativePath,
    absolutePath,
    jobKey: `${overleafProjectId}:${theoremLabel}`
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

function validateLeaRuntime(state) {
  if (!state.settings.leaRepoPath || !path.isAbsolute(state.settings.leaRepoPath)) {
    return { ok: false, error: "lea_unconfigured", message: "Configure an absolute Lea repo path first." };
  }
  if (!existsSync(path.join(state.settings.leaRepoPath, "pyproject.toml"))) {
    return { ok: false, error: "invalid_lea_path", message: "Lea repo path must contain pyproject.toml." };
  }
  if (!state.env?.OPENAI_API_KEY) {
    return { ok: false, error: "missing_openai_key", message: "OPENAI_API_KEY must be set before running Lea." };
  }
  const hasCommand = state.commandExists || commandExists;
  if (!hasCommand("uv")) {
    return { ok: false, error: "missing_uv", message: "`uv` must be available on PATH before running Lea." };
  }
  return { ok: true };
}

function commandExists(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

async function createFormalizationJob({ state, target, theoremText }) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jobId = `${target.theoremLabel}-${timestamp}`;
  const logPath = path.join(JOB_LOG_DIR, `${jobId}.log`);
  const backupPath = existsSync(target.absolutePath)
    ? path.join(BACKUP_DIR, jobId, `${target.theoremLabel}.lean`)
    : null;

  if (backupPath) {
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.copyFile(target.absolutePath, backupPath);
  }
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, "", "utf8");

  return {
    jobId,
    jobKey: target.jobKey,
    status: "in_progress",
    overleafProjectId: target.overleafProjectId,
    theoremLabel: target.theoremLabel,
    theoremTextHash: hashTheoremText(theoremText),
    relativePath: target.relativePath,
    absolutePath: target.absolutePath,
    backupPath,
    logPath,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    leaRepoPath: state.settings.leaRepoPath,
    leaProvider: state.settings.leaProvider || DEFAULT_LEA_PROVIDER,
    leaModel: state.settings.leaModel || DEFAULT_LEA_MODEL,
    leaMaxTurns: state.settings.leaMaxTurns || DEFAULT_LEA_MAX_TURNS
  };
}

async function runLeaJob({ state, job, target, theoremText }) {
  const prompt = buildLeaPrompt({
    workspacePath: state.settings.workspacePath,
    relativePath: target.relativePath,
    theoremLabel: target.theoremLabel,
    theoremText
  });
  const args = [
    "run",
    "python",
    "-m",
    "lea.cli",
    "-p",
    job.leaProvider,
    "-m",
    job.leaModel,
    "--max-turns",
    String(job.leaMaxTurns),
    prompt
  ];
  await appendLog(job.logPath, `$ uv ${args.map(shellQuote).join(" ")}\n\n`);

  const exit = await spawnAndCapture({
    spawnImpl: state.spawnImpl || spawn,
    command: "uv",
    args,
    cwd: job.leaRepoPath,
    env: buildLeaEnv({ baseEnv: state.env || process.env, leaRepoPath: job.leaRepoPath }),
    logPath: job.logPath
  });

  const status = await getTheoremStatus({
    workspacePath: state.settings.workspacePath,
    overleafProjectId: target.overleafProjectId,
    theoremLabel: target.theoremLabel,
    theoremText,
    cache: state.cache,
    jobs: {}
  });
  job.status = exit.code === 0 && status.status === "formalized" ? "formalized" : "failed";
  job.finalStatus = status.status;
  job.exitCode = exit.code;
  job.finishedAt = new Date().toISOString();
  await appendLog(job.logPath, `\n[backend] Lea exited with ${exit.code}; final status ${status.status}\n`);
  await writeJson(state.jobsPath, state.jobs);
}

function buildLeaPrompt({ workspacePath, relativePath, theoremLabel, theoremText }) {
  return `In the Lean workspace at ${workspacePath}, create or edit only ${relativePath}.
Create a Lean theorem named ${theoremLabel} corresponding to this Overleaf theorem:

${theoremText}

The final file must compile with no sorry/admit in theorem ${theoremLabel}.
Do not create a placeholder theorem. If you cannot complete the proof, leave the best partial Lean file in ${relativePath}.`;
}

function buildLeaEnv({ baseEnv, leaRepoPath }) {
  return {
    ...baseEnv,
    PYTHONPATH: [leaRepoPath, baseEnv.PYTHONPATH].filter(Boolean).join(path.delimiter)
  };
}

function spawnAndCapture({ spawnImpl, command, args, cwd, env, logPath }) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (chunk) => appendLog(logPath, chunk.toString()));
    child.stderr?.on("data", (chunk) => appendLog(logPath, chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code }));
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
  return {
    status,
    jobId: job.jobId,
    theoremLabel: target.theoremLabel,
    declarationName: target.theoremLabel,
    relativePath: target.relativePath,
    absolutePath: target.absolutePath,
    logTail: "",
    startedAt: job.startedAt,
    finishedAt: job.finishedAt
  };
}

function shellQuote(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:=+-]+$/.test(text) ? text : JSON.stringify(text);
}

async function getTheoremStatus({ workspacePath, overleafProjectId = "unknown", theoremLabel, theoremText, cache, jobs = {} }) {
  const target = buildFormalizationTarget({ workspacePath, overleafProjectId, theoremLabel });
  const failedJob = findLatestJob(jobs, target.jobKey, "failed");

  const relativePath = target.relativePath;
  const absolutePath = target.absolutePath;
  const cacheKey = buildCacheKey({ workspacePath, theoremLabel, theoremText });
  const cached = cache[cacheKey];
  const activeJob = findActiveJob(jobs, target.jobKey);

  if (!existsSync(absolutePath)) {
    if (activeJob) {
      return buildJobResponse({ job: activeJob, status: "in_progress", target });
    }
    if (failedJob) {
      return {
        ...buildJobResponse({ job: failedJob, status: "failed", target }),
        logTail: await readLogTail(failedJob.logPath)
      };
    }
    const legacyRelativePath = buildRelativeLeanPath(theoremLabel);
    const legacyAbsolutePath = path.join(path.resolve(workspacePath), legacyRelativePath);
    if (existsSync(legacyAbsolutePath)) {
      return getLegacyTheoremStatus({
        workspacePath,
        theoremLabel,
        theoremText,
        cache
      });
    }
    return {
      status: "unformalized",
      theoremLabel,
      declarationName: theoremLabel,
      relativePath,
      absolutePath
    };
  }

  const content = await fs.readFile(absolutePath, "utf8");
  if (/\bsorry\b|admit\b/.test(content)) {
    if (activeJob) {
      return buildJobResponse({ job: activeJob, status: "in_progress", target });
    }
    if (failedJob) {
      return {
        ...buildJobResponse({ job: failedJob, status: "failed", target }),
        logTail: await readLogTail(failedJob.logPath)
      };
    }
    return {
      status: "in_progress",
      theoremLabel,
      declarationName: theoremLabel,
      relativePath,
      absolutePath,
      leanCheck: cached?.leanCheck || null
    };
  }

  return {
    status: "formalized",
    theoremLabel,
    declarationName: theoremLabel,
    relativePath,
    absolutePath,
    leanStatement: extractLeanStatement(content, theoremLabel)
  };
}

async function getLegacyTheoremStatus({ workspacePath, theoremLabel, theoremText, cache }) {
  const relativePath = buildRelativeLeanPath(theoremLabel);
  const absolutePath = path.join(path.resolve(workspacePath), relativePath);
  const cacheKey = buildCacheKey({ workspacePath, theoremLabel, theoremText });
  const cached = cache[cacheKey];

  const content = await fs.readFile(absolutePath, "utf8");
  if (/\bsorry\b|admit\b/.test(content)) {
    const existingMetadata = await readExistingGeneratedMetadata(absolutePath);
    const status = existingMetadata && existingMetadata.theoremHash === hashTheoremText(theoremText)
      ? "sorry_stub"
      : "in_progress";

    return {
      status,
      theoremLabel,
      declarationName: theoremLabel,
      relativePath,
      absolutePath,
      leanCheck: cached?.leanCheck || null
    };
  }

  return {
    status: "formalized",
    theoremLabel,
    declarationName: theoremLabel,
    relativePath,
    absolutePath,
    leanStatement: extractLeanStatement(content, theoremLabel)
  };
}

function extractLeanStatement(content, theoremLabel) {
  const declarationPattern = new RegExp(
    `(^|\\n)\\s*(?:private\\s+|protected\\s+)?(?:theorem|lemma)\\s+${escapeRegExp(theoremLabel)}\\b[\\s\\S]*?:=`
  );
  const match = content.match(declarationPattern);
  if (!match) return "";

  const statement = match[0]
    .replace(/^\n/, "")
    .replace(/\s*:=\s*$/, "")
    .trim();
  return statement;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runOptionalLeanCheck(workspacePath, relativePath) {
  if (!existsSync(path.join(workspacePath, "lakefile.lean")) && !existsSync(path.join(workspacePath, "lakefile.toml"))) {
    return { skipped: true, ok: false, message: "No lakefile found." };
  }

  return new Promise((resolve) => {
    const child = spawn("lake", ["env", "lean", relativePath], {
      cwd: workspacePath,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ skipped: false, ok: false, message: "Lean check timed out." });
    }, 15_000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ skipped: true, ok: false, message: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        skipped: false,
        ok: code === 0,
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });
  });
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
    console.log(`Overleaf Lean Stub companion listening at http://${DEFAULT_HOST}:${DEFAULT_PORT}`);
    console.log(`Default Lean workspace: ${PROJECT_ROOT}`);
    if (!process.env.OPENAI_API_KEY) {
      console.log("Warning: OPENAI_API_KEY is not set. Lea jobs will not start.");
    }
    console.log("Run `npm run doctor` if setup fails.");
  });
}
