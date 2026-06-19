// Lea standalone adapter client for the Overleaf companion.
//
// The adapter (apps/lea-standalone/adapter, :8001) drives the prover in-process.
// A run is started with POST /api/runs, then driven and observed by opening its
// SSE event stream. Per-run config lives in config/lea.local.toml; the companion
// passes the prompt, provenance, and optional session/project metadata.

const TOOL_APPROVAL_DECISION = "always_session";

// done.status values the adapter emits (see bridge._FINISH_STATUS + run_lea):
//   success | answered | max_turns | cancelled | failed
// For a *formalization* job only "success" (the agent passed final verification)
// counts as ok; "answered" finished cleanly but proved nothing.
const SUCCESS_DONE_STATUS = new Set(["success"]);

function toNonNegativeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function decodeChunk(chunk) {
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return new TextDecoder().decode(chunk);
  return String(chunk);
}

async function* iterateResponseBody(body) {
  if (!body) return;
  if (body[Symbol.asyncIterator]) {
    yield* body;
    return;
  }
  if (!body.getReader) return;
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

// Parse one SSE frame ("event: <type>\ndata: <json>") into { type, data }.
// The adapter encodes the event name on the `event:` line and the payload on
// `data:` lines.
export function parseSseFrame(frame) {
  let type = "message";
  const dataLines = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    if (rawLine.startsWith("event:")) {
      type = rawLine.slice("event:".length).trim();
    } else if (rawLine.startsWith("data:")) {
      dataLines.push(rawLine.slice("data:".length).replace(/^ /, ""));
    }
  }
  const dataText = dataLines.join("\n").trim();
  if (!dataText) return { type, data: null };
  try {
    return { type, data: JSON.parse(dataText) };
  } catch {
    return { type, data: null };
  }
}

