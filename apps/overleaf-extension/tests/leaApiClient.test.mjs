import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSseFrame,
  runApiProofJob,
} from "../companion/leaApiClient.mjs";

const encoder = new TextEncoder();

function jsonResponse(obj, ok = true, status = 200) {
  return { ok, status, async text() { return JSON.stringify(obj); } };
}

// A streaming SSE response whose body is an async iterable of byte chunks.
function sseResponse(frames, { chunkSize = null } = {}) {
  const text = frames.map((f) => `${f}\n\n`).join("");
  async function* body() {
    if (chunkSize) {
      for (let i = 0; i < text.length; i += chunkSize) {
        yield encoder.encode(text.slice(i, i + chunkSize));
      }
    } else {
      yield encoder.encode(text);
    }
  }
  return { ok: true, status: 200, body: body(), async text() { return ""; } };
}

function frame(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}`;
}

test("parseSseFrame reads the event name off the event: line, not the data body", () => {
  const { type, data } = parseSseFrame("event: code_step\ndata: {\"id\":\"s1\",\"turn\":2}");
  assert.equal(type, "code_step");
  assert.deepEqual(data, { id: "s1", turn: 2 });
});

test("parseSseFrame tolerates a missing/blank data line", () => {
  const { type, data } = parseSseFrame("event: done");
  assert.equal(type, "done");
  assert.equal(data, null);
});

test("runApiProofJob: success done → ok with usage read back from the run row", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET" });
    if (url.endsWith("/api/runs") && options.method === "POST") {
      return jsonResponse({ session_id: "sess-1", run_id: "run-1" });
    }
    if (url.includes("/api/runs/run-1/events")) {
      return sseResponse([
        frame("status", { status: "tool_call", message: "Running write_file", turn: 1 }),
        frame("code_step", { id: "cs1", turn: 1 }),
        frame("done", { status: "success" }),
      ], { chunkSize: 7 });
    }
    if (url.includes("/api/sessions/sess-1")) {
      return jsonResponse({ runs: [{ id: "run-1", input_tokens: 100, output_tokens: 40, cost_usd: 0.012 }] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const progress = [];
  const result = await runApiProofJob({
    fetchImpl,
    baseUrl: "http://127.0.0.1:8001",
    message: "Formalize foo",
    timeoutMs: 5000,
    onProgressUpdated: async (p) => progress.push(p),
  });

  assert.equal(result.ok, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.apiRunId, "run-1");
  assert.equal(result.sessionId, "sess-1");
  assert.equal(result.doneStatus, "success");
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 40, totalTokens: 140 });
  assert.equal(result.costUsd, 0.012);
  assert.ok(progress.some((p) => p.currentTurn === 1));
});

test("runApiProofJob: disproved done → ok with disproof result kind", async () => {
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/api/runs") && options.method === "POST") {
      return jsonResponse({ session_id: "sess-d", run_id: "run-d" });
    }
    if (url.includes("/api/runs/run-d/events")) {
      return sseResponse([frame("done", { status: "disproved", result_kind: "disproved", result_detail: "DISPROVED" })]);
    }
    if (url.includes("/api/sessions/sess-d")) {
      return jsonResponse({ runs: [{ id: "run-d", input_tokens: 1, output_tokens: 2, cost_usd: 0.003 }] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const result = await runApiProofJob({
    fetchImpl,
    baseUrl: "http://127.0.0.1:8001",
    message: "Find a counterexample",
    timeoutMs: 5000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.doneStatus, "disproved");
  assert.equal(result.resultKind, "disproved");
  assert.equal(result.resultDetail, "DISPROVED");
});

test("runApiProofJob: forwards origin/origin_url + project tags to POST /api/runs", async () => {
  let postBody = null;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/api/runs") && options.method === "POST") {
      postBody = JSON.parse(options.body);
      return jsonResponse({ session_id: "sess-o", run_id: "run-o" });
    }
    if (url.includes("/api/runs/run-o/events")) {
      return sseResponse([frame("done", { status: "success" })]);
    }
    if (url.includes("/api/sessions/sess-o")) {
      return jsonResponse({ runs: [{ id: "run-o", input_tokens: 0, output_tokens: 0, cost_usd: 0 }] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  await runApiProofJob({
    fetchImpl,
    baseUrl: "http://127.0.0.1:8001",
    message: "Formalize foo",
    timeoutMs: 5000,
    projectSlug: "doc-a",
    projectTitle: "Doc A",
    origin: "overleaf",
    originUrl: "https://www.overleaf.com/project/doc-a",
  });

  assert.equal(postBody.origin, "overleaf");
  assert.equal(postBody.origin_url, "https://www.overleaf.com/project/doc-a");
  assert.equal(postBody.project_slug, "doc-a");
});

test("runApiProofJob: omits origin fields when not provided (interactive parity)", async () => {
  let postBody = null;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/api/runs") && options.method === "POST") {
      postBody = JSON.parse(options.body);
      return jsonResponse({ session_id: "sess-n", run_id: "run-n" });
    }
    if (url.includes("/api/runs/run-n/events")) {
      return sseResponse([frame("done", { status: "success" })]);
    }
    if (url.includes("/api/sessions/sess-n")) {
      return jsonResponse({ runs: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  await runApiProofJob({ fetchImpl, baseUrl: "http://127.0.0.1:8001", message: "go", timeoutMs: 5000 });

  assert.equal("origin" in postBody, false);
  assert.equal("origin_url" in postBody, false);
});

test("runApiProofJob: auto-approves a gated tool call so the run stays autonomous", async () => {
  const approvalCalls = [];
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/api/runs") && options.method === "POST") {
      return jsonResponse({ session_id: "sess-2", run_id: "run-2" });
    }
    if (url.includes("/api/runs/run-2/events")) {
      return sseResponse([
        frame("approval_requested", { approval_id: "appr-1", tool_name: "bash", args: {} }),
        frame("approval_resolved", { approval_id: "appr-1", decision: "always_session" }),
        frame("done", { status: "success" }),
      ]);
    }
    if (url.includes("/api/runs/run-2/approvals/appr-1") && options.method === "POST") {
      approvalCalls.push(JSON.parse(options.body));
      return jsonResponse({ status: "resolved" });
    }
    if (url.includes("/api/sessions/sess-2")) {
      return jsonResponse({ runs: [{ id: "run-2", input_tokens: 0, output_tokens: 0, cost_usd: 0 }] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const result = await runApiProofJob({ fetchImpl, baseUrl: "http://127.0.0.1:8001", message: "go", timeoutMs: 5000 });
  assert.equal(result.ok, true);
  assert.deepEqual(approvalCalls, [{ decision: "always_session" }]);
});

test("runApiProofJob: non-completed terminal status → not ok with a descriptive error", async () => {
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/api/runs") && options.method === "POST") {
      return jsonResponse({ session_id: "sess-3", run_id: "run-3" });
    }
    if (url.includes("/api/runs/run-3/events")) {
      return sseResponse([frame("done", { status: "max_turns" })]);
    }
    if (url.includes("/api/sessions/sess-3")) {
      return jsonResponse({ runs: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const result = await runApiProofJob({ fetchImpl, baseUrl: "http://127.0.0.1:8001", message: "go", timeoutMs: 5000 });
  assert.equal(result.ok, false);
  assert.match(result.error, /max_turns/);
});

test("runApiProofJob: a run_error frame surfaces as the failure reason", async () => {
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/api/runs") && options.method === "POST") {
      return jsonResponse({ session_id: "sess-4", run_id: "run-4" });
    }
    if (url.includes("/api/runs/run-4/events")) {
      return sseResponse([
        frame("run_error", { message: "Another Lea run is already active." }),
        frame("done", { status: "failed" }),
      ]);
    }
    if (url.includes("/api/sessions/sess-4")) {
      return jsonResponse({ runs: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const result = await runApiProofJob({ fetchImpl, baseUrl: "http://127.0.0.1:8001", message: "go", timeoutMs: 5000 });
  assert.equal(result.ok, false);
  assert.match(result.error, /already active/);
});

// --- single-run-slot queueing -------------------------------------------------
// The adapter starts a run only when its event stream first attaches, and 409s
// the attach while another run holds the single-run slot. That is "wait your
// turn", not "the proof failed": the client must keep the created run and
// re-attach until the slot frees.

test("runApiProofJob: 409 on stream attach while the run is still pending → waits and re-attaches", async () => {
  let eventsCalls = 0;
  const logLines = [];
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/api/runs") && options.method === "POST") {
      return jsonResponse({ session_id: "sess-q", run_id: "run-q" });
    }
    if (url.includes("/api/runs/run-q/events")) {
      eventsCalls += 1;
      if (eventsCalls <= 2) {
        return jsonResponse({ detail: "Another Lea run is already active." }, false, 409);
      }
      return sseResponse([frame("done", { status: "proved" })]);
    }
    if (url.includes("/api/sessions/sess-q")) {
      return jsonResponse({ runs: [{ id: "run-q", status: "pending", input_tokens: 5, output_tokens: 3, cost_usd: 0.001 }] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const result = await runApiProofJob({
    fetchImpl,
    baseUrl: "http://127.0.0.1:8001",
    message: "Formalize queued",
    timeoutMs: 5000,
    busyRetryDelayMs: 5,
    appendLog: async (_path, line) => logLines.push(line),
    logPath: "/dev/null",
  });

  assert.equal(eventsCalls, 3);
  assert.equal(result.ok, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.doneStatus, "proved");
  assert.ok(logLines.some((l) => l.includes("waiting for the run slot")));
});

test("runApiProofJob: 409 but the run row is already terminal → adopts that outcome, no retry loop", async () => {
  let eventsCalls = 0;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/api/runs") && options.method === "POST") {
      return jsonResponse({ session_id: "sess-t", run_id: "run-t" });
    }
    if (url.includes("/api/runs/run-t/events")) {
      eventsCalls += 1;
      return jsonResponse({ detail: "Run has already completed" }, false, 409);
    }
    if (url.includes("/api/sessions/sess-t")) {
      return jsonResponse({ runs: [{ id: "run-t", status: "failed", result_kind: "failed", result_detail: "Interrupted before the run started." }] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const result = await runApiProofJob({
    fetchImpl,
    baseUrl: "http://127.0.0.1:8001",
    message: "Formalize terminal",
    timeoutMs: 5000,
    busyRetryDelayMs: 5,
  });

  assert.equal(eventsCalls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.doneStatus, "failed");
  assert.equal(result.resultDetail, "Interrupted before the run started.");
  assert.match(result.error, /failed/);
});

test("runApiProofJob: still queued at the deadline → times out and interrupts the pending run", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET" });
    if (url.endsWith("/api/runs") && options.method === "POST") {
      return jsonResponse({ session_id: "sess-w", run_id: "run-w" });
    }
    if (url.includes("/api/runs/run-w/interrupt")) {
      return jsonResponse({ status: "interrupted" });
    }
    if (url.includes("/api/runs/run-w/events")) {
      return jsonResponse({ detail: "Another Lea run is already active." }, false, 409);
    }
    if (url.includes("/api/sessions/sess-w")) {
      return jsonResponse({ runs: [{ id: "run-w", status: "pending" }] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const result = await runApiProofJob({
    fetchImpl,
    baseUrl: "http://127.0.0.1:8001",
    message: "Formalize starved",
    timeoutMs: 40,
    busyRetryDelayMs: 5,
  });

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.ok(calls.some((c) => c.url.includes("/api/runs/run-w/interrupt") && c.method === "POST"));
});

test("runApiProofJob: a non-409 stream failure still fails immediately (no retry)", async () => {
  let eventsCalls = 0;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/api/runs") && options.method === "POST") {
      return jsonResponse({ session_id: "sess-e", run_id: "run-e" });
    }
    if (url.includes("/api/runs/run-e/events")) {
      eventsCalls += 1;
      return jsonResponse({ detail: "boom" }, false, 500);
    }
    if (url.includes("/api/sessions/sess-e")) {
      return jsonResponse({ runs: [{ id: "run-e", status: "pending" }] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const result = await runApiProofJob({
    fetchImpl,
    baseUrl: "http://127.0.0.1:8001",
    message: "Formalize broken",
    timeoutMs: 5000,
    busyRetryDelayMs: 5,
  });

  assert.equal(eventsCalls, 1);
  assert.equal(result.ok, false);
  assert.match(result.error, /HTTP 500/);
});

// --- mid-stream drop re-attach (AUDIT H4) ------------------------------------
// An already-attached stream that ends WITHOUT a terminal `done` frame (a
// transport drop / adapter hiccup) does not mean the run failed — the run may
// still be executing. The client consults the run row: re-attaches while it's
// pending/running, adopts its outcome once terminal, and only gives up (and
// interrupts) when the adapter is genuinely unreachable.

test("runApiProofJob: stream drops with no done frame, run row is terminal → adopts it (no false failure)", async () => {
  let eventsCalls = 0;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/api/runs") && options.method === "POST") {
      return jsonResponse({ session_id: "sess-d", run_id: "run-d" });
    }
    if (url.includes("/api/runs/run-d/events")) {
      eventsCalls += 1;
      // A stream that yields a progress frame then ends — never a `done`.
      return sseResponse([frame("status", { status: "tool_call", turn: 1 })]);
    }
    if (url.includes("/api/sessions/sess-d")) {
      // The run actually finished proving while we were detached.
      return jsonResponse({ runs: [{ id: "run-d", status: "proved", result_kind: "proved", input_tokens: 10, output_tokens: 4, cost_usd: 0.002 }] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const result = await runApiProofJob({
    fetchImpl,
    baseUrl: "http://127.0.0.1:8001",
    message: "Formalize dropped",
    timeoutMs: 5000,
    busyRetryDelayMs: 5,
  });

  assert.equal(eventsCalls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.doneStatus, "proved");
  assert.equal(result.costUsd, 0.002);
});

test("runApiProofJob: stream drops and the adapter is unreachable → gives up after the miss cap and interrupts", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET" });
    if (url.endsWith("/api/runs") && options.method === "POST") {
      return jsonResponse({ session_id: "sess-u", run_id: "run-u" });
    }
    if (url.includes("/api/runs/run-u/interrupt")) {
      return jsonResponse({ status: "interrupted" });
    }
    if (url.includes("/api/runs/run-u/events")) {
      // Open itself fails — a dropped/unreachable stream with no HTTP status.
      throw new Error("socket hang up");
    }
    if (url.includes("/api/sessions/sess-u")) {
      // Run-row read also fails: the adapter is genuinely unreachable.
      throw new Error("ECONNREFUSED");
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const result = await runApiProofJob({
    fetchImpl,
    baseUrl: "http://127.0.0.1:8001",
    message: "Formalize unreachable",
    timeoutMs: 5000,
    busyRetryDelayMs: 3,
  });

  assert.equal(result.ok, false);
  // It stopped on the miss cap, not the timeout.
  assert.equal(result.timedOut, false);
  assert.ok(
    calls.some((c) => c.url.includes("/api/runs/run-u/interrupt") && c.method === "POST"),
    "should best-effort interrupt the run it is abandoning"
  );
  // Bounded: one attach + one row read per miss, capped at 5 misses.
  const eventAttempts = calls.filter((c) => c.url.includes("/events")).length;
  assert.ok(eventAttempts <= 5, `expected <= 5 attach attempts, got ${eventAttempts}`);
});
