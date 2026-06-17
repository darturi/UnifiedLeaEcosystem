import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSseFrame,
  isApiFlavor,
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

test("isApiFlavor recognizes the api wire", () => {
  assert.equal(isApiFlavor("api"), true);
  assert.equal(isApiFlavor("API"), true);
  assert.equal(isApiFlavor("v1"), false);
  assert.equal(isApiFlavor(undefined), false);
});

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

test("runApiProofJob: non-success terminal status → not ok with a descriptive error", async () => {
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
