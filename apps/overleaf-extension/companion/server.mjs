import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { patchEnvFile, readDotEnv, ROOT_ENV_PATH } from "../../../scripts/env.mjs";
import {
  DEFAULT_LEA_MODEL,
  LEA_MODEL_BY_VALUE,
  LEA_MODEL_FAMILIES,
  LEA_MODEL_FAMILY_BY_ID,
  LEA_MODEL_OPTIONS,
  normalizeModelFamilyId
} from "../../../packages/lea-model-catalog/index.mjs";
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
  hashTargetText,
  inferLeanDeclarationName,
  isValidLeanIdentifier
} from "../shared/theoremParser.mjs";
import { buildLeanPaneManifest } from "../shared/leanPaneManifest.mjs";
import { buildChatPrompt, chatTargetKey, toChatSessionResponse } from "./chatPrompt.mjs";
import { applyEnvDefaults, loadDotEnv, normalizeBoolean } from "./config.mjs";
import {
  dependentsOf,
  moduleNameFromProjectStep,
  parseLeanImports,
  projectNamespaceFromSlug,
  proofPathFromProjectStep
} from "./leanDependencyGraph.mjs";
import { classifyEdit, cascadeRequired, parseDeclarationHeader } from "./leanSignatureDiff.mjs";
import {
  fetchAdapterSettings,
  fetchAdapterUsageStats,
  fetchApiSessionDetail,
  interruptApiRun,
  mirrorProjectTexFiles,
  putAdapterSettings,
  runApiProofJob,
  runApiSessionLeanCheck,
  rebuildApiSessionModule,
  writeApiSessionFile
} from "./leaApiClient.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 31245;
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = path.join(PROJECT_ROOT, ".overleaf-lean-stub");
const ENV_PATH = ROOT_ENV_PATH;
const SETTINGS_PATH = path.join(APP_DIR, "settings.json");
const JOBS_PATH = path.join(APP_DIR, "jobs.json");
// Target -> Lea session association for the Lean-pane chat mirror. Only used to
// recover a chat that exists before any formalization job; when a job already
// records the session we prefer that (D: adapter owns sessions/runs/messages).
const CHAT_SESSIONS_PATH = path.join(APP_DIR, "chatSessions.json");
const JOB_LOG_DIR = path.join(APP_DIR, "jobs");
const DEFAULT_LEA_API_BASE_URL = "http://127.0.0.1:8001";
const DEFAULT_LEA_UI_BASE_URL = "http://localhost:5173";
const DEFAULT_LEA_MAX_TURNS = 20;
const DEFAULT_LEA_JOB_TIMEOUT_SECONDS = 900;
const DEFAULT_LEA_TEX_MIRROR_ENABLED = true;
// Cap on concurrent Lean-pane item enrichments. Each enrichment does a handful of
// filesystem reads plus an optional adapter session fetch; running them in a bounded
// pool keeps a large project's manifest fast without flooding the FS/adapter.
const LEAN_PANE_ENRICH_CONCURRENCY = 8;
const PROVIDER_KEY_VALIDATION_TIMEOUT_MS = 5000;
const MAX_SPEND_MESSAGE = "Max spend limit reached. Lea run was cancelled.";
const MAX_SPEND_BLOCK_MESSAGE = "Max spend limit has been reached.";
// Settings the companion mirrors to `.env`. Shared scalars and provider keys are
// also pushed to the adapter, which is their single source of truth.
const SHARED_SETTING_ENV_FIELDS = {
  leaRepoPath: "LEA_ROOT",
  leaApiBaseUrl: "LEA_API_BASE_URL",
  leaUiBaseUrl: "LEA_UI_BASE_URL",
  leaProvider: "LEA_PROVIDER",
  leaModel: "LEA_MODEL",
  leaMaxTurns: "LEA_MAX_TURNS",
  leaNarrateToolSteps: "LEA_NARRATE_TOOL_STEPS",
  leaMaxSpendUsd: "LEA_MAX_SPEND_USD",
  leaJobTimeoutSeconds: "LEA_JOB_TIMEOUT_SECONDS"
};
export { LEA_MODEL_OPTIONS };
const LEA_MODEL_BY_ID = LEA_MODEL_BY_VALUE;
const LEGACY_LEA_MODEL_ALIASES = new Map([
  ["anthropic/claude-opus-4-20250514", "anthropic/claude-opus-4-8"],
  ["anthropic/claude-sonnet-4-20250514", "anthropic/claude-sonnet-4-6"],
  // The lea-standalone adapter stores bare Anthropic IDs (no provider prefix);
  // map them back to the companion catalog's prefixed form when reading shared
  // settings so the model round-trips between the two settings UIs.
  ["claude-opus-4-8", "anthropic/claude-opus-4-8"],
  ["claude-sonnet-4-6", "anthropic/claude-sonnet-4-6"]
]);

// The settings whose single source of truth is the lea-standalone adapter's
// `config/lea.local.toml` (served by GET/PUT /api/settings). The companion no
// longer persists these to `.env`; it reads them from and writes them to the
// adapter so both settings UIs stay in lockstep. Keys map companion field ->
// adapter field.
const ADAPTER_SHARED_SCALARS = {
  leaModel: "model",
  leaMaxTurns: "max_turns",
  leaMaxSpendUsd: "max_spend_usd"
};