function buildHeaders(apiKey, extra = {}) {
  const headers = { ...extra };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

async function fetchJson(fetchImpl, url, options) {
  let response;
  try {
    response = await fetchImpl(url, options);
  } catch (error) {
    return { ok: false, error: `Request to ${url} failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  let body = null;
  const text = await response.text().catch(() => "");
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!response.ok) {
    const rawDetail = body?.detail ?? body?.error ?? text ?? `HTTP ${response.status}`;
    const detail =
      rawDetail && typeof rawDetail === "object"
        ? rawDetail.message || JSON.stringify(rawDetail)
        : rawDetail;
    return { ok: false, status: response.status, error: `HTTP ${response.status}: ${detail}`, body };
  }
  return { ok: true, status: response.status, body };
}

// --- Shared settings delegation -------------------------------------------
// The adapter's `config/lea.local.toml` (served by GET/PUT /api/settings) is the
// single source of truth for the settings shared with the lea-standalone UI:
// `model`, `max_turns`, `max_spend_usd`, and provider `api_keys`. The companion
// reads them here and writes them via `putAdapterSettings`, instead of keeping
// its own divergent copies, so a change in either UI shows up in both.

export function fetchAdapterSettings({ fetchImpl, baseUrl }) {
  return fetchJson(fetchImpl, `${baseUrl}/api/settings`, {
    method: "GET",
    headers: buildHeaders(null),
  });
}

export function putAdapterSettings({ fetchImpl, baseUrl, body }) {
  return fetchJson(fetchImpl, `${baseUrl}/api/settings`, {
    method: "PUT",
    headers: buildHeaders(null, { "Content-Type": "application/json" }),
    body: JSON.stringify(body || {}),
  });
}

// The adapter's GET /api/stats (store.usage_stats) is the single source of truth
// for usage the lea-standalone Stats page renders: `global` all-time rollups and
// per-`sessions` rows (each carrying `project_slug`). The companion reads it here
// so the Overleaf popover shows the exact same numbers instead of its own
// in-memory job tally.
export function fetchAdapterUsageStats({ fetchImpl, baseUrl }) {
  return fetchJson(fetchImpl, `${baseUrl}/api/stats`, {
    method: "GET",
    headers: buildHeaders(null),
  });
}

export async function startApiRun({ fetchImpl, baseUrl, apiKey, message, sessionId = null, autonomous = true, projectSlug = null, projectTitle = null, origin = null, originUrl = null }) {
  // `autonomous: true` tells the adapter to run with no per-tool approval gate and
  // the non-interactive `default` prompt variant, so the Overleaf job formalizes
  // end-to-end with zero human interaction. (The client also auto-resolves any
  // approval events below as a belt-and-suspenders, but an autonomous run emits
  // none.) Defaults true because this client is the autonomous Overleaf path.
  //
  // `projectSlug` is the Overleaf document namespace (slugProjectId). When present
  // the adapter tags the session+run with a project of that slug, so the popover's
  // "This project" usage can be summed per document. Omitted for the interactive
  // UI path, which stays project-less.
  //
  // `origin` / `originUrl` record session providence: 'overleaf' + the canonical
  // Overleaf document URL, so the Lea UI can show an origin indicator and open/focus
  // the source document. Independent of the project usage-namespace above.
  const body = { message, autonomous };
  if (sessionId) body.session_id = sessionId;
  if (projectSlug) {
    body.project_slug = projectSlug;
    body.project_title = projectTitle || projectSlug;
  }
  if (origin) body.origin = origin;
  if (originUrl) body.origin_url = originUrl;
  return fetchJson(fetchImpl, `${baseUrl}/api/runs`, {
    method: "POST",
    headers: buildHeaders(apiKey, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
}

export function resolveApiApproval({ fetchImpl, baseUrl, apiKey, runId, approvalId, decision = TOOL_APPROVAL_DECISION }) {
  return fetchJson(fetchImpl, `${baseUrl}/api/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`, {
    method: "POST",
    headers: buildHeaders(apiKey, { "Content-Type": "application/json" }),
    body: JSON.stringify({ decision }),
  });
}

export function interruptApiRun({ fetchImpl, baseUrl, apiKey, runId }) {
  return fetchJson(fetchImpl, `${baseUrl}/api/runs/${encodeURIComponent(runId)}/interrupt`, {
    method: "POST",
    headers: buildHeaders(apiKey),
  });
}

// Pull this run's usage/cost back off the persisted run row (no usage events on
// the wire). Best-effort: any shape mismatch yields zeroes.
export async function fetchApiRunUsage({ fetchImpl, baseUrl, apiKey, sessionId, runId }) {
  const detail = await fetchJson(fetchImpl, `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "GET",
    headers: buildHeaders(apiKey),
  });
  const empty = { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, costUsd: 0 };
  if (!detail.ok || !detail.body) return empty;
  const runs = Array.isArray(detail.body.runs) ? detail.body.runs : [];
  const run = runs.find((r) => r && r.id === runId) || null;
  const source = run || detail.body.usage || {};
  const inputTokens = toNonNegativeNumber(source.input_tokens ?? source.inputTokens);
  const outputTokens = toNonNegativeNumber(source.output_tokens ?? source.outputTokens);
  const costUsd = toNonNegativeNumber(source.cost_usd ?? source.costUsd ?? run?.cost_usd);
  return {
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    costUsd,
  };
}

function deriveTurnProgress(payload, defaultMaxTurns) {
  if (!payload || typeof payload !== "object") return null;
  const turn = Number(payload.turn);
  if (!Number.isFinite(turn) || turn <= 0) return null;
  return { currentTurn: turn, maxTurns: defaultMaxTurns ?? null };
}

// Drive + observe one run to terminal `done`. Opening the stream is what runs the
// job adapter-side; auto-approving keeps it autonomous. Returns the terminal
// outcome (NOT usage — caller reads that back via fetchApiRunUsage).
export async function streamApiRun({
  fetchImpl,
  baseUrl,
  apiKey,
  runId,
  maxTurns = null,
  autoApprove = true,
  onEvent = null,
  onProgressUpdated = null,
  signal = null,
}) {
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/api/runs/${encodeURIComponent(runId)}/events`, {
      method: "GET",
      headers: buildHeaders(apiKey),
      signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") return { ok: false, aborted: true, error: "Run stream aborted." };
    return { ok: false, error: `Could not open run event stream: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!response?.ok || !response.body) {
    return { ok: false, error: `Run event stream returned HTTP ${response?.status ?? "?"}.` };
  }

  let doneStatus = null;
  let runError = null;
  let buffer = "";

  const handleFrame = async (frame) => {
    const { type, data } = parseSseFrame(frame);
    if (!type) return;
    if (onEvent) await onEvent(type, data);
    if (onProgressUpdated) {
      const progress = deriveTurnProgress(data, maxTurns);
      if (progress) await onProgressUpdated(progress);
    }
    if (type === "approval_requested" && autoApprove && data?.approval_id) {
      await resolveApiApproval({ fetchImpl, baseUrl, apiKey, runId, approvalId: data.approval_id });
    } else if (type === "run_error") {
      runError = data?.message || "Lea run error.";
    } else if (type === "done") {
      doneStatus = String(data?.status || "").toLowerCase();
    }
  };

  try {
    for await (const chunk of iterateResponseBody(response.body)) {
      buffer += decodeChunk(chunk);
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || "";
      for (const frame of frames) {
        if (frame.trim()) await handleFrame(frame);
      }
      if (doneStatus !== null) break;
    }
    if (doneStatus === null && buffer.trim()) await handleFrame(buffer);
  } catch (error) {
    if (error?.name === "AbortError") return { ok: false, aborted: true, error: runError || "Run stream aborted." };
    return { ok: false, error: `Run event stream failed: ${error instanceof Error ? error.message : String(error)}`, doneStatus, runError };
  }

  const ok = doneStatus !== null && SUCCESS_DONE_STATUS.has(doneStatus);
  return {
    ok,
    doneStatus,
    error: ok ? null : (runError || (doneStatus ? `Lea run ended with status: ${doneStatus}` : "Lea run ended without a terminal status.")),
  };
}

// High-level: start a run and drive it to completion, returning the shape the
// companion orchestration consumes:
// { ok, timedOut, apiRunId, error, usage, costUsd }.
export async function runApiProofJob({
  fetchImpl,
  baseUrl,
  apiKey,
  message,
  sessionId = null,
  maxTurns = null,
  timeoutMs = 900000,
  autoApprove = true,
  autonomous = true,
  projectSlug = null,
  projectTitle = null,
  origin = null,
  originUrl = null,
  appendLog = null,
  logPath = null,
  onRunStarted = null,
  onProgressUpdated = null,
}) {
  const log = async (line) => {
    if (appendLog && logPath) await appendLog(logPath, line);
  };

  const start = await startApiRun({ fetchImpl, baseUrl, apiKey, message, sessionId, autonomous, projectSlug, projectTitle, origin, originUrl });
  if (!start.ok) return { ok: false, timedOut: false, error: start.error };

  const runId = start.body?.run_id;
  const newSessionId = start.body?.session_id || sessionId;
  if (!runId) return { ok: false, timedOut: false, error: "Lea adapter did not return a run_id." };
  await log(`[backend] Lea adapter run started: ${runId} (session ${newSessionId})\n`);
  if (onRunStarted) await onRunStarted(runId, newSessionId);

  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
    interruptApiRun({ fetchImpl, baseUrl, apiKey, runId }).catch(() => {});
  }, Math.max(1, timeoutMs));
  if (typeof timer.unref === "function") timer.unref();

  let outcome;
  try {
    outcome = await streamApiRun({
      fetchImpl, baseUrl, apiKey, runId, maxTurns, autoApprove,
      signal: abort.signal, onProgressUpdated,
    });
  } finally {
    clearTimeout(timer);
  }

  const usage = await fetchApiRunUsage({ fetchImpl, baseUrl, apiKey, sessionId: newSessionId, runId });

  if (timedOut) {
    return { ok: false, timedOut: true, apiRunId: runId, sessionId: newSessionId, error: "Lea adapter run timed out.", ...usage };
  }
  return {
    ok: outcome.ok,
    timedOut: false,
    apiRunId: runId,
    sessionId: newSessionId,
    doneStatus: outcome.doneStatus,
    error: outcome.ok ? undefined : outcome.error,
    ...usage,
  };
}