export async function createServer({
  settingsPath = SETTINGS_PATH,
  jobsPath = JOBS_PATH,
  chatSessionsPath = CHAT_SESSIONS_PATH,
  fetchImpl = fetch,
  env = process.env
} = {}) {
  const state = {
    settingsPath,
    jobsPath,
    chatSessionsPath,
    fetchImpl,
    env,
    settings: applyEnvDefaults(await readJson(settingsPath, {}), env),
    jobs: await readJson(jobsPath, {}),
    chatSessions: await readJson(chatSessionsPath, {})
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

  const targets = Array.isArray(payload.targets) ? payload.targets : [];
  const statuses = {};

  for (const rawTarget of targets) {
    const targetKind = normalizeTargetKind(rawTarget?.targetKind);
    const targetLabel = String(rawTarget?.targetLabel || "");
    const targetText = String(rawTarget?.targetText || "");
    if (!targetKind || !isValidLeanIdentifier(targetLabel) || !targetText.trim()) {
      continue;
    }

    statuses[targetKey({ targetKind, targetLabel })] = await getTargetStatus({
      leaRepoPath: state.settings.leaRepoPath,
      overleafProjectId: payload.overleafProjectId || "unknown",
      targetKind,
      targetLabel,
      jobs: state.jobs || {}
    });
  }

  return { statusCode: 200, body: { statuses } };
}

export async function handleFormalize(payload, state) {
  const validation = validateTargetPayload(payload);
  if (!validation.ok) {
    return errorResponse(400, validation.error, validation.message);
  }

  const { overleafProjectId, targetKind, targetLabel, targetText, targetUses, targetContext, targetSyntax } = validation;
  const expectedHash = hashTargetText(targetText);
  if (payload.sourceHash && payload.sourceHash !== expectedHash) {
    return errorResponse(400, "source_hash_mismatch", "sourceHash does not match targetText.");
  }

  // Pull the latest shared settings (max-spend cap, key status) from the adapter
  // before validating and launching, so a limit raised/lowered in either UI is
  // honored on this run.
  await syncSharedSettingsFromAdapter(state);

  const leaValidation = validateLeaRuntime(state, { requireApiKey: true });
  if (!leaValidation.ok) {
    return errorResponse(400, leaValidation.error, leaValidation.message);
  }
  if (spendLimitReached(state)) {
    return errorResponse(402, "max_spend_reached", MAX_SPEND_BLOCK_MESSAGE);
  }

  const target = buildLeaTarget({
    leaRepoPath: state.settings.leaRepoPath,
    overleafProjectId,
    targetKind,
    targetLabel
  });
  const activeJob = findActiveJob(state.jobs || {}, target.jobKey);
  if (activeJob) {
    return {
      statusCode: 200,
      body: buildJobResponse({ job: activeJob, status: "in_progress", target })
    };
  }

  const usesResolution = await resolveTheoremUses({
    leaRepoPath: state.settings.leaRepoPath,
    overleafProjectId,
    targetUses,
    jobs: state.jobs || {}
  });
  if (!usesResolution.ok) {
    return errorResponse(400, usesResolution.error, usesResolution.message);
  }

  // The Overleaf project's .tex sources are mirrored into the project's
  // `.lea/files/overleaf/` by the extension's background sync (flushed before this
  // request), so the adapter's composed context already surfaces them to Lea. No
  // per-run LaTeX prep happens here anymore.
  const reusableStub = target.targetKind === "theorem"
    ? await findReusableStubForFormalization({
        leaRepoPath: state.settings.leaRepoPath,
        target,
        jobs: state.jobs || {}
      })
    : null;
  const cleanup = reusableStub
    ? { removedProofPaths: [], removedProjectEntries: [] }
    : await cleanupPreviousRunArtifacts({
        leaRepoPath: state.settings.leaRepoPath,
        target,
        targetText,
        jobs: state.jobs || {}
      });
  const job = await createLeaJob({ state, target, targetText, targetContext, targetSyntax, resolvedUses: usesResolution.resolvedUses });
  if (reusableStub) {
    job.leaSessionId = reusableStub.leaSessionId || null;
    job.recordedProofPath = reusableStub.recordedProofPath;
    job.declarationName = reusableStub.declarationName || target.targetLabel;
    job.moduleName = reusableStub.moduleName || null;
    job.stubToComplete = {
      recordedProofPath: reusableStub.recordedProofPath,
      absolutePath: reusableStub.absolutePath,
      declarationName: reusableStub.declarationName || target.targetLabel,
      leanStatement: reusableStub.leanStatement || ""
    };
  }
  job.retryCleanup = cleanup;
  state.jobs[job.jobId] = job;
  await writeJson(state.jobsPath, state.jobs);

  runLeaJob({ state, job, target, targetText, targetContext, resolvedUses: usesResolution.resolvedUses }).catch(async (error) => {
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
  const validation = validateTargetPayload(payload);
  if (!validation.ok) {
    return errorResponse(400, validation.error, validation.message);
  }

  const { overleafProjectId, targetKind, targetLabel, targetText, targetUses, targetContext, targetSyntax } = validation;
  if (targetKind !== "theorem") {
    return errorResponse(400, "unsupported_stub_target", "Stub generation is only supported for theorem targets.");
  }
  const expectedHash = hashTargetText(targetText);
  if (payload.sourceHash && payload.sourceHash !== expectedHash) {
    return errorResponse(400, "source_hash_mismatch", "sourceHash does not match targetText.");
  }

  await syncSharedSettingsFromAdapter(state);

  const leaValidation = validateLeaRuntime(state, { requireApiKey: true });
  if (!leaValidation.ok) {
    return errorResponse(400, leaValidation.error, leaValidation.message);
  }
  if (spendLimitReached(state)) {
    return errorResponse(402, "max_spend_reached", MAX_SPEND_BLOCK_MESSAGE);
  }

  const target = buildLeaTarget({
    leaRepoPath: state.settings.leaRepoPath,
    overleafProjectId,
    targetKind,
    targetLabel
  });
  const activeJob = findActiveJob(state.jobs || {}, target.jobKey);
  if (activeJob) {
    return {
      statusCode: 200,
      body: buildJobResponse({ job: activeJob, status: "in_progress", target })
    };
  }

  const usesResolution = await resolveTheoremUses({
    leaRepoPath: state.settings.leaRepoPath,
    overleafProjectId,
    targetUses,
    jobs: state.jobs || {}
  });
  if (!usesResolution.ok) {
    return errorResponse(400, usesResolution.error, usesResolution.message);
  }

  const job = await createLeaJob({
    state,
    target,
    targetText,
    targetContext,
    targetSyntax,
    resolvedUses: usesResolution.resolvedUses,
    mode: "stub"
  });
  state.jobs[job.jobId] = job;
  await writeJson(state.jobsPath, state.jobs);

  try {
    await runLeaStubJob({
      state,
      job,
      target,
      targetText,
      targetContext,
      resolvedUses: usesResolution.resolvedUses
    });
  } catch (error) {
    job.status = "failed";
    job.finalStatus = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    job.finishedAt = new Date().toISOString();
    await appendLog(job.logPath, `\n[backend] ${job.error}\n`);
    await writeJson(state.jobsPath, state.jobs);
  }

  return {
    statusCode: job.status === "sorry_stub" ? 200 : 500,
    body: buildJobResponse({ job, status: job.status, target })
  };
}

// Mirror the Overleaf project's .tex sources into the matching adapter project's
// `.lea/files/overleaf/` (D27-extended). Driven by the extension's background sync
// (and a flush before formalize), so the run's composed context surfaces the .tex.
// `payload.files` is `[{ path, content }]`, .tex only; the adapter reconciles +
// upserts and defers the commit. Disabled when the mirror toggle is off.
export async function handleMirrorTex(payload, state) {
  const leaValidation = validateLeaRuntime(state, { requireApiKey: false });
  if (!leaValidation.ok) {
    return errorResponse(400, leaValidation.error, leaValidation.message);
  }
  if (state.settings.leaTexMirrorEnabled === false) {
    return errorResponse(400, "tex_mirror_disabled", "Overleaf .tex mirroring is disabled.");
  }

  const overleafProjectId = String(payload.overleafProjectId || "");
  if (!overleafProjectId.trim()) {
    return errorResponse(400, "missing_project_id", "overleafProjectId is required.");
  }
  const files = Array.isArray(payload.files)
    ? payload.files
        .map((file) => ({ path: String(file?.path || ""), content: String(file?.content ?? "") }))
        .filter((file) => file.path.trim())
    : [];

  let baseUrl;
  try {
    baseUrl = normalizeLeaApiBaseUrl(state.settings.leaApiBaseUrl || DEFAULT_LEA_API_BASE_URL);
  } catch {
    return errorResponse(400, "invalid_lea_api_url", "Lea API base URL must be an absolute http(s) URL.");
  }

  const result = await mirrorProjectTexFiles({
    fetchImpl: state.fetchImpl || fetch,
    baseUrl,
    slug: slugProjectId(overleafProjectId),
    files
  });
  if (!result.ok) {
    return errorResponse(result.status || 502, "mirror_failed", result.error || "Could not mirror .tex to the Lea adapter.");
  }
  return { statusCode: 200, body: { ok: true, summary: result.body } };
}

export async function handleLeanPaneManifest(payload, state) {
  const manifest = buildLeanPaneManifest({
    overleafProjectId: payload.overleafProjectId || "unknown",
    files: Array.isArray(payload.files) ? payload.files : [],
    activePath: payload.activePath || ""
  });

  const leaValidation = validateLeaRuntime(state, { requireApiKey: false });
  if (!leaValidation.ok) {
    return {
      statusCode: 200,
      body: {
        ...manifest,
        diagnostics: [
          ...manifest.diagnostics,
          {
            code: leaValidation.error || "lea_lookup_unavailable",
            message: leaValidation.message || "Lean artifact lookup is unavailable."
          }
        ],
        items: manifest.items.map((item) => ({
          ...item,
          status: "unknown",
          message: leaValidation.message || "Lean artifact lookup is unavailable."
        }))
      }
    };
  }

  const items = await mapWithConcurrency(
    manifest.items,
    LEAN_PANE_ENRICH_CONCURRENCY,
    (item) => enrichLeanPaneItem({
      item,
      state,
      overleafProjectId: payload.overleafProjectId || "unknown"
    })
  );

  return {
    statusCode: 200,
    body: {
      ...manifest,
      items
    }
  };
}

// Order-preserving bounded-concurrency map. `fn` is expected to resolve (Lean-pane
// enrichment catches its own errors), so a worker rejection is surfaced rather than
// swallowed.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

// --- Lean-pane chat mirror ------------------------------------------------
// A compact Overleaf view of the *same* adapter-backed session the full Lea UI
// uses. The companion is the single SSE driver of the run; the extension only
// polls these endpoints. See docs/FEATURE-overleaf-lean-pane-chat-mirror.md.

function normalizeChatTarget(rawTarget, state) {
  const overleafProjectId = String(rawTarget?.overleafProjectId || "");
  const targetKind = normalizeTargetKind(rawTarget?.targetKind);
  const targetLabel = String(rawTarget?.targetLabel || "");
  if (!overleafProjectId.trim()) {
    return { ok: false, error: "missing_project_id", message: "overleafProjectId is required." };
  }
  if (!targetKind) {
    return { ok: false, error: "invalid_target_kind", message: "targetKind must be theorem or definition." };
  }
  if (!isValidLeanIdentifier(targetLabel)) {
    return { ok: false, error: "invalid_label", message: "Target label must be a valid Lean identifier." };
  }
  const target = {
    overleafProjectId,
    targetKind,
    targetLabel,
    projectSlug: slugProjectId(overleafProjectId),
    // Identical to the job store's jobKey, so a chat resolves to the same session
    // any formalization run recorded for this target.
    targetKey: chatTargetKey({ overleafProjectId, targetKind, targetLabel }),
    latexLabel: String(rawTarget?.latexLabel || "").trim(),
    sourceFile: String(rawTarget?.sourceFile || "").trim(),
    sourceStartLine: toPositiveInteger(rawTarget?.sourceStartLine),
    sourceEndLine: toPositiveInteger(rawTarget?.sourceEndLine),
    sourceHash: String(rawTarget?.sourceHash || "").trim(),
    naturalLanguageLatex: String(rawTarget?.naturalLanguageLatex || ""),
    leanDeclarationName: String(rawTarget?.leanDeclarationName || "").trim(),
    recordedProofPath: String(rawTarget?.recordedProofPath || "").trim(),
    status: String(rawTarget?.status || "").trim()
  };
  return { ok: true, target };
}

function chatBaseUrls(state) {
  return {
    baseUrl: normalizeLeaApiBaseUrl(state.settings?.leaApiBaseUrl || DEFAULT_LEA_API_BASE_URL),
    uiBaseUrl: normalizeLeaUiBaseUrl(state.settings?.leaUiBaseUrl || DEFAULT_LEA_UI_BASE_URL)
  };
}

// Resolve a target to its Lea session. Newest-wins, preferring job-recorded
// sessions over the companion association map (the spec: prefer job/session data
// when it exists). `latestJobHash` drives stale detection; `activeJob` blocks a
// concurrent send.
function resolveChatSession({ state, target }) {
  const jobs = state.jobs || {};
  const jobKey = target.targetKey;
  const activeJob = findActiveJob(jobs, jobKey) || null;
  const linkedJob = findLatestJobWithLeaSession(jobs, jobKey);
  const finishedJob = findLatestFinishedJob(jobs, jobKey);
  const assoc = (state.chatSessions || {})[jobKey] || null;
  const leaSessionId =
    (activeJob && (activeJob.leaSessionId || activeJob.recorderSessionId)) ||
    (linkedJob && (linkedJob.leaSessionId || linkedJob.recorderSessionId)) ||
    (assoc && assoc.leaSessionId) ||
    null;
  const latestJobHash = (finishedJob && finishedJob.targetTextHash) || (assoc && assoc.sourceHash) || null;
  return { leaSessionId, latestJobHash, activeJob };
}

async function persistChatSessions(state) {
  if (!state.chatSessionsPath) return;
  await writeJson(state.chatSessionsPath, state.chatSessions || {});
}

export async function handleChatSession(payload, state) {
  const validation = normalizeChatTarget(payload?.target, state);
  if (!validation.ok) return errorResponse(400, validation.error, validation.message);
  const target = validation.target;

  let uiBaseUrl;
  try {
    uiBaseUrl = chatBaseUrls(state).uiBaseUrl;
  } catch {
    uiBaseUrl = null;
  }

  const { leaSessionId, activeJob } = resolveChatSession({ state, target });
  if (!leaSessionId) {
    return {
      statusCode: 200,
      body: {
        ok: true,
        targetKey: target.targetKey,
        leaSessionId: null,
        leaSessionUrl: null,
        status: "no-session",
        messages: [],
        runs: [],
        activeRun: null
      }
    };
  }

  const leaSessionUrl = uiBaseUrl ? buildLeaSessionUrl(uiBaseUrl, leaSessionId) : null;
  let baseUrl;
  try {
    baseUrl = chatBaseUrls(state).baseUrl;
  } catch {
    return errorResponse(400, "invalid_lea_api_url", "Lea API base URL must be an absolute http(s) URL.");
  }

  const detail = await fetchApiSessionDetail({
    fetchImpl: state.fetchImpl || fetch,
    baseUrl,
    apiKey: state.env?.LEA_API_KEY,
    sessionId: leaSessionId
  });
  if (!detail.ok || !detail.body || typeof detail.body !== "object") {
    return {
      statusCode: 200,
      body: {
        ok: false,
        error: "adapter_unavailable",
        message: detail.error || "Could not reach the Lea adapter.",
        targetKey: target.targetKey,
        leaSessionId,
        leaSessionUrl
      }
    };
  }

  const body = toChatSessionResponse(detail.body, { targetKey: target.targetKey, leaSessionId, leaSessionUrl });
  // A live formalization run may not yet be reflected in the adapter detail snapshot.
  if (activeJob && !body.activeRun) body.status = "in-progress";
  return { statusCode: 200, body };
}

export async function handleChatPoll(payload, state) {
  const sessionId = String(payload?.sessionId || "").trim();
  if (!sessionId) return errorResponse(400, "missing_session_id", "sessionId is required.");

  let baseUrl;
  let uiBaseUrl;
  try {
    ({ baseUrl, uiBaseUrl } = chatBaseUrls(state));
  } catch {
    return errorResponse(400, "invalid_lea_api_url", "Lea API base URL must be an absolute http(s) URL.");
  }

  const leaSessionUrl = buildLeaSessionUrl(uiBaseUrl, sessionId);
  const detail = await fetchApiSessionDetail({
    fetchImpl: state.fetchImpl || fetch,
    baseUrl,
    apiKey: state.env?.LEA_API_KEY,
    sessionId
  });
  if (!detail.ok || !detail.body || typeof detail.body !== "object") {
    return {
      statusCode: 200,
      body: {
        ok: false,
        error: "adapter_unavailable",
        message: detail.error || "Could not reach the Lea adapter.",
        leaSessionId: sessionId,
        leaSessionUrl
      }
    };
  }

  return {
    statusCode: 200,
    body: toChatSessionResponse(detail.body, { targetKey: null, leaSessionId: sessionId, leaSessionUrl })
  };
}

export async function handleChatMessage(payload, state) {
  const validation = normalizeChatTarget(payload?.target, state);
  if (!validation.ok) return errorResponse(400, validation.error, validation.message);
  const target = validation.target;
  const message = String(payload?.message || "").trim();
  if (!message) return errorResponse(400, "missing_message", "A chat message is required.");

  // Pull the latest shared cap/key status, then run the same preflight as a
  // formalization run so the panel reuses the existing failure classes.
  await syncSharedSettingsFromAdapter(state);
  const leaValidation = validateLeaRuntime(state, { requireApiKey: true });
  if (!leaValidation.ok) return errorResponse(400, leaValidation.error, leaValidation.message);
  if (spendLimitReached(state)) return errorResponse(402, "max_spend_reached", MAX_SPEND_BLOCK_MESSAGE);

  const { leaSessionId, latestJobHash, activeJob } = resolveChatSession({ state, target });
  if (activeJob) {
    return errorResponse(409, "run_in_progress", "A Lea run for this item is already in progress.");
  }

  const stale = Boolean(latestJobHash && target.sourceHash && latestJobHash !== target.sourceHash);
  const prompt = buildChatPrompt(target, { stale, firstMessage: !leaSessionId, userText: message });

  let started;
  try {
    started = await startChatRun({ state, target, leaSessionId, prompt });
  } catch (error) {
    return errorResponse(502, "chat_run_failed", error instanceof Error ? error.message : String(error));
  }
  if (!started.ok || !started.sessionId) {
    return errorResponse(502, "chat_run_failed", started.error || "Lea adapter did not start the chat run.");
  }

  const now = new Date().toISOString();
  state.chatSessions ||= {};
  const existing = state.chatSessions[target.targetKey] || null;
  state.chatSessions[target.targetKey] = {
    leaSessionId: started.sessionId,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    sourceHash: target.sourceHash || existing?.sourceHash || null
  };
  await persistChatSessions(state);

  return {
    statusCode: 200,
    body: {
      ok: true,
      targetKey: target.targetKey,
      leaSessionId: started.sessionId,
      leaSessionUrl: started.leaSessionUrl,
      runId: started.runId,
      stale,
      userMessage: { id: null, role: "user", content: message, kind: "user", createdAt: now }
    }
  };
}

export async function handleChatInterrupt(payload, state) {
  const runId = String(payload?.runId || "").trim();
  const sessionId = String(payload?.sessionId || "").trim();

  let baseUrl;
  try {
    baseUrl = chatBaseUrls(state).baseUrl;
  } catch {
    return errorResponse(400, "invalid_lea_api_url", "Lea API base URL must be an absolute http(s) URL.");
  }

  let targetRunId = runId;
  if (!targetRunId && sessionId) {
    const detail = await fetchApiSessionDetail({
      fetchImpl: state.fetchImpl || fetch,
      baseUrl,
      apiKey: state.env?.LEA_API_KEY,
      sessionId
    });
    targetRunId = detail.ok && detail.body?.active_run?.id ? detail.body.active_run.id : "";
  }
  if (!targetRunId) return errorResponse(400, "missing_run", "No active run to interrupt.");

  const result = await interruptApiRun({
    fetchImpl: state.fetchImpl || fetch,
    baseUrl,
    apiKey: state.env?.LEA_API_KEY,
    runId: targetRunId
  });
  if (!result.ok) {
    return errorResponse(result.status || 502, "interrupt_failed", result.error || "Could not interrupt the Lea run.");
  }
  return { statusCode: 200, body: { ok: true, runId: targetRunId } };
}

// --- Lean-pane manual edit --------------------------------------------------
// docs/FEATURE-overleaf-lean-pane-manual-edit.md /
// docs/PLAN-overleaf-lean-pane-manual-edit.md (Phase 2).
//
// Unlike chat (resolveChatSession), editing never creates a session: the
// pane only offers "Edit" for an item that already has a recorded artifact
// (content.js: canEditPaneItem), and a recorded artifact implies a
// formalization job already produced a session. A missing session here is a
// data-consistency error, not a "start fresh" case -- see the plan's
// Section 1, point 5.
function resolveEditSession({ state, overleafProjectId, targetKind, targetLabel }) {
  const jobs = state.jobs || {};
  const jobKey = chatTargetKey({ overleafProjectId, targetKind, targetLabel });
  const activeJob = findActiveJob(jobs, jobKey) || null;
  const linkedJob = findLatestJobWithLeaSession(jobs, jobKey);
  const leaSessionId =
    (activeJob && (activeJob.leaSessionId || activeJob.recorderSessionId)) ||
    (linkedJob && (linkedJob.leaSessionId || linkedJob.recorderSessionId)) ||
    null;
  return { leaSessionId, activeJob, linkedJob, jobKey };
}

function validateEditPayload(payload) {
  const overleafProjectId = String(payload?.overleafProjectId || "");
  const targetKind = normalizeTargetKind(payload?.targetKind);
  const targetLabel = String(payload?.targetLabel || "");
  if (!overleafProjectId.trim()) {
    return { ok: false, error: "missing_project_id", message: "overleafProjectId is required." };
  }
  if (!targetKind) {
    return { ok: false, error: "invalid_target_kind", message: "targetKind must be theorem or definition." };
  }
  if (!isValidLeanIdentifier(targetLabel)) {
    return { ok: false, error: "invalid_label", message: "Target label must be a valid Lean identifier." };
  }
  return { ok: true, overleafProjectId, targetKind, targetLabel };
}

function validateEditSavePayload(payload) {
  const base = validateEditPayload(payload);
  if (!base.ok) return base;
  const content = payload?.content;
  if (typeof content !== "string" || !content.trim()) {
    return { ok: false, error: "missing_content", message: "content is required." };
  }
  const note = payload?.note ? String(payload.note).trim() : "";
  return { ...base, content, note };
}

// Find the working file + declaration name for a target's session, the same
// way readLeanPaneArtifactFromSession locates a pane item's artifact: among
// the session's recorded `.lean` code_steps, prefer the newest one whose code
// actually contains the declaration, falling back to the sole `.lean` step
// when there's only one. Also resolves the project namespace, needed for the
// reverse-dependency scan.
async function loadEditableSessionFile({ state, leaSessionId, overleafProjectId, targetKind, targetLabel, linkedJob }) {
  const baseUrl = chatBaseUrls(state).baseUrl;
  const detail = await fetchApiSessionDetail({
    fetchImpl: state.fetchImpl || fetch,
    baseUrl,
    apiKey: state.env?.LEA_API_KEY,
    sessionId: leaSessionId
  });
  if (!detail.ok || !detail.body || typeof detail.body !== "object") {
    return { ok: false, error: "adapter_unavailable", message: detail.error || "Could not reach the Lea adapter." };
  }
  const leanSteps = (Array.isArray(detail.body.code_steps) ? detail.body.code_steps : [])
    .filter((step) => step && String(step.path || "").endsWith(".lean") && String(step.code || "").trim())
    .sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
  const candidates = leanSteps.filter((step) => containsDeclaration(String(step.code || ""), targetLabel));
  const step = candidates[candidates.length - 1] || (leanSteps.length === 1 ? leanSteps[0] : null);
  if (!step) {
    return { ok: false, error: "no_artifact", message: "No recorded Lean artifact was found for this item." };
  }
  const namespace = detail.body.project_namespace
    || linkedJob?.projectNamespace
    || projectNamespaceFromSlug(linkedJob?.projectSlug || slugProjectId(overleafProjectId));
  return {
    ok: true,
    path: step.path,
    content: String(step.code || ""),
    namespace,
    moduleName: moduleNameFromProjectStep({ namespace, stepPath: step.path })
  };
}

// Best-effort display identity for a dependent file discovered by the reverse
// index: parse its own declaration name (falls back to "first declaration in
// the file" per parseDeclarationHeader), or the file's base name if even that
// fails (a file that somehow contains no declaration at all).
function summarizeDependentFile(file) {
  const header = parseDeclarationHeader(file.content);
  return {
    targetLabel: header?.name || path.basename(file.stepPath, ".lean"),
    moduleName: file.moduleName,
    relativePath: file.stepPath
  };
}

// Resolve a dependent's own Lea session by trying both target kinds -- the
// reverse index only knows the dependent's *file*, not whether it's a
// theorem or a definition, the same ambiguity resolveTargetUseStatus already
// handles for the forward (`uses=`) direction.
function resolveDependentSession({ state, overleafProjectId, targetLabel }) {
  for (const targetKind of ["theorem", "definition"]) {
    const resolved = resolveEditSession({ state, overleafProjectId, targetKind, targetLabel });
    if (resolved.leaSessionId) return { ...resolved, targetKind };
  }
  return { leaSessionId: null, activeJob: null, linkedJob: null, targetKind: "theorem" };
}

export async function handleLeanPaneEditStart(payload, state) {
  const validation = validateEditPayload(payload);
  if (!validation.ok) return errorResponse(400, validation.error, validation.message);
  const { overleafProjectId, targetKind, targetLabel } = validation;

  const { leaSessionId, activeJob, linkedJob } = resolveEditSession({ state, overleafProjectId, targetKind, targetLabel });
  if (!leaSessionId) {
    return errorResponse(404, "no_session", "No Lea session is recorded for this item yet. Formalize it first.");
  }

  let file;
  try {
    file = await loadEditableSessionFile({ state, leaSessionId, overleafProjectId, targetKind, targetLabel, linkedJob });
  } catch (error) {
    return errorResponse(502, "edit_start_failed", error instanceof Error ? error.message : String(error));
  }
  if (!file.ok) return errorResponse(file.error === "adapter_unavailable" ? 502 : 404, file.error, file.message);

  let dependents = [];
  try {
    dependents = await dependentsOf({
      leaRepoPath: state.settings.leaRepoPath,
      namespace: file.namespace,
      moduleName: file.moduleName
    });
  } catch {
    dependents = []; // best-effort pre-save preview; save-time cascade still runs for real
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      leaSessionId,
      path: file.path,
      content: file.content,
      activeRun: Boolean(activeJob),
      dependents: dependents.map(summarizeDependentFile)
    }
  };
}

export async function handleLeanPaneEditSave(payload, state) {
  const validation = validateEditSavePayload(payload);
  if (!validation.ok) return errorResponse(400, validation.error, validation.message);
  const { overleafProjectId, targetKind, targetLabel, content, note } = validation;

  const { leaSessionId, activeJob, linkedJob } = resolveEditSession({ state, overleafProjectId, targetKind, targetLabel });
  if (!leaSessionId) {
    return errorResponse(404, "no_session", "No Lea session is recorded for this item yet. Formalize it first.");
  }
  if (activeJob) {
    return errorResponse(409, "run_in_progress", "A Lea run for this item is already in progress.");
  }

  let baseUrl;
  try {
    baseUrl = chatBaseUrls(state).baseUrl;
  } catch {
    return errorResponse(400, "invalid_lea_api_url", "Lea API base URL must be an absolute http(s) URL.");
  }
  const apiKey = state.env?.LEA_API_KEY;
  const fetchImpl = state.fetchImpl || fetch;

  let before;
  try {
    before = await loadEditableSessionFile({ state, leaSessionId, overleafProjectId, targetKind, targetLabel, linkedJob });
  } catch (error) {
    return errorResponse(502, "edit_save_failed", error instanceof Error ? error.message : String(error));
  }
  if (!before.ok) return errorResponse(before.error === "adapter_unavailable" ? 502 : 404, before.error, before.message);

  const write = await writeApiSessionFile({
    fetchImpl, baseUrl, apiKey, sessionId: leaSessionId, path: before.path, content, note
  });
  if (!write.ok) {
    return errorResponse(write.status || 502, "edit_write_failed", write.error || "Could not save the edit.");
  }
  if (write.body?.unchanged) {
    return { statusCode: 200, body: { ok: true, unchanged: true, dependentsImpact: [] } };
  }

  const check = await runApiSessionLeanCheck({ fetchImpl, baseUrl, apiKey, sessionId: leaSessionId, path: before.path });
  if (!check.ok) {
    return errorResponse(check.status || 502, "edit_check_failed", check.error || "Could not check the edit.");
  }
  const ownCheckFailed = String(check.body?.status || "").toLowerCase() !== "ok";
  // Snapshot BEFORE recordEditCheckVerdict mutates it -- this is the only
  // place that knows whether the file was previously known-broken, needed to
  // detect a recovery below.
  const wasPreviouslyFailing = linkedJob?.lastEditCheckStatus === "error";
  // Record the real compiler verdict on the linked job so getTheoremStatus's
  // status override (see its doc comment) picks it up on the next manifest
  // refresh -- otherwise the pane's chip keeps reading the target as
  // "formalized" from stale on-disk evidence. See
  // docs/FEATURE-overleaf-lean-pane-manual-edit.md.
  let jobsChanged = recordEditCheckVerdict(linkedJob, check.body);

  const beforeHeader = parseDeclarationHeader(before.content, targetLabel);
  const afterHeader = parseDeclarationHeader(content, targetLabel);
  const classification = classifyEdit({ before: beforeHeader, after: afterHeader, expectedName: targetLabel, ownCheckFailed });

  const ownResult = {
    path: before.path,
    checkStatus: check.body?.status || null,
    checkDetail: check.body?.detail || null,
    classification
  };

  // classifyEdit/cascadeRequired only reason about whether THIS edit could
  // newly BREAK a dependent (proof irrelevance -> a proof-only edit never
  // can, so it's correctly exempted). They say nothing about the opposite
  // direction: a proof-only edit that fixes a previously-broken file needs to
  // re-verify dependents too, because an earlier cascade (or the rebuild-
  // failure fail-closed path above) may have left them holding a stale
  // "broken"/"unconfirmed" verdict that only a fresh check can clear. Without
  // this, fixing epsilon_one back to a real proof leaves epsilon_two's chip
  // stuck on whatever it last said, forever -- the mirror image of the bug
  // this whole cascade exists to catch. Real recovery (not just "still
  // failing the same way") requires !ownCheckFailed.
  const recoveredFromFailure = wasPreviouslyFailing && !ownCheckFailed;

  const dependentsImpact = [];
  if (cascadeRequired(classification) || recoveredFromFailure) {
    let dependents = [];
    try {
      dependents = await dependentsOf({
        leaRepoPath: state.settings.leaRepoPath,
        namespace: before.namespace,
        moduleName: before.moduleName
      });
    } catch {
      dependents = [];
    }

    // The dependents loop below re-checks each dependent via the fast LSP
    // `lean-check` path -- which never touches the *edited* module's compiled
    // `.olean`, so without this, every dependent would resolve `import
    // <editedModule>` against whatever was built before this save, no matter
    // how many times it's rechecked (the bug this cascade exists to catch).
    // Force one real rebuild of the edited module first, so the checks below
    // are against its current source. Skipped when there's nothing to verify
    // against (dependents.length === 0) -- no point paying for a rebuild that
    // nothing downstream would observe.
    if (dependents.length > 0) {
      const rebuild = await rebuildApiSessionModule({ fetchImpl, baseUrl, apiKey, sessionId: leaSessionId, path: before.path });
      const rebuildOk = rebuild.ok && String(rebuild.body?.status || "").toLowerCase() === "ok";
      if (!rebuildOk) {
        // The edited module doesn't produce a real, current .olean right now
        // (a genuine compile failure the fast own-check may have missed via
        // sorry-recovery, an adapter/transport failure, or a timeout) -- every
        // dependent's check below would be checking against nothing
        // trustworthy. Report "can't verify" rather than guessing either way.
        for (const file of dependents) {
          const summary = summarizeDependentFile(file);
          const dependentSession = resolveDependentSession({ state, overleafProjectId, targetLabel: summary.targetLabel });

          if (dependentSession.activeJob) {
            // Don't race a live run on the dependent -- same rule as the
            // per-dependent loop below.
            dependentsImpact.push({ ...summary, status: "busy", attributed: true, busy: true, brokenByUpstream: null });
            continue;
          }

          // Fail closed: this dependent was never actually re-checked (the
          // upstream rebuild itself failed), so its status CHIP must not keep
          // reading whatever it last read -- typically "valid", from before
          // this edit -- or the pane is right back to the exact bug this
          // cascade exists to catch, just one layer removed (a wrong message
          // is fixed by formatDependentOutcome's "unknown" branch above it in
          // leanPaneView.mjs; the item's own chip is a separate render path,
          // getTheoremStatus's lastEditCheckStatus override, and needs its
          // own write). There is no "unconfirmed" chip state today -- treating
          // it the same as "broken" is the safe default until one exists.
          const detail = `Not re-verified: rebuilding ${targetLabel} failed, so this dependent's status is unconfirmed.`;
          if (dependentSession.linkedJob) {
            jobsChanged = recordEditCheckVerdict(dependentSession.linkedJob, { status: "error", detail }) || jobsChanged;
          }
          dependentsImpact.push({
            ...summary,
            status: "unknown",
            attributed: Boolean(dependentSession.leaSessionId),
            busy: false,
            checkDetail: rebuild.body?.detail || rebuild.error || detail,
            brokenByUpstream: null
          });
        }
        dependents = [];
      }
    }

    for (const file of dependents) {
      const summary = summarizeDependentFile(file);
      const dependentSession = resolveDependentSession({ state, overleafProjectId, targetLabel: summary.targetLabel });

      if (!dependentSession.leaSessionId) {
        // No recorded session for this file's declaration (e.g. jobs.json was
        // reset since it was generated) -- can't attribute a cascade
        // code_step, but still tell the caller this file exists and is at
        // risk so the pane can prompt a manual re-check.
        dependentsImpact.push({ ...summary, status: "unknown", attributed: false, busy: false, brokenByUpstream: null });
        continue;
      }
      if (dependentSession.activeJob) {
        // Don't race a live run on the dependent (PLAN Phase 2 edge case).
        dependentsImpact.push({ ...summary, status: "busy", attributed: true, busy: true, brokenByUpstream: null });
        continue;
      }

      const cascadeCheck = await runApiSessionLeanCheck({
        fetchImpl, baseUrl, apiKey,
        sessionId: dependentSession.leaSessionId,
        path: file.stepPath,
        author: "cascade",
        summary: `Re-checked after edit to ${targetLabel}`
      });
      if (!cascadeCheck.ok) {
        dependentsImpact.push({ ...summary, status: "unknown", attributed: true, busy: false, brokenByUpstream: null });
        continue;
      }
      const broken = String(cascadeCheck.body?.status || "").toLowerCase() !== "ok";
      // Same override as the edited item itself: a cascade re-check is just
      // as authoritative as an own check, so the dependent's chip must
      // reflect it too, not only the impact-list note.
      jobsChanged = recordEditCheckVerdict(dependentSession.linkedJob, cascadeCheck.body) || jobsChanged;
      dependentsImpact.push({
        ...summary,
        status: broken ? "invalid" : "reverified",
        attributed: true,
        busy: false,
        checkDetail: cascadeCheck.body?.detail || null,
        brokenByUpstream: broken
          ? { targetLabel, renamed: classification.kind === "renamed" }
          : null
      });
    }
  }

  if (jobsChanged) {
    await writeJson(state.jobsPath, state.jobs);
  }

  return { statusCode: 200, body: { ok: true, unchanged: false, ownResult, dependentsImpact } };
}

// Persist the real lean_check verdict from an edit or a cascade re-check onto
// its target's linked job -- see getTheoremStatus's status-override doc
// comment. `status`/`detail` are the adapter's raw lean-check response shape
// (`{status, detail}`, D6). Returns whether a mutation actually happened, so
// callers can persist state.jobs only once, after all mutations.
function recordEditCheckVerdict(job, { status, detail } = {}) {
  if (!job) return false;
  job.lastEditCheckStatus = String(status || "").toLowerCase() === "ok" ? "ok" : "error";
  job.lastEditCheckDetail = detail || null;
  job.lastEditedAt = new Date().toISOString();
  return true;
}

// Start (and background-drive) a chat run, resolving as soon as the adapter
// returns a run id — NOT when the run finishes. The companion keeps driving the
// SSE stream to completion in the background while the extension polls; this
// keeps the POST /lean-pane/chat/message response fast and guarantees a single
// driver for the run.
function startChatRun({ state, target, leaSessionId, prompt }) {
  const { baseUrl, uiBaseUrl } = chatBaseUrls(state);
  let settle;
  let settled = false;
  const started = new Promise((resolve) => { settle = resolve; });
  const finish = (value) => {
    if (settled) return;
    settled = true;
    settle(value);
  };

  const run = runApiProofJob({
    fetchImpl: state.fetchImpl || fetch,
    baseUrl,
    apiKey: state.env?.LEA_API_KEY,
    message: prompt,
    sessionId: leaSessionId || null,
    maxTurns: state.settings?.leaMaxTurns,
    timeoutMs: (state.settings?.leaJobTimeoutSeconds || DEFAULT_LEA_JOB_TIMEOUT_SECONDS) * 1000,
    autoApprove: true,
    autonomous: true,
    projectSlug: target.projectSlug || null,
    projectTitle: target.projectSlug || null,
    origin: "overleaf",
    originUrl: buildOverleafDocumentUrl(target.overleafProjectId),
    onRunStarted: async (runId, sessionId) => {
      const resolvedSessionId = sessionId || leaSessionId || null;
      finish({
        ok: true,
        runId,
        sessionId: resolvedSessionId,
        leaSessionUrl: resolvedSessionId ? buildLeaSessionUrl(uiBaseUrl, resolvedSessionId) : null
      });
    }
  });

  // If start failed (no run id, so onRunStarted never fired) settle from the run
  // outcome; otherwise this is a no-op because onRunStarted already settled.
  run.then(
    (exit) => finish({ ok: false, error: exit?.error || "Lea adapter did not start the chat run." }),
    (error) => finish({ ok: false, error: error instanceof Error ? error.message : String(error) })
  );

  return started;
}

export async function handleUpdateLeaSettings(payload, state) {
  const leaRepoPath = String(payload.leaRepoPath || "").trim();
  const validation = await validateLeaRepo(leaRepoPath);
  if (!validation.ok) {
    return errorResponse(400, "invalid_lea_path", validation.message);
  }

  // Refresh adapter-held shared settings/key status so the checks below can see a
  // key configured only in the lea-standalone UI.
  await syncSharedSettingsFromAdapter(state);

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
  let leaMaxSpendUsd;
  try {
    leaMaxSpendUsd = normalizeLeaMaxSpendUsd(
      Object.prototype.hasOwnProperty.call(payload, "leaMaxSpendUsd")
        ? payload.leaMaxSpendUsd
        : state.settings.leaMaxSpendUsd
    );
  } catch {
    return errorResponse(400, "invalid_max_spend", "Lea max spend must be greater than or equal to 0.");
  }
  const leaTexMirrorEnabled = Object.prototype.hasOwnProperty.call(payload, "leaTexMirrorEnabled")
    ? normalizeBoolean(payload.leaTexMirrorEnabled, true)
    : (state.settings.leaTexMirrorEnabled !== false);
  const nextSettings = {
    ...state.settings,
    leaRepoPath: path.resolve(leaRepoPath),
    leaWorkspacePath: validation.leaWorkspacePath,
    leaApiBaseUrl,
    leaProvider: modelInfo.family,
    leaModel: model,
    leaMaxTurns: normalizeLeaMaxTurns(payload.leaMaxTurns || DEFAULT_LEA_MAX_TURNS),
    leaMaxSpendUsd,
    leaTexMirrorEnabled,
    leaJobTimeoutSeconds: Number.parseInt(
    String(payload.leaJobTimeoutSeconds || state.settings.leaJobTimeoutSeconds || DEFAULT_LEA_JOB_TIMEOUT_SECONDS),
    10
    )
  };
  const nextState = { ...state, settings: nextSettings, env: { ...(state.env || {}), ...providerEnvPatch } };
  if (!isProviderKeyConfigured(nextState, modelInfo.family)) {
    return errorResponse(
      400,
      `missing_${modelInfo.family}_key`,
      `${LEA_MODEL_FAMILY_BY_ID.get(modelInfo.family)?.label || modelInfo.family} API key must be set in the lea-standalone settings, .env, or the companion process environment before selecting this model.`
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
  const adapterBody = {
    model,
    max_turns: nextSettings.leaMaxTurns,
    max_spend_usd: nextSettings.leaMaxSpendUsd
  };
  const apiKeyPatch = buildAdapterApiKeyPatch(payload.leaProviderApiKeys, nextState, modelInfo.family);
  if (Object.keys(apiKeyPatch).length > 0) adapterBody.api_keys = apiKeyPatch;
  const pushed = await putAdapterSettings({
    fetchImpl: state.fetchImpl || fetch,
    baseUrl: leaApiBaseUrl,
    body: adapterBody
  });
  if (!pushed.ok) {
    // An HTTP response with a status means the adapter is reachable but rejected
    // the values (e.g. a 422 from key/model validation) — surface that to the
    // user. A missing status means a transport failure (adapter down): degrade
    // gracefully and still save local/infra settings so the user isn't blocked.
    if (typeof pushed.status === "number") {
      const detail = pushed.body?.detail;
      const structured = detail && typeof detail === "object" ? detail : null;
      const message =
        (structured ? structured.message : detail) ||
        pushed.error ||
        "The Lea adapter rejected these settings.";
      return errorResponse(pushed.status, "adapter_settings_rejected", message, structured?.field);
    }
    console.warn(`Could not reach the Lea adapter to sync settings: ${pushed.error}`);
  } else if (pushed.body && typeof pushed.body === "object") {
    state.adapterSettings = pushed.body;
  }

  const sharedEnvPatch = buildSharedSettingsEnvPatch(nextSettings);
  const envPatch = { ...sharedEnvPatch, ...providerEnvPatch };
  if (Object.keys(envPatch).length > 0) {
    await persistEnvPatch(state.envPath || ENV_PATH, envPatch);
    state.env ||= {};
    applyEnvPatchToState(state.env, envPatch);
  }
  state.settings = nextSettings;
  await writeJson(state.settingsPath, sanitizeSettingsForStorage(state.settings));
  return { statusCode: 200, body: await buildSettingsResponse(state) };
}

// Usage shown in the Overleaf popover. The single source of truth is the
// lea-standalone adapter's GET /api/stats (the shared DB), so the popover shows
// the exact same numbers as the lea-standalone Stats page:
//   - All-time  ← stats.global
//   - This project ← sum of stats.sessions whose project_slug matches the
//     Overleaf document namespace (slugProjectId(overleafProjectId)).
// If the adapter is unreachable we fall back to the companion's in-memory job
// tally so the popover degrades instead of erroring.
export async function handleGetUsage(payload, state) {
  const overleafProjectId = String(payload.overleafProjectId || "unknown");
  const leaMaxSpendUsd = normalizeLeaMaxSpendUsd(state.settings?.leaMaxSpendUsd);

  const adapterUsage = await fetchAdapterUsageForPopover(state, overleafProjectId);
  if (adapterUsage) {
    const currentSpend = adapterUsage.allTime.costUsd;
    return {
      statusCode: 200,
      body: {
        project: adapterUsage.project,
        allTime: adapterUsage.allTime,
        leaMaxSpendUsd,
        leaCurrentSpendUsd: currentSpend,
        leaSpendLimitReached:
          leaMaxSpendUsd !== null && currentSpend >= leaMaxSpendUsd
      }
    };
  }

  // Fallback: adapter unreachable — use the in-memory job tally.
  const allTime = aggregateUsage(state.jobs || {}, {});
  return {
    statusCode: 200,
    body: {
      project: aggregateUsage(state.jobs || {}, { overleafProjectId }),
      allTime,
      leaMaxSpendUsd,
      leaCurrentSpendUsd: allTime.costUsd,
      leaSpendLimitReached: spendLimitReached(state)
    }
  };
}

// Fetch the adapter's /api/stats and reshape it into the popover's usage contract
// ({ inputTokens, outputTokens, totalTokens, costUsd, runCount }). Returns null
// when the adapter cannot be reached.
async function fetchAdapterUsageForPopover(state, overleafProjectId) {
  let baseUrl;
  try {
    baseUrl = normalizeLeaApiBaseUrl(state.settings?.leaApiBaseUrl || DEFAULT_LEA_API_BASE_URL);
  } catch {
    return null;
  }
  const result = await fetchAdapterUsageStats({ fetchImpl: state.fetchImpl || fetch, baseUrl });
  if (!result.ok || !result.body || typeof result.body !== "object") {
    return null;
  }
  const stats = result.body;
  const projectSlug = overleafProjectId ? slugProjectId(overleafProjectId) : "";
  const sessions = Array.isArray(stats.sessions) ? stats.sessions : [];

  const project = sessions.reduce(
    (acc, session) => {
      if (!session || session.project_slug !== projectSlug) return acc;
      const inputTokens = toNonNegativeNumber(session.input_tokens);
      const outputTokens = toNonNegativeNumber(session.output_tokens);
      acc.inputTokens += inputTokens;
      acc.outputTokens += outputTokens;
      acc.totalTokens += inputTokens + outputTokens;
      acc.costUsd += toNonNegativeNumber(session.cost_usd);
      acc.runCount += toNonNegativeNumber(session.run_count);
      return acc;
    },
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runCount: 0 }
  );
  project.costUsd = Number(project.costUsd.toFixed(6));

  const global = stats.global && typeof stats.global === "object" ? stats.global : {};
  const allInput = toNonNegativeNumber(global.input_tokens);
  const allOutput = toNonNegativeNumber(global.output_tokens);
  const allTime = {
    inputTokens: allInput,
    outputTokens: allOutput,
    totalTokens: toNonNegativeNumber(global.total_tokens) || allInput + allOutput,
    costUsd: Number(toNonNegativeNumber(global.cost_usd).toFixed(6)),
    runCount: toNonNegativeNumber(global.session_count)
  };

  return { project, allTime };
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
  const legacySharedEnvPatch = buildLegacySharedSettingsEnvPatch(state.settings, state.env || {});
  const envPatch = { ...legacySharedEnvPatch, ...legacyProviderEnvPatch };
  if (Object.keys(envPatch).length > 0) {
    await persistEnvPatch(state.envPath || ENV_PATH, envPatch);
    state.env ||= {};
    applyEnvPatchToState(state.env, envPatch);
  }
  state.settings = applyEnvDefaults(sanitizeRuntimeSettings(state.settings || {}), state.env || {});
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
    sendJson(response, 200, await buildSettingsResponse(state));
    return;
  }

  if (request.method === "POST" && url.pathname === "/settings/lea") {
    const result = await handleUpdateLeaSettings(await readBodyJson(request), state);
    sendJson(response, result.statusCode, result.body);
    return;
  }

  if (request.method === "GET" && url.pathname === "/usage") {
    const result = await handleGetUsage({
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

  if (request.method === "POST" && url.pathname === "/mirror-tex") {
    const result = await handleMirrorTex(await readBodyJson(request), state);
    sendJson(response, result.statusCode, result.body);
    return;
  }

  if (request.method === "POST" && url.pathname === "/lean-pane/manifest") {
    const result = await handleLeanPaneManifest(await readBodyJson(request), state);
    sendJson(response, result.statusCode, result.body);
    return;
  }

  if (request.method === "POST" && url.pathname === "/lean-pane/chat/session") {
    const result = await handleChatSession(await readBodyJson(request), state);
    sendJson(response, result.statusCode, result.body);
    return;
  }

  if (request.method === "POST" && url.pathname === "/lean-pane/chat/message") {
    const result = await handleChatMessage(await readBodyJson(request), state);
    sendJson(response, result.statusCode, result.body);
    return;
  }

  if (request.method === "POST" && url.pathname === "/lean-pane/chat/interrupt") {
    const result = await handleChatInterrupt(await readBodyJson(request), state);
    sendJson(response, result.statusCode, result.body);
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/lean-pane/chat/session/")) {
    const sessionId = decodeURIComponent(url.pathname.slice("/lean-pane/chat/session/".length));
    const result = await handleChatPoll({ sessionId }, state);
    sendJson(response, result.statusCode, result.body);
    return;
  }

  if (request.method === "POST" && url.pathname === "/lean-pane/edit/start") {
    const result = await handleLeanPaneEditStart(await readBodyJson(request), state);
    sendJson(response, result.statusCode, result.body);
    return;
  }

  if (request.method === "POST" && url.pathname === "/lean-pane/edit/save") {
    const result = await handleLeanPaneEditSave(await readBodyJson(request), state);
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

export async function buildSettingsResponse(state) {
  refreshSettingsFromEnv(state);
  await syncSharedSettingsFromAdapter(state);
  const leaRepoPath = state.settings.leaRepoPath || "";
  const model = normalizeLeaModelId(state.settings.leaModel || DEFAULT_LEA_MODEL);
  const modelInfo = LEA_MODEL_BY_ID.get(model) || LEA_MODEL_BY_ID.get(DEFAULT_LEA_MODEL);
  return {
    ok: true,
    leaRepoPath,
    leaWorkspacePath: leaRepoPath ? buildLeaWorkspacePath(leaRepoPath) : "",
    leaApiBaseUrl: state.settings.leaApiBaseUrl || DEFAULT_LEA_API_BASE_URL,
    leaUiBaseUrl: normalizeLeaUiBaseUrl(state.settings.leaUiBaseUrl || DEFAULT_LEA_UI_BASE_URL),
    leaApiKeyConfigured: isProviderKeyConfigured(state, modelInfo.family),
    leaProvider: modelInfo.family,
    leaProviderFamily: modelInfo.family,
    leaProviderKeys: buildProviderKeyStatus(state),
    leaModel: modelInfo.value,
    leaModelOptions: LEA_MODEL_OPTIONS,
    leaMaxTurns: state.settings.leaMaxTurns || DEFAULT_LEA_MAX_TURNS,
    leaNarrateToolSteps: state.settings.leaNarrateToolSteps !== false,
    leaMaxSpendUsd: normalizeLeaMaxSpendUsd(state.settings.leaMaxSpendUsd),
    leaCurrentSpendUsd: aggregateUsage(state.jobs || {}, {}).costUsd,
    leaTexMirrorEnabled: state.settings.leaTexMirrorEnabled !== false,
    leaJobTimeoutSeconds: state.settings.leaJobTimeoutSeconds || DEFAULT_LEA_JOB_TIMEOUT_SECONDS
  };
}

function buildProviderKeyStatus(state) {
  const status = {};
  for (const family of LEA_MODEL_FAMILIES) {
    status[family.id] = {
      label: family.label,
      configured: isProviderKeyConfigured(state, family.id)
    };
  }
  return status;
}

// The adapter is the source of truth for provider keys, so a key configured in
// the lea-standalone UI (stored in the adapter TOML) must count as configured
// here too — even though its raw value never leaves the adapter. We treat a
// family as configured if the companion env has the key OR the adapter reports
// one of the family's env vars as configured.
function isProviderKeyConfigured(state, familyId) {
  if (getProviderApiKey(state, familyId)) return true;
  const apiKeys = state.adapterSettings?.api_keys || {};
  const family = LEA_MODEL_FAMILY_BY_ID.get(normalizeProviderFamilyId(familyId));
  for (const envVar of family?.envVars || []) {
    if (apiKeys[envVar]?.configured) return true;
  }
  return false;
}

// Pull the shared settings (model, max_turns, max_spend_usd, provider key status)
// from the adapter and overlay them onto local state, so GET /settings and the
// run preflight reflect whatever was last saved in either UI. Best-effort: if the
// adapter is unreachable we keep local values.
async function syncSharedSettingsFromAdapter(state) {
  let baseUrl;
  try {
    baseUrl = normalizeLeaApiBaseUrl(state.settings.leaApiBaseUrl || DEFAULT_LEA_API_BASE_URL);
  } catch {
    state.adapterSettings = null;
    return null;
  }
  const result = await fetchAdapterSettings({ fetchImpl: state.fetchImpl || fetch, baseUrl });
  if (!result.ok || !result.body || typeof result.body !== "object") {
    state.adapterSettings = null;
    return null;
  }
  const adapter = result.body;
  state.adapterSettings = adapter;
  if (typeof adapter.max_turns === "number") {
    state.settings.leaMaxTurns = adapter.max_turns;
  }
  if (adapter.max_spend_usd === null || typeof adapter.max_spend_usd === "number") {
    state.settings.leaMaxSpendUsd = adapter.max_spend_usd;
  }
  if (adapter.model) {
    const mapped = normalizeLeaModelId(String(adapter.model));
    // Only adopt the adapter's model if it maps to a model the companion knows,
    // so we never overlay an ID the run preflight would reject as unsupported.
    if (LEA_MODEL_BY_ID.has(mapped)) {
      state.settings.leaModel = mapped;
    }
  }
  return adapter;
}

function getProviderApiKey(state, familyId) {
  familyId = normalizeProviderFamilyId(familyId);
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

  selectedFamilyId = normalizeProviderFamilyId(selectedFamilyId);
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
  familyId = normalizeProviderFamilyId(familyId);
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
  familyId = normalizeProviderFamilyId(familyId);
  if (familyId === "openai") return "https://api.openai.com/v1/models";
  if (familyId === "google") {
    return `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  }
  if (familyId === "anthropic") return "https://api.anthropic.com/v1/models";
  return "";
}

function providerValidationHeaders(familyId, apiKey) {
  familyId = normalizeProviderFamilyId(familyId);
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
  familyId = normalizeProviderFamilyId(familyId);
  return {
    ok: false,
    error: `${familyId}_key_verification_failed`,
    message: `Could not verify ${label} API key. Check your network connection or try again.`
  };
}

// The adapter's first-class provider env-var names (its `/api/settings` api_keys
// are keyed by these). Note google maps to GOOGLE_API_KEY — the adapter's
// recognized name — even though the companion catalog lists GEMINI_API_KEY first.
const ADAPTER_KEY_ENV_BY_FAMILY = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY"
};

// Build the `api_keys` patch for the adapter's PUT /api/settings from the keys a
// user just entered in the Overleaf options form, plus (if available) the raw key
// for the selected model's family — so the adapter, the single source of truth,
// always ends up holding the key the selected model needs.
function buildAdapterApiKeyPatch(patchKeys, state, selectedFamilyId) {
  const patch = {};
  if (patchKeys && typeof patchKeys === "object" && !Array.isArray(patchKeys)) {
    for (const [rawFamilyId, rawValue] of Object.entries(patchKeys)) {
      const familyId = normalizeProviderFamilyId(rawFamilyId);
      const env = ADAPTER_KEY_ENV_BY_FAMILY[familyId];
      const value = String(rawValue || "").trim();
      if (env && value) patch[env] = { value };
    }
  }
  const selected = normalizeProviderFamilyId(selectedFamilyId);
  const selectedEnv = ADAPTER_KEY_ENV_BY_FAMILY[selected];
  if (selectedEnv && !patch[selectedEnv]) {
    const value = getProviderApiKey(state, selected);
    if (value) patch[selectedEnv] = { value };
  }
  return patch;
}

function buildProviderEnvPatch(patchKeys) {
  const patch = {};
  if (!patchKeys || typeof patchKeys !== "object" || Array.isArray(patchKeys)) {
    return patch;
  }
  for (const [rawFamilyId, rawValue] of Object.entries(patchKeys)) {
    const family = LEA_MODEL_FAMILY_BY_ID.get(normalizeProviderFamilyId(rawFamilyId));
    if (!family) continue;
    const value = String(rawValue || "").trim();
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
    const rawValue = patchKeys[family.id] ?? patchKeys[family.aliases?.[0]];
    const value = String(rawValue || "").trim();
    if (value) {
      patch[family.envVars[0]] = value;
    }
  }
  return patch;
}

async function persistEnvPatch(envPath, patch) {
  await patchEnvFile(envPath, patch);
}

function buildSharedSettingsEnvPatch(settings) {
  const patch = {};
  for (const [settingKey, envKey] of Object.entries(SHARED_SETTING_ENV_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(settings || {}, settingKey)) continue;
    const value = settings[settingKey];
    if (value === undefined) continue;
    patch[envKey] = normalizeSharedSettingValue(settingKey, value);
  }
  return patch;
}

function buildLegacySharedSettingsEnvPatch(settings, env) {
  const patch = {};
  for (const [settingKey, envKey] of Object.entries(SHARED_SETTING_ENV_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(settings || {}, settingKey)) continue;
    if (env?.[envKey] !== undefined && String(env[envKey]).trim() !== "") continue;
    const value = settings[settingKey];
    if (value === undefined || value === "") continue;
    patch[envKey] = normalizeSharedSettingValue(settingKey, value);
  }
  return patch;
}

function normalizeSharedSettingValue(settingKey, value) {
  if (settingKey === "leaModel") return normalizeLeaModelId(value);
  if (settingKey === "leaProvider") return normalizeProviderFamilyId(value);
  return value;
}

function applyEnvPatchToState(env, patch) {
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === null || value === undefined || value === "") {
      delete env[key];
    } else {
      env[key] = String(value);
    }
  }
}

function normalizeLeaModelId(modelId) {
  const raw = String(modelId || DEFAULT_LEA_MODEL);
  return LEGACY_LEA_MODEL_ALIASES.get(raw) || raw;
}

function normalizeProviderFamilyId(familyId) {
  return normalizeModelFamilyId(familyId);
}

function refreshSettingsFromEnv(state) {
  if (!state) return;
  const env = { ...(state.env || {}) };
  Object.assign(env, readDotEnv(state.envPath || ENV_PATH));
  state.env = env;
  state.settings = applyEnvDefaults(state.settings || {}, env);
}

function sanitizeRuntimeSettings(settings) {
  const {
    leaApiKey: _leaApiKey,
    leaProviderApiKeys: _leaProviderApiKeys,
    leaRepoPath: _leaRepoPath,
    leaWorkspacePath: _leaWorkspacePath,
    leaApiBaseUrl: _leaApiBaseUrl,
    leaUiBaseUrl: _leaUiBaseUrl,
    leaProvider: _leaProvider,
    leaModel: _leaModel,
    leaMaxTurns: _leaMaxTurns,
    leaMaxSpendUsd: _leaMaxSpendUsd,
    leaTheoremTranslationMaxRetries: _leaTheoremTranslationMaxRetries,
    leaJobTimeoutSeconds: _leaJobTimeoutSeconds,
    ...rest
  } = settings || {};
  return {
    ...rest,
    leaTexMirrorEnabled: rest.leaTexMirrorEnabled !== false
  };
}

function sanitizeSettingsForStorage(settings) {
  return sanitizeRuntimeSettings(settings);
}

function validateTargetPayload(payload) {
  const overleafProjectId = String(payload.overleafProjectId || "");
  const targetKind = normalizeTargetKind(payload.targetKind);
  const targetLabel = String(payload.targetLabel || "");
  const targetText = String(payload.targetText || "");
  const targetContext = String(payload.targetContext || "").trim();
  const targetUses = Array.isArray(payload.targetUses)
    ? payload.targetUses.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  // Informational only -- which marker syntax (comment vs. inline tag,
  // docs/FEATURE-overleaf-inline-lea-tags.md) produced this target. Recorded
  // on the job for debugging/telemetry; it never affects the prompt, jobKey,
  // or any validation/dependency-resolution behavior below. Defaults to
  // "comment" for any client that predates this field.
  const targetSyntax = payload.syntax === "tag" ? "tag" : "comment";
  if (!overleafProjectId.trim()) {
    return { ok: false, error: "missing_project_id", message: "overleafProjectId is required." };
  }
  if (!targetKind) {
    return { ok: false, error: "invalid_target_kind", message: "targetKind must be theorem or definition." };
  }
  if (!isValidLeanIdentifier(targetLabel)) {
    return { ok: false, error: "invalid_label", message: "Target label must be a valid Lean identifier." };
  }
  const invalidUse = targetUses.find((value) => !isValidLeanIdentifier(value));
  if (invalidUse) {
    return { ok: false, error: "invalid_uses", message: `Target dependency label must be a valid Lean identifier: ${invalidUse}.` };
  }
  if (!targetText.trim()) {
    return { ok: false, error: "missing_target_text", message: "Target text is required." };
  }
  return { ok: true, overleafProjectId, targetKind, targetLabel, targetText, targetUses, targetContext, targetSyntax };
}

async function atomicWriteJson(filePath, value) {
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function atomicWriteFile(filePath, content, encoding) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`
  );
  await fs.writeFile(tmpPath, content, encoding);
  await fs.rename(tmpPath, filePath);
}

// Canonical public-Overleaf document URL for an `overleafProjectId`. Sent to the
// adapter as the session's `origin_url` so the Lea UI can open/focus the source
// document. Host is www.overleaf.com (public-host-only decision); the `/project/<id>`
// path is Overleaf's own URL shape. Returns null for an unknown/empty id.
export function buildOverleafDocumentUrl(overleafProjectId) {
  const id = String(overleafProjectId || "").trim();
  if (!id || id === "unknown") return null;
  return `https://www.overleaf.com/project/${encodeURIComponent(id)}`;
}

function normalizeTargetKind(value) {
  const kind = String(value || "").trim();
  return kind === "theorem" || kind === "definition" ? kind : "";
}

function targetKey({ targetKind, targetLabel }) {
  return `${targetKind}:${targetLabel}`;
}

function buildLeaTarget({ leaRepoPath, overleafProjectId, targetKind, targetLabel }) {
  const projectSlug = slugProjectId(overleafProjectId);
  const projectMarkdownPath = buildLeaProjectMarkdownPath({ leaRepoPath, overleafProjectId });
  return {
    overleafProjectId,
    projectId: overleafProjectId,
    projectSlug,
    targetKind,
    targetLabel,
    theoremLabel: targetLabel,
    declarationName: targetLabel,
    projectMarkdownPath,
    relativePath: relativeToLeaRepo({ leaRepoPath, absolutePath: projectMarkdownPath }),
    absolutePath: projectMarkdownPath,
    jobKey: `${projectSlug}:${targetKey({ targetKind, targetLabel })}`
  };
}

async function findReusableStubForFormalization({ leaRepoPath, target, jobs }) {
  const status = getEquivalentTheoremStatus(await getCurrentTheoremProofStatus({
    leaRepoPath,
    overleafProjectId: target.overleafProjectId,
    theoremLabel: target.theoremLabel,
    jobs
  }));
  if (status?.status !== "sorry_stub" || !status.recordedProofPath || !status.absolutePath) {
    return null;
  }
  const linkedJob = findLatestJobWithLeaSession(jobs, target.jobKey);
  return {
    leaSessionId: status.leaSessionId || linkedJob?.leaSessionId || linkedJob?.recorderSessionId || null,
    declarationName: status.declarationName || target.theoremLabel,
    recordedProofPath: status.recordedProofPath,
    absolutePath: status.absolutePath,
    moduleName: status.moduleName || null,
    leanStatement: status.leanStatement || ""
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

async function resolveTheoremUses({ leaRepoPath, overleafProjectId, targetUses, jobs }) {
  const resolvedUses = [];
  const unresolvedUses = [];

  for (const theoremLabel of targetUses) {
    const status = await resolveTargetUseStatus({
      leaRepoPath,
      overleafProjectId,
      targetLabel: theoremLabel,
      jobs
    });

    const equivalentStatus = getEquivalentTheoremStatus(status);
    if (!["formalized", "sorry_stub"].includes(equivalentStatus.status) || !equivalentStatus.absolutePath || !equivalentStatus.declarationName) {
      unresolvedUses.push(theoremLabel);
      continue;
    }

    resolvedUses.push({
      targetKind: status.targetKind || "theorem",
      targetLabel: theoremLabel,
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
  if (requireApiKey && !isProviderKeyConfigured(state, modelInfo.family)) {
    const family = LEA_MODEL_FAMILY_BY_ID.get(modelInfo.family);
    const envList = family?.envVars?.join(" or ") || "provider API key";
    return {
      ok: false,
      error: `missing_${modelInfo.family}_key`,
      message: `${family?.label || modelInfo.family} API key must be set in the lea-standalone settings, .env, or the companion process environment as ${envList}.`
    };
  }
  return { ok: true };
}

async function createLeaJob({ state, target, targetText, targetContext = "", targetSyntax = "comment", resolvedUses = [], mode = "formalization" }) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jobId = `${target.targetKind}-${target.targetLabel}-${timestamp}`;
  const logPath = path.join(JOB_LOG_DIR, `${jobId}.log`);
  const declarationNameHint = inferLeanDeclarationName(targetText);

  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, "", "utf8");
  const modelInfo = LEA_MODEL_BY_ID.get(normalizeLeaModelId(state.settings.leaModel || DEFAULT_LEA_MODEL)) || LEA_MODEL_BY_ID.get(DEFAULT_LEA_MODEL);

  return {
    jobId,
    jobKey: target.jobKey,
    status: "in_progress",
    mode,
    targetKind: target.targetKind,
    targetLabel: target.targetLabel,
    // Debugging/telemetry only -- see validateTargetPayload. Never read by
    // buildLeaPrompt, jobKey construction, or dependency resolution.
    targetSyntax,
    overleafProjectId: target.overleafProjectId,
    projectId: target.projectId,
    projectSlug: target.projectSlug,
    projectMarkdownPath: target.projectMarkdownPath,
    declarationName: target.targetLabel,
    declarationNameHint: declarationNameHint || null,
    targetUses: resolvedUses,
    targetContext,
    targetTextHash: hashTargetText(targetText),
    relativePath: target.relativePath,
    absolutePath: target.absolutePath,
    logPath,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    leaRepoPath: state.settings.leaRepoPath,
    leaWorkspacePath: buildLeaWorkspacePath(state.settings.leaRepoPath),
    leaApiBaseUrl: state.settings.leaApiBaseUrl || DEFAULT_LEA_API_BASE_URL,
    leaSessionId: null,
    leaUiBaseUrl: normalizeLeaUiBaseUrl(state.settings.leaUiBaseUrl || DEFAULT_LEA_UI_BASE_URL),
    leaApiKeyConfigured: Boolean(getProviderApiKey(state, modelInfo.family)),
    leaProvider: modelInfo.family,
    leaProviderFamily: modelInfo.family,
    leaModel: modelInfo.value,
    leaMaxTurns: state.settings.leaMaxTurns || DEFAULT_LEA_MAX_TURNS,
    leaNarrateToolSteps: state.settings.leaNarrateToolSteps !== false,
    leaCurrentTurn: null,
    leaJobTimeoutSeconds: state.settings.leaJobTimeoutSeconds || DEFAULT_LEA_JOB_TIMEOUT_SECONDS
  };
}

async function cleanupPreviousRunArtifacts({ leaRepoPath, target, targetText, jobs }) {
  const previousJob = findLatestFinishedJob(jobs, target.jobKey);
  if (!previousJob) {
    return { removedProofPaths: [], removedProjectEntries: [] };
  }

  const declarationHint = inferLeanDeclarationName(targetText);
  const candidateNames = new Set([
    previousJob.declarationName,
    previousJob.declarationNameHint,
    declarationHint,
    target.targetLabel
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

// Run one autonomous proof job against the standalone adapter, returning the
// `exit` contract ({ ok, timedOut, apiRunId, error, usage, costUsd }) the rest of
// the orchestration consumes.
async function runLeaProofJobForJob({ state, job, target, prompt, onEvent = null }) {
  await appendLog(job.logPath, `$ POST ${job.leaApiBaseUrl}/api/runs\n\n${prompt}\n\n`);
  const exit = await runApiProofJob({
    fetchImpl: state.fetchImpl || fetch,
    baseUrl: job.leaApiBaseUrl,
    apiKey: state.env?.LEA_API_KEY,
    message: prompt,
    sessionId: job.leaSessionId || null,
    maxTurns: job.leaMaxTurns,
    timeoutMs: job.leaJobTimeoutSeconds * 1000,
    autoApprove: true,
    projectSlug: target.projectSlug || null,
    projectTitle: target.projectSlug || null,
    origin: "overleaf",
    originUrl: buildOverleafDocumentUrl(target.overleafProjectId),
    appendLog,
    logPath: job.logPath,
    onRunStarted: async (apiRunId, sessionId, startBody = {}) => {
      job.apiRunId = apiRunId;
      job.leaSessionId = sessionId || job.leaSessionId || null;
      job.projectNamespace = startBody.project_namespace || job.projectNamespace || null;
      job.projectSlug = startBody.project_slug || job.projectSlug || target.projectSlug;
      job.adapterProjectId = startBody.project_id || job.adapterProjectId || null;
      await writeJson(state.jobsPath, state.jobs);
    },
    onEvent,
    onProgressUpdated: async (progress) => {
      if (!recordJobTurnProgress(job, progress)) return;
      await writeJson(state.jobsPath, state.jobs);
    }
  });
  if (exit.usage || exit.costUsd !== undefined) {
    await recordUsageAndEnforceSpendLimit({
      state,
      job,
      usage: { ...exit.usage, costUsd: exit.costUsd },
      mode: "formalization"
    });
  }
  return exit;
}

// Single source of truth for turning a finished Lea run into a theorem outcome.
//
// The Lea adapter is the producer and the authority on whether a proof passed:
// its terminal `done` status (surfaced here as `exit.ok`) is `proved`/`disproved`
// only when the agent cleared Lea's own final Lean verification. Local filesystem
// inspection (`localStatus`) is used purely to ENRICH the result — locate the
// proof file, surface the Lean statement, detect a leftover sorry — or as a
// FALLBACK when the run itself failed. It is never allowed to override a run the
// adapter reported as successful. This matters because the adapter defers
// project-markdown recording, so the companion frequently cannot locate the
// proof on disk even though the run genuinely formalized the theorem; trusting
// the adapter is what keeps the Overleaf tag truthful.
//
// `artifactError` is set when the run succeeded but the companion recorded
// multiple candidate proofs and could not disambiguate which one belongs to this
// theorem — distinct from the deferred-recording case (no candidates at all),
// where we trust the adapter.
//
// Returns: { jobStatus, finalStatus, effectiveStatus, leanCheck, error }.
export async function resolveProofOutcome({ job, localStatus, exit, artifactError = null }) {
  const local = localStatus && localStatus.status ? localStatus : { status: "unformalized" };
  const resultKind = String(exit.resultKind || exit.doneStatus || "").toLowerCase();

  if (resultKind === "disproved") {
    return {
      jobStatus: "disproved",
      finalStatus: "disproved",
      effectiveStatus: { ...local, status: "disproved" },
      leanCheck: null,
      resultKind: "disproved",
      resultDetail: exit.resultDetail || null,
      error: null
    };
  }

  // A located sorry/admit is never a complete formalization, whatever the run
  // outcome: record the run as failed but carry the sorry_stub effective status
  // so historical artifacts remain readable.
  if (local.status === "sorry_stub") {
    return {
      jobStatus: "failed",
      finalStatus: "sorry_stub",
      effectiveStatus: local,
      leanCheck: null,
      error: exit.ok
        ? `Lea reported a verified outcome but ${job.targetLabel || job.declarationName} still uses sorry/admit.`
        : (exit.error || null)
    };
  }

  // The run did not complete with a verified outcome. Keep the best file-derived
  // status as the effective status for the UI.
  if (!exit.ok) {
    return {
      jobStatus: "failed",
      finalStatus: local.status || "unformalized",
      effectiveStatus: local,
      leanCheck: null,
      error: exit.error || `Lea API run completed but final status is ${local.status}.`
    };
  }

  // Run succeeded, but we recorded multiple candidate proofs and cannot safely
  // attribute the verified proof to this theorem. Record as failed and surface
  // the ambiguity rather than guessing.
  if (artifactError) {
    return {
      jobStatus: "failed",
      finalStatus: local.status || "unformalized",
      effectiveStatus: local,
      leanCheck: null,
      error: artifactError
    };
  }

  // exit.ok and no leftover sorry: the adapter passed its own final verification,
  // so the theorem IS formalized. Run a local lean check for diagnostics only
  // when we happened to locate the proof file — a missing or failing local
  // toolchain must NOT downgrade a run the adapter already verified.
  let leanCheck = null;
  if (local.status === "formalized" && local.absolutePath) {
    leanCheck = await runLeanCheck(job.leaWorkspacePath, local.absolutePath);
  }
  const effectiveStatus = local.status === "formalized" ? local : { ...local, status: "formalized" };
  return {
    jobStatus: "formalized",
    finalStatus: "formalized",
    effectiveStatus,
    resultKind: "proved",
    resultDetail: exit.resultDetail || null,
    leanCheck,
    error: null
  };
}

// Shared finalization for a completed Lea proof run. It computes the best local,
// file-derived status as enrichment, then defers the verdict to
// `resolveProofOutcome`. This is the single place a run's terminal job status is
// decided, so the badge, the job record, and the polling resolver can never
// disagree about whether a theorem was formalized.
async function applyProofOutcomeToJob({ state, job, target, beforeMarkers, exit, resolvedUses }) {
  const uses = Array.isArray(resolvedUses) ? resolvedUses : (job.targetUses || []);

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
        theoremLabel: target.targetLabel,
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
        theoremLabel: target.targetLabel,
        jobs: {}
      });
  const localStatus = (
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

  const outcome = await resolveProofOutcome({ job, localStatus, exit, artifactError: artifact?.error || null });
  if (outcome.leanCheck) {
    job.leanCheck = outcome.leanCheck;
  }
  job.stubbedTheoremUses = outcome.jobStatus === "formalized"
    ? await findImportedStubbedTheoremUses({
      proofPath: outcome.effectiveStatus.absolutePath,
      resolvedUses: uses
    })
    : [];
  job.finalStatus = outcome.finalStatus;
  job.resultKind = target.targetKind === "definition" && outcome.jobStatus === "formalized"
    ? "defined"
    : outcome.resultKind || null;
  job.resultDetail = outcome.resultDetail || null;
  job.apiRunId = exit.apiRunId || job.apiRunId || null;
  job.exitCode = ["formalized", "disproved"].includes(outcome.jobStatus) ? 0 : 1;
  job.timedOut = exit.timedOut;
  if (outcome.error) {
    job.error = outcome.error;
  } else {
    delete job.error;
  }
  job.finishedAt = new Date().toISOString();
  const exitSummary = exit.timedOut
    ? `Lea timed out after ${job.leaJobTimeoutSeconds} seconds`
    : `Lea API run ${exit.ok ? "completed" : "failed"}`;
  await appendLog(job.logPath, `\n[backend] ${exitSummary}; final status ${outcome.finalStatus}\n`);
  if (job.error) {
    await appendLog(job.logPath, `[backend] ${job.error}\n`);
  }
  job.status = outcome.jobStatus;
  await writeJson(state.jobsPath, state.jobs);
}

async function runLeaJob({ state, job, target, targetText, targetContext = "", resolvedUses = [] }) {
  const beforeMarkers = await readProjectTheoremEntries(target.projectMarkdownPath);
  const prompt = buildLeaPrompt({
    targetKind: target.targetKind,
    projectSlug: target.projectSlug,
    targetLabel: target.targetLabel,
    targetText,
    targetContext,
    declarationNameHint: job.declarationNameHint || "",
    resolvedUses,
    stubToComplete: job.stubToComplete || null
  });
  const exit = await runLeaProofJobForJob({ state, job, target, prompt });
  if (job.finalStatus === "max_spend") return;

  await applyProofOutcomeToJob({ state, job, target, beforeMarkers, exit, resolvedUses });
}

async function runLeaStubJob({ state, job, target, targetText, targetContext = "", resolvedUses = [] }) {
  const observedCodeSteps = new Map();
  const prompt = buildLeaStubPrompt({
    projectSlug: target.projectSlug,
    theoremLabel: target.targetLabel,
    theoremText: targetText,
    theoremContext: targetContext,
    resolvedUses
  });
  const exit = await runLeaProofJobForJob({
    state,
    job,
    target,
    prompt,
    onEvent: (type, data) => {
      if (type !== "code_step" || !data?.id) return;
      observedCodeSteps.set(data.id, { ...(observedCodeSteps.get(data.id) || {}), ...data });
    }
  });
  if (job.finalStatus === "max_spend") return;

  const detail = job.leaSessionId
    ? await fetchApiSessionDetail({
        fetchImpl: state.fetchImpl || fetch,
        baseUrl: job.leaApiBaseUrl,
        apiKey: state.env?.LEA_API_KEY,
        sessionId: job.leaSessionId
      })
    : { ok: false, error: "Lea adapter did not return a session id." };
  const sessionDetail = detail.ok ? detail.body : {};
  const artifact = validateStubArtifact({
    state,
    job,
    target,
    exit,
    sessionDetail,
    observedCodeSteps: [...observedCodeSteps.values()]
  });
  recordJobUsage(job, exit);
  if (!artifact.ok) {
    job.status = "failed";
    job.finalStatus = "failed";
    job.exitCode = 1;
    job.timedOut = exit.timedOut;
    job.apiRunId = exit.apiRunId || job.apiRunId || null;
    job.error = artifact.error || exit.error || "Lea did not produce a valid sorry stub.";
    job.finishedAt = new Date().toISOString();
    await appendLog(job.logPath, `\n[backend] Stub generation failed: ${job.error}\n`);
    await writeJson(state.jobsPath, state.jobs);
    return;
  }

  job.status = "sorry_stub";
  job.finalStatus = "sorry_stub";
  job.exitCode = 0;
  job.timedOut = exit.timedOut;
  job.apiRunId = exit.apiRunId || job.apiRunId || null;
  job.declarationName = artifact.declarationName;
  job.recordedProofPath = artifact.recordedProofPath;
  job.moduleName = artifact.moduleName;
  job.leanStatement = artifact.leanStatement;
  job.finishedAt = new Date().toISOString();
  delete job.error;

  await upsertProjectTheoremEntry({
    projectMarkdownPath: target.projectMarkdownPath,
    projectId: target.projectSlug,
    theoremName: artifact.declarationName,
    proofPath: artifact.recordedProofPath,
    moduleName: artifact.moduleName,
    signature: artifact.leanStatement,
    description: `Sorry stub generated from Overleaf theorem ${target.theoremLabel}.`,
    solvingProcess: "Stub only: Lean statement translated and checked; proof intentionally left as `sorry`."
  });
  await appendLog(job.logPath, `\n[backend] Stub generated at ${artifact.recordedProofPath}\n`);
  await writeJson(state.jobsPath, state.jobs);
}

function validateStubArtifact({ state, job, target, exit, sessionDetail, observedCodeSteps = [] }) {
  if (exit.timedOut || (!exit.ok && exit.doneStatus !== "answered")) {
    return { ok: false, error: exit.error || `Lea run ended with status: ${exit.doneStatus || "unknown"}.` };
  }
  const stepsById = new Map();
  for (const step of [...observedCodeSteps, ...(Array.isArray(sessionDetail?.code_steps) ? sessionDetail.code_steps : [])]) {
    if (!step?.id) continue;
    stepsById.set(step.id, { ...(stepsById.get(step.id) || {}), ...step });
  }
  const steps = [...stepsById.values()]
    .filter((step) => String(step.path || "").endsWith(".lean"))
    .sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
  const candidates = steps.filter((step) => containsDeclaration(String(step.code || ""), target.theoremLabel));
  const step = candidates[candidates.length - 1];
  if (!step) {
    return { ok: false, error: `Lea did not write a .lean file containing theorem ${target.theoremLabel}.` };
  }
  const code = String(step.code || "");
  if (!/\b(sorry|admit)\b/.test(code)) {
    return { ok: false, error: `The generated file for ${target.theoremLabel} does not contain a sorry/admit stub.` };
  }
  if (step.check_status !== "ok") {
    return { ok: false, error: step.check_detail || "The generated sorry stub did not pass lean_check." };
  }
  const namespace = sessionDetail?.project_namespace || job.projectNamespace || projectNamespaceFromSlug(target.projectSlug);
  const recordedProofPath = proofPathFromProjectStep({ namespace, stepPath: step.path });
  const absolutePath = buildLeaProofPath({ leaRepoPath: state.settings.leaRepoPath, proofPath: recordedProofPath });
  return {
    ok: true,
    declarationName: target.theoremLabel,
    recordedProofPath,
    absolutePath,
    moduleName: moduleNameFromProjectStep({ namespace, stepPath: step.path }),
    leanStatement: extractLeanStatement(code, target.theoremLabel)
  };
}

function buildLeaPrompt({ targetKind, projectSlug, targetLabel, targetText, targetContext = "", declarationNameHint, resolvedUses = [], stubToComplete = null }) {
  if (targetKind === "definition") {
    return buildLeaDefinitionPrompt({
      projectSlug,
      targetLabel,
      targetText,
      targetContext,
      declarationNameHint,
      resolvedUses
    });
  }
  return buildLeaTheoremPrompt({
    projectSlug,
    theoremLabel: targetLabel,
    theoremText: targetText,
    theoremContext: targetContext,
    declarationNameHint,
    resolvedUses,
    stubToComplete
  });
}

function buildLeaTheoremPrompt({ projectSlug, theoremLabel, theoremText, theoremContext = "", declarationNameHint, resolvedUses = [], stubToComplete = null }) {
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
  const stubGuidance = stubToComplete
    ? `\nExisting sorry stub to complete:
- Declaration: ${stubToComplete.declarationName}
- File: ${stubToComplete.absolutePath}
- Statement: ${stubToComplete.leanStatement || "(see file)"}

Continue from this existing file and replace the sorry/admit in theorem ${stubToComplete.declarationName}. Do not delete, rename, or move the file unless Lean requires a minimal import adjustment.\n`
    : "";

  return `Formalize the Overleaf theorem labeled ${theoremLabel} in project ${projectSlug}.
${naming}
${usesGuidance}

${theoremText}
${formalizationGuidance}
${stubGuidance}

Work fully autonomously and non-interactively. This run is triggered from Overleaf with no human available to reply, so do NOT ask for confirmation, do NOT pose clarifying questions, and do NOT stop to propose a statement for approval. If a detail is ambiguous (for example which number type to use), pick the most natural interpretation and proceed without waiting. Do everything in this run: write the Lean file under Lea's workspace and carry the proof through to completion.

The final file must compile with no sorry/admit in theorem ${proofTarget}.
Use the Lea project context to choose the project namespace and proof path.
Do not edit the project markdown during proof search; Lea will record the final result after the proof succeeds.
Do not create placeholder files outside Lea's workspace. If you cannot complete the proof, leave the best partial Lean file in the Lea project proof directory.`;
}

function buildLeaDefinitionPrompt({ projectSlug, targetLabel, targetText, targetContext = "", declarationNameHint, resolvedUses = [] }) {
  const naming = declarationNameHint
    ? `The definition text appears to specify Lean declaration name ${declarationNameHint}; use that name for the primary declaration.`
    : `Use the declaration name ${targetLabel} for the primary declaration unless the text explicitly specifies a better Lean name.`;
  const usesGuidance = resolvedUses.length === 0
    ? ""
    : `\nAvailable already-recorded support declarations:\n${resolvedUses.map((use) => (
      `- ${use.declarationName} at ${use.absolutePath}`
    )).join("\n")}\n`;
  const formalizationGuidance = targetContext.trim()
    ? `\nFormalization guidance:\n${targetContext.trim()}\n`
    : "";

  return `Formalize the Overleaf definition labeled ${targetLabel} in project ${projectSlug}.
This target is a definition, not a theorem.

Create the appropriate Lean declaration or small group of declarations for the mathematical concept described below. Do not create a fake theorem just to satisfy a proof workflow.
If the prose naturally maps to a predicate, prefer a named def.
If it introduces bundled data and properties, consider structure or class.
If it introduces a shorthand, consider abbrev or notation.
${naming}
${usesGuidance}

Work fully autonomously and non-interactively. This run is triggered from Overleaf with no human available to reply, so do NOT ask for confirmation, do NOT pose clarifying questions, and do NOT stop to propose a declaration for approval. If a detail is ambiguous, pick the most natural interpretation and proceed without waiting.

The final Lean file must compile with no sorry/admit.
Use the Lea project context to choose the project namespace and proof path.
Do not edit the project markdown during formalization; Lea will record the final result after the declaration compiles.
Do not create placeholder files outside Lea's workspace.

Overleaf definition text:
${targetText}
${formalizationGuidance}`;
}

function buildLeaStubPrompt({ projectSlug, theoremLabel, theoremText, theoremContext = "", resolvedUses = [] }) {
  const usesGuidance = resolvedUses.length === 0
    ? ""
    : `\nAvailable already-recorded support declarations, if needed for the statement imports only:\n${resolvedUses.map((use) => (
      `- ${use.declarationName} at ${use.absolutePath}`
    )).join("\n")}\n`;
  const formalizationGuidance = theoremContext.trim()
    ? `\nFormalization Guidance: ${theoremContext.trim()}\n`
    : "";

  return `Create a Lean sorry stub for the Overleaf theorem labeled ${theoremLabel} in project ${projectSlug}.

Translate only the theorem statement into Lean. Use the declaration name exactly \`${theoremLabel}\`.
Write exactly one .lean file in the active project namespace/directory, containing the translated theorem or lemma with body:

\`\`\`lean
by
  sorry
\`\`\`

Run lean_check on that file. Stop after the stub compiles; do not try to fill the proof, do not remove the sorry, and do not ask for confirmation.
${usesGuidance}

Overleaf theorem text:
${theoremText}
${formalizationGuidance}

The final file must compile with zero errors, but it must intentionally keep the sorry/admit body for theorem ${theoremLabel}.`;
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
  const current = toPositiveInteger(progress?.current ?? progress?.currentTurn);
  const max = toPositiveInteger(progress?.max ?? progress?.maxTurns) || toPositiveInteger(job.leaMaxTurns);
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

function normalizeLeaMaxSpendUsd(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error("leaMaxSpendUsd must be greater than or equal to 0");
  }
  return number;
}

function spendLimitReached(state) {
  const maxSpendUsd = normalizeLeaMaxSpendUsd(state.settings?.leaMaxSpendUsd);
  if (maxSpendUsd === null) return false;
  return aggregateUsage(state.jobs || {}, {}).costUsd >= maxSpendUsd;
}

async function recordUsageAndEnforceSpendLimit({ state, job, usage, mode }) {
  if (usage.delta) {
    recordJobUsageDelta(job, usage);
  } else {
    recordJobUsageSnapshot(job, usage);
  }
  if (spendLimitReached(state)) {
    await markJobMaxSpend({ state, job, mode });
    return { stop: true, error: MAX_SPEND_MESSAGE };
  }
  await writeJson(state.jobsPath, state.jobs);
  return { stop: false };
}

async function markJobMaxSpend({ state, job, mode }) {
  job.status = "failed";
  job.finalStatus = "max_spend";
  job.error = MAX_SPEND_MESSAGE;
  job.exitCode = 1;
  job.finishedAt = new Date().toISOString();
  await appendLog(job.logPath, `\n[backend] ${MAX_SPEND_MESSAGE}\n`);
  if (job.apiRunId) {
    const cancel = await interruptApiRun({
      fetchImpl: state.fetchImpl || fetch,
      baseUrl: job.leaApiBaseUrl,
      apiKey: state.env?.LEA_API_KEY,
      runId: job.apiRunId
    });
    if (!cancel.ok) {
      await appendLog(job.logPath, `[backend] Failed to interrupt Lea adapter run ${job.apiRunId}: ${cancel.error}\n`);
    }
  } else if (mode) {
    await appendLog(job.logPath, `[backend] Cost cap reached before Lea API run id was available for ${mode}.\n`);
  }
  await writeJson(state.jobsPath, state.jobs);
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

function normalizeLeaUiBaseUrl(value) {
  const text = String(value || DEFAULT_LEA_UI_BASE_URL).trim().replace(/\/+$/, "");
  const parsed = new URL(text);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Lea UI base URL must be http(s).");
  }
  return text;
}

function buildLeaSessionUrl(baseUrl, sessionId) {
  const url = new URL(normalizeLeaUiBaseUrl(baseUrl || DEFAULT_LEA_UI_BASE_URL));
  url.searchParams.set("session", sessionId);
  return url.toString();
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
  const declarationName = job.declarationName || target.declarationName || target.targetLabel;
  const leaSessionId = job.leaSessionId || job.recorderSessionId || null;
  const response = {
    status,
    jobId: job.jobId,
    targetKind: target.targetKind,
    targetLabel: target.targetLabel,
    targetKey: targetKey(target),
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
    leanStatement: job.leanStatement || "",
    logTail: "",
    message: job.error || job.resultDetail || (status === "disproved" ? "Lea found a verified counterexample or disproof. The original theorem was not proven." : ""),
    resultKind: job.resultKind || (status === "disproved" ? "disproved" : status === "formalized" ? (target.targetKind === "definition" ? "defined" : "proved") : null),
    resultDetail: job.resultDetail || null,
    leaSessionId,
    leaSessionUrl: leaSessionId ? buildLeaSessionUrl(job.leaUiBaseUrl, leaSessionId) : null,
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
      targetKind: use.targetKind || "theorem",
      targetLabel: use.targetLabel,
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
      targetKind: normalizeTargetKind(use?.targetKind) || "theorem",
      targetLabel: String(use?.targetLabel || "").trim(),
      moduleName: use?.moduleName || null
    }))
    .filter((use) => use.targetLabel && use.moduleName);
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
      targetKind: use.targetKind,
      theoremLabel: use.targetLabel,
      jobs
    }));
    if (status?.status !== "sorry_stub") {
      continue;
    }

    stubbedUses.push({
      targetKind: use.targetKind,
      targetLabel: use.targetLabel,
      declarationName: status.declarationName,
      moduleName: status.moduleName || use.moduleName,
      relativePath: status.recordedProofPath || status.relativePath || "",
      absolutePath: status.absolutePath || ""
    });
  }

  return stubbedUses;
}

async function getTargetStatus({
  leaRepoPath,
  overleafProjectId = "unknown",
  targetKind,
  targetLabel,
  jobs = {}
}) {
  return getTheoremStatus({
    leaRepoPath,
    overleafProjectId,
    targetKind,
    theoremLabel: targetLabel,
    jobs
  });
}

async function enrichLeanPaneItem({ item, state, overleafProjectId }) {
  const targetKind = item.leanKind === "def" ? "definition" : "theorem";
  const targetLabel = String(item.leanDeclarationName || "").trim();
  if (!isValidLeanIdentifier(targetLabel)) {
    return {
      ...item,
      status: "missing-stub",
      message: "No Lean declaration name is available for artifact lookup."
    };
  }

  const target = buildLeaTarget({
    leaRepoPath: state.settings.leaRepoPath,
    overleafProjectId,
    targetKind,
    targetLabel
  });
  const latestJob = findLatestFinishedJob(state.jobs || {}, target.jobKey);

  let statusInfo;
  try {
    statusInfo = await getTargetStatus({
      leaRepoPath: state.settings.leaRepoPath,
      overleafProjectId,
      targetKind,
      targetLabel,
      jobs: state.jobs || {}
    });
  } catch (error) {
    return {
      ...item,
      status: "error",
      message: error instanceof Error ? error.message : String(error)
    };
  }

  const paneStatus = mapLeanPaneStatus(statusInfo, item);
  const inProgress = String(statusInfo?.status || "").toLowerCase() === "in_progress";
  const stale = Boolean(
    latestJob?.targetTextHash &&
    latestJob.targetTextHash !== item.sourceHash &&
    ["stub-generated", "valid", "defined", "disproved", "invalid"].includes(paneStatus)
  );
  const artifact = await readLeanPaneArtifact({
    leaRepoPath: state.settings.leaRepoPath,
    statusInfo
  });
  const leanDeclarationName = statusInfo?.declarationName || item.leanDeclarationName;
  const sessionArtifact = artifact.content
    ? { relativePath: "", content: "" }
    : await readLeanPaneArtifactFromSession({
        state,
        job: latestJob,
        declarationName: leanDeclarationName
      });
  const effectiveArtifact = artifact.content ? artifact : sessionArtifact;
  const leanStub = statusInfo?.leanStatement || (
    effectiveArtifact.content && leanDeclarationName
      ? extractLeanStatement(effectiveArtifact.content, leanDeclarationName)
      : ""
  );

  return {
    ...item,
    status: stale ? "stale" : paneStatus,
    // Drives the pane's live polling: it keeps refreshing while any item is still
    // being formalized, then stops once everything settles.
    inProgress: inProgress && !stale,
    generatedFromSourceHash: latestJob?.targetTextHash || undefined,
    lastGeneratedAt: latestJob?.finishedAt || latestJob?.startedAt || undefined,
    leanDeclarationName,
    leanStub: leanStub || undefined,
    leanArtifactPath: effectiveArtifact.relativePath || artifact.relativePath || statusInfo?.recordedProofPath || statusInfo?.relativePath || undefined,
    leanArtifactContent: effectiveArtifact.content || undefined,
    message: stale
      ? "The LaTeX source changed after this Lean artifact was generated."
      : statusInfo?.message || undefined
  };
}

// Collapse the prover's run statuses onto the pane's artifact-lifecycle vocabulary.
// Two distinctions matter for product consistency:
//   - a disproof is a *successful* counterexample, never `invalid` (it is not a
//     failed run) — see FEATURE-counterexample-workflows.md;
//   - a formalized definition is `defined`, distinct from a `valid` (proved)
//     theorem — see FEATURE-overleaf-definition-tags.md.
function mapLeanPaneStatus(statusInfo, item) {
  const status = String(statusInfo?.status || "").toLowerCase();
  const effective = String(statusInfo?.effectiveStatus || "").toLowerCase();
  if (status === "unformalized" || status === "unavailable") return "missing-stub";
  if (status === "sorry_stub" || effective === "sorry_stub") return "stub-generated";
  if (status === "formalized") return item?.leanKind === "def" ? "defined" : "valid";
  if (status === "disproved") return "disproved";
  if (status === "failed") return "invalid";
  if (status === "in_progress") return "in-progress";
  return "unknown";
}

async function readLeanPaneArtifactFromSession({ state, job, declarationName }) {
  const sessionId = job?.leaSessionId || job?.recorderSessionId || "";
  if (!sessionId || !declarationName) {
    return { relativePath: "", content: "" };
  }
  let baseUrl;
  try {
    baseUrl = normalizeLeaApiBaseUrl(job.leaApiBaseUrl || state.settings?.leaApiBaseUrl || DEFAULT_LEA_API_BASE_URL);
  } catch {
    return { relativePath: "", content: "" };
  }
  const detail = await fetchApiSessionDetail({
    fetchImpl: state.fetchImpl || fetch,
    baseUrl,
    apiKey: state.env?.LEA_API_KEY,
    sessionId
  });
  if (!detail.ok || !detail.body || typeof detail.body !== "object") {
    return { relativePath: "", content: "" };
  }
  const leanSteps = (Array.isArray(detail.body.code_steps) ? detail.body.code_steps : [])
    .filter((step) => step && String(step.path || "").endsWith(".lean") && String(step.code || "").trim())
    .sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
  const candidates = leanSteps.filter((step) => containsDeclaration(String(step.code || ""), declarationName));
  const step = candidates[candidates.length - 1] || (leanSteps.length === 1 ? leanSteps[0] : null);
  if (!step) {
    return { relativePath: "", content: "" };
  }
  const namespace = detail.body.project_namespace || job.projectNamespace || projectNamespaceFromSlug(job.projectSlug);
  return {
    relativePath: proofPathFromProjectStep({ namespace, stepPath: step.path }),
    content: String(step.code || "")
  };
}

async function readLeanPaneArtifact({ leaRepoPath, statusInfo }) {
  const relativePath = statusInfo?.recordedProofPath ||
    (String(statusInfo?.relativePath || "").endsWith(".lean") ? statusInfo.relativePath : "");
  let absolutePath = relativePath
    ? buildLeaProofPath({ leaRepoPath, proofPath: relativePath })
    : "";
  if (!absolutePath && String(statusInfo?.absolutePath || "").endsWith(".lean")) {
    const resolvedRepo = path.resolve(leaRepoPath);
    const resolvedCandidate = path.resolve(statusInfo.absolutePath);
    if (resolvedCandidate === resolvedRepo || resolvedCandidate.startsWith(`${resolvedRepo}${path.sep}`)) {
      absolutePath = resolvedCandidate;
    }
  }
  if (!absolutePath || !existsSync(absolutePath)) {
    return { relativePath, content: "" };
  }
  try {
    return {
      relativePath: relativePath || relativeToLeaRepo({ leaRepoPath, absolutePath }),
      content: await fs.readFile(absolutePath, "utf8")
    };
  } catch {
    return { relativePath, content: "" };
  }
}

async function resolveTargetUseStatus({
  leaRepoPath,
  overleafProjectId = "unknown",
  targetLabel,
  jobs = {}
}) {
  for (const targetKind of ["theorem", "definition"]) {
    const status = await getTargetStatus({ leaRepoPath, overleafProjectId, targetKind, targetLabel, jobs });
    if (["formalized", "sorry_stub"].includes(getEquivalentTheoremStatus(status).status)) {
      return status;
    }
  }
  return getTargetStatus({ leaRepoPath, overleafProjectId, targetKind: "theorem", targetLabel, jobs });
}

async function getTheoremStatus({
  leaRepoPath,
  overleafProjectId = "unknown",
  targetKind = "theorem",
  theoremLabel,
  jobs = {}
}) {
  const target = buildLeaTarget({ leaRepoPath, overleafProjectId, targetKind, targetLabel: theoremLabel });
  const linkedJob = findLatestJobWithLeaSession(jobs, target.jobKey);
  const withLeaSession = (status) => addLeaSessionLink(status, linkedJob);
  const activeJob = findActiveJob(jobs, target.jobKey);

  // A manual edit (or a cascade re-check triggered by editing something this
  // target imports) may have broken a target that would otherwise still read
  // as "formalized" below -- mappedStatus/directProofStatus only re-derive
  // "formalized" from a `sorry`/`admit` regex over the CURRENT file content,
  // not a real compile. lastEditCheckStatus carries the actual `lean_check`
  // verdict recorded by handleLeanPaneEditSave (docs/FEATURE-overleaf-lean-pane-manual-edit.md).
  // Checked first, ahead of every other status source, so a fresh compiler
  // result always wins over a stale regex re-derivation of an old job's
  // outcome -- and cleared (lastEditCheckStatus "ok") once an edit compiles
  // again, so the normal chain resumes deciding status as before.
  //
  // Scope note: this only covers getTheoremStatus (the pane's per-item status
  // source). getCurrentTheoremProofStatus, used by `uses=` dependency
  // resolution at formalize time, does not yet honor this override -- left
  // as-is for this fix, which is scoped to the pane status chip.
  if (!activeJob && linkedJob?.lastEditCheckStatus === "error") {
    return withLeaSession(buildEditBrokenTheoremStatus({ linkedJob, target }));
  }

  const { projectStatus, directProofStatus, mappedStatus } = await getCurrentTheoremProofStatuses({
    leaRepoPath,
    target,
    jobs,
    includeStubbedTheoremUses: true
  });
  const failedJob = findLatestJob(jobs, target.jobKey, "failed");
  const formalizedJob = findLatestJob(jobs, target.jobKey, "formalized");
  const disprovedJob = findLatestJob(jobs, target.jobKey, "disproved");

  if (activeJob) {
    if (
      mappedStatus?.status === "formalized" ||
      projectStatus?.status === "formalized" ||
      directProofStatus?.status === "formalized"
    ) {
      return withLeaSession(mappedStatus?.status === "formalized"
        ? mappedStatus
        : projectStatus?.status === "formalized"
          ? projectStatus
          : directProofStatus);
    }
    return buildJobResponse({ job: activeJob, status: "in_progress", target });
  }

  if (mappedStatus?.status === "formalized") {
    return withLeaSession(mappedStatus);
  }

  if (directProofStatus?.status === "formalized") {
    return withLeaSession(directProofStatus);
  }

  // Authoritative outcome: a finished job the finalizer recorded as `formalized`
  // means the adapter verified the proof, even when project-markdown recording is
  // deferred and no local file evidence (mapped/project/direct) could be found.
  // Surface it as formalized so the Overleaf tag matches the job record. Guard on
  // recency so a later failed re-run is not shadowed by a stale verified outcome.
  if (
    formalizedJob &&
    (!failedJob ||
      String(formalizedJob.finishedAt || formalizedJob.startedAt) >=
        String(failedJob.finishedAt || failedJob.startedAt)) &&
    (!disprovedJob ||
      String(formalizedJob.finishedAt || formalizedJob.startedAt) >=
        String(disprovedJob.finishedAt || disprovedJob.startedAt))
  ) {
    return withLeaSession(buildJobResponse({ job: formalizedJob, status: "formalized", target }));
  }

  if (
    disprovedJob &&
    (!failedJob ||
      String(disprovedJob.finishedAt || disprovedJob.startedAt) >=
        String(failedJob.finishedAt || failedJob.startedAt)) &&
    (!formalizedJob ||
      String(disprovedJob.finishedAt || disprovedJob.startedAt) >=
        String(formalizedJob.finishedAt || formalizedJob.startedAt))
  ) {
    return withLeaSession(buildJobResponse({ job: disprovedJob, status: "disproved", target }));
  }

  if (failedJob) {
    return withLeaSession(buildFailedTheoremStatus({
      failedJob,
      target,
      equivalentStatus: mappedStatus || projectStatus || directProofStatus,
      logTail: await readLogTail(failedJob.logPath)
    }));
  }

  if (projectStatus?.status === "formalized") {
    return withLeaSession(projectStatus);
  }

  if (mappedStatus) {
    return withLeaSession(mappedStatus);
  }

  if (projectStatus) {
    return withLeaSession(projectStatus);
  }
  if (directProofStatus) {
    return withLeaSession(directProofStatus);
  }

  return {
    status: "unformalized",
    targetKind,
    targetLabel: theoremLabel,
    targetKey: targetKey({ targetKind, targetLabel: theoremLabel }),
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
  targetKind = "theorem",
  theoremLabel,
  jobs = {}
}) {
  const target = buildLeaTarget({ leaRepoPath, overleafProjectId, targetKind, targetLabel: theoremLabel });
  const { mappedStatus, projectStatus, directProofStatus } = await getCurrentTheoremProofStatuses({
    leaRepoPath,
    target,
    jobs
  });
  return mappedStatus || projectStatus || directProofStatus || {
    status: "unformalized",
    targetKind,
    targetLabel: theoremLabel,
    targetKey: targetKey({ targetKind, targetLabel: theoremLabel }),
    declarationName: theoremLabel,
    relativePath: target.relativePath,
    absolutePath: target.absolutePath,
    projectId: target.projectId,
    projectSlug: target.projectSlug,
    projectMarkdownPath: target.projectMarkdownPath
  };
}

// The status shape for a target whose latest recorded lean_check verdict
// (from a manual edit or a cascade re-check, see the lastEditCheckStatus
// comment in getTheoremStatus) came back non-"ok". Deliberately built the
// same way buildFailedTheoremStatus is: status "failed" so mapLeanPaneStatus
// maps it to the pane's existing "invalid" chip with zero new rendering
// logic, and `message` carries the real compiler diagnostic where the pane
// already shows a failed item's reason.
function buildEditBrokenTheoremStatus({ linkedJob, target }) {
  const base = buildJobResponse({ job: linkedJob, status: "failed", target });
  return {
    ...base,
    effectiveStatus: "unformalized",
    message: linkedJob.lastEditCheckDetail || "This item no longer compiles after a manual edit.",
    brokenByEdit: true
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
    targetKind: target.targetKind,
    targetLabel: target.targetLabel,
    targetKey: targetKey(target),
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
    resultKind: target.targetKind === "definition" ? "defined" : "proved",
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
    targetKind: target.targetKind,
    targetLabel: target.targetLabel,
    targetKey: targetKey(target),
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
    resultKind: target.targetKind === "definition" ? "defined" : "proved",
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
  addLeaSessionLink(status, mappedJob);
  if (!includeStubbedTheoremUses) {
    return status;
  }
  const stubbedTheoremUses = status.status === "formalized"
    ? await findImportedCurrentlyStubbedTheoremUses({
      leaRepoPath,
      overleafProjectId: target.projectId,
      proofPath: status.absolutePath,
      resolvedUses: Array.isArray(mappedJob.targetUses) && mappedJob.targetUses.length > 0
        ? mappedJob.targetUses
        : mappedJob.stubbedTheoremUses || [],
      jobs
    })
    : [];
  return addStubbedTheoremUses(status, stubbedTheoremUses);
}

function addLeaSessionLink(status, job) {
  // Prefer the adapter session id (set on run start, what the Lea UI lists and
  // deep-links by) and fall back to the recorder session id. The recorder CLI is
  // a stub in many setups, so keying only off recorderSessionId left formalized
  // theorems with no session link (and no "View in Lea UI" button).
  const sessionId = job?.leaSessionId || job?.recorderSessionId || null;
  if (!status || !sessionId) {
    return status;
  }
  status.leaSessionId = sessionId;
  status.leaSessionUrl = buildLeaSessionUrl(job.leaUiBaseUrl, sessionId);
  return status;
}

function findLatestJobWithLeaSession(jobs, jobKey) {
  return Object.values(jobs || {})
    .filter((job) => job.jobKey === jobKey && (job.leaSessionId || job.recorderSessionId))
    .sort((a, b) => String(b.finishedAt || b.startedAt).localeCompare(String(a.finishedAt || a.startedAt)))[0] || null;
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

function findNamedSectionHeadingStart(markdown, markerStart, heading) {
  const beforeMarker = markdown.slice(0, markerStart);
  const pattern = `\n## ${heading}`;
  const headingIndex = beforeMarker.lastIndexOf(pattern);
  if (headingIndex !== -1) {
    return headingIndex;
  }
  return beforeMarker.startsWith(`## ${heading}`) ? 0 : markerStart;
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
    `(^|\\n)\\s*(?:@\\[[^\\n]*\\]\\s*)*(?:(?:private|protected|noncomputable|unsafe|partial)\\s+)*(?:theorem|lemma|def|abbrev|structure|class)\\s+${escapeRegExp(theoremLabel)}\\b`
  );
  return declarationPattern.test(content);
}

function extractLeanStatement(content, theoremLabel) {
  const declarationPattern = new RegExp(
    `(^|\\n)\\s*(?:@\\[[^\\n]*\\]\\s*)*(?:(?:private|protected|noncomputable|unsafe|partial)\\s+)*(?:theorem|lemma|def|abbrev|structure|class)\\s+${escapeRegExp(theoremLabel)}\\b[\\s\\S]*?(?::=|where|$)`
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

function errorResponse(statusCode, error, message, field) {
  const body = { error, message };
  if (field) body.field = field;
  return { statusCode, body };
}

const isMain = fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const dotenv = loadDotEnv();
  if (dotenv.loaded) {
    console.log(`Loaded root environment from ${dotenv.path}`);
  }
  const server = await createServer();
  server.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
    console.log(`Overleaf Lea companion listening at http://${DEFAULT_HOST}:${DEFAULT_PORT}`);
    console.log(`Lea workspace: ${buildLeaWorkspacePath(applyEnvDefaults({}, process.env).leaRepoPath)}`);
    if (!process.env.OPENAI_API_KEY) {
      console.log("Warning: OPENAI_API_KEY is not set in the root .env or process environment. Lea jobs will not start.");
    }
    console.log("Run `npm run doctor` if setup fails.");
  });
}
