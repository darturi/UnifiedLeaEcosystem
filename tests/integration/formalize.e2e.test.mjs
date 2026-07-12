// Cross-layer integration harness (PLAN-system-hardening Phase 1 / review B6).
//
// Boots the REAL adapter (uvicorn, stub prover via adapter_entry.py) and the
// REAL companion (in-process createServer on an ephemeral port), then drives
// the extension's exact HTTP shapes end-to-end. This is the contract net the
// per-layer suites with fakes cannot provide: SSE event names, done.status
// vocabulary, and session-detail field names are asserted against the real
// wire, so drift between the layers fails here instead of in production.
//
// Run with: npm run test:integration  (needs the adapter venv provisioned)

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "../../apps/overleaf-extension/companion/server.mjs";
import {
  fetchApiSessionDetail,
  startApiRun,
  streamApiRun
} from "../../apps/overleaf-extension/companion/leaApiClient.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PYTHON = path.join(REPO_ROOT, "apps", "lea-standalone", "adapter", ".venv", "bin", "python");
const ADAPTER_ENTRY = path.join(REPO_ROOT, "tests", "integration", "adapter_entry.py");

// The adapter's current event vocabulary (bridge.emit call sites). A new event
// type is fine — add it here deliberately — but an unexpected one usually
// means a layer renamed something the other layers still expect.
const KNOWN_EVENT_TYPES = new Set([
  "status", "assistant_delta", "message", "code_step", "project_updated",
  "run_error", "approval_requested", "approval_resolved", "queued", "done"
]);
const KNOWN_DONE_STATUSES = new Set([
  "proved", "disproved", "needs_review", "answered", "max_turns", "cancelled", "failed"
]);

let home;
let adapter;
let adapterBaseUrl;
let companion;
let companionBaseUrl;
let companionJobsPath;

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(predicate, { timeoutMs = 30000, intervalMs = 100, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function makeFixtureHome() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lea-itest-"));
  const prover = path.join(dir, "prover");
  const workspace = path.join(prover, "workspace");
  await fs.mkdir(path.join(workspace, "proofs"), { recursive: true });
  await fs.mkdir(path.join(workspace, "projects"), { recursive: true });
  await fs.mkdir(path.join(prover, "lea"), { recursive: true });
  await fs.writeFile(path.join(prover, "pyproject.toml"), "[project]\nname = \"itest-stub\"\n");
  await fs.writeFile(path.join(workspace, "lean-toolchain"), "leanprover/lean4:v4.0.0\n");
  await fs.writeFile(path.join(workspace, "lakefile.lean"), "-- itest stub\n");
  await fs.mkdir(path.join(dir, "config"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "config", "lea.local.toml"),
    `model = "o4-mini"\nmax_turns = 5\nlea_root = ${JSON.stringify(prover)}\n`
  );
  await fs.mkdir(path.join(dir, "data"), { recursive: true });
  await fs.mkdir(path.join(dir, "companion"), { recursive: true });
  return { dir, prover };
}

before(async () => {
  const fixture = await makeFixtureHome();
  home = fixture.dir;

  const port = await freePort();
  adapterBaseUrl = `http://127.0.0.1:${port}`;
  adapter = spawn(PYTHON, [ADAPTER_ENTRY], {
    env: { ...process.env, LEA_ITEST_HOME: home, LEA_ITEST_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let adapterLog = "";
  adapter.stdout.on("data", (chunk) => { adapterLog += chunk; });
  adapter.stderr.on("data", (chunk) => { adapterLog += chunk; });
  const exited = new Promise((_, reject) => {
    adapter.once("exit", (code) => reject(new Error(`adapter exited early (code ${code}):\n${adapterLog}`)));
  });
  await Promise.race([
    exited,
    waitFor(async () => {
      try {
        const res = await fetch(`${adapterBaseUrl}/api/settings`);
        return res.ok;
      } catch {
        return false;
      }
    }, { timeoutMs: 60000, intervalMs: 250, label: "adapter boot" })
  ]);
  adapter.removeAllListeners("exit");

  companionJobsPath = path.join(home, "companion", "jobs.json");
  companion = await createServer({
    settingsPath: path.join(home, "companion", "settings.json"),
    jobsPath: companionJobsPath,
    chatSessionsPath: path.join(home, "companion", "chatSessions.json"),
    env: {
      OPENAI_API_KEY: "itest-key",
      LEA_ROOT: fixture.prover,
      LEA_API_BASE_URL: adapterBaseUrl,
      LEA_UI_BASE_URL: "http://localhost:5173",
      LEA_MODEL: "o4-mini",
      LEA_MAX_TURNS: "5",
      LEA_JOB_TIMEOUT_SECONDS: "60"
    }
  });
  await new Promise((resolve) => companion.listen(0, "127.0.0.1", resolve));
  companionBaseUrl = `http://127.0.0.1:${companion.address().port}`;
});

after(async () => {
  if (companion) await new Promise((resolve) => companion.close(resolve));
  if (adapter && adapter.exitCode === null) {
    adapter.kill("SIGTERM");
    await new Promise((resolve) => {
      adapter.once("exit", resolve);
      setTimeout(() => {
        adapter.kill("SIGKILL");
        resolve();
      }, 3000).unref();
    });
  }
  if (home) await fs.rm(home, { recursive: true, force: true });
});

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function pollStatus(overleafProjectId, target, wanted, { timeoutMs = 45000 } = {}) {
  return waitFor(async () => {
    const res = await postJson(`${companionBaseUrl}/statuses`, {
      overleafProjectId,
      targets: [target]
    });
    const info = res.body?.statuses?.[`${target.targetKind}:${target.targetLabel}`];
    return wanted.includes(info?.status) ? info : null;
  }, { timeoutMs, label: `status in {${wanted}}` });
}

test("adapter wire contract: events, done vocabulary, persistence, completed-run reattach", async () => {
  const events = [];
  const start = await startApiRun({
    fetchImpl: fetch,
    baseUrl: adapterBaseUrl,
    apiKey: null,
    message: "Formalize the Overleaf theorem labeled wire_contract_check.\n\nTrue is true.",
    projectSlug: "itest-wire",
    projectTitle: "Wire contract",
    origin: "overleaf",
    originUrl: "https://www.overleaf.com/project/itest-wire"
  });
  assert.equal(start.ok, true, start.error);
  const runId = start.body.run_id;
  const sessionId = start.body.session_id;
  assert.ok(runId && sessionId);
  assert.equal(start.body.project_slug, "itest-wire");
  // Phase 2: creation enqueues; the response reports the FIFO position (it may
  // already be null if the worker started the run before we read it).
  assert.ok("queue_position" in start.body, "create response carries queue_position");

  const outcome = await streamApiRun({
    fetchImpl: fetch,
    baseUrl: adapterBaseUrl,
    apiKey: null,
    runId,
    onEvent: (type, data) => events.push({ type, data })
  });
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.doneStatus, "proved");
  assert.equal(outcome.resultKind, "proved");

  // Every event type on the wire is one the clients know.
  for (const { type } of events) {
    assert.ok(KNOWN_EVENT_TYPES.has(type), `unknown SSE event type on the wire: ${type}`);
  }
  const done = events.at(-1);
  assert.equal(done.type, "done");
  assert.ok(KNOWN_DONE_STATUSES.has(done.data.status), `done.status outside vocabulary: ${done.data.status}`);

  // code_step events carry a real commit and the file snapshot.
  const codeSteps = events.filter((e) => e.type === "code_step");
  assert.ok(codeSteps.length >= 1);
  const step = codeSteps.at(-1).data;
  assert.equal(step.commit_sha.length, 40);
  assert.match(step.code, /theorem wire_contract_check : True/);
  assert.equal(step.check_status, "ok");

  // Persisted session detail: the fields the companion reads by name.
  const detail = await fetchApiSessionDetail({ fetchImpl: fetch, baseUrl: adapterBaseUrl, apiKey: null, sessionId });
  assert.equal(detail.ok, true);
  assert.equal(detail.body.origin, "overleaf");
  const run = detail.body.runs.find((r) => r.id === runId);
  assert.equal(run.status, "proved");
  assert.equal(run.result_kind, "proved");
  assert.equal(run.input_tokens, 11);
  assert.equal(run.output_tokens, 7);

  // Phase 2 contract: re-attaching to a completed run replays its buffered
  // history to a terminal `done` (HTTP 200) — the 409 disambiguation dance
  // is gone, so any number of late observers are safe.
  const reattach = await fetch(`${adapterBaseUrl}/api/runs/${runId}/events`);
  assert.equal(reattach.status, 200);
  const replayText = await reattach.text();
  assert.match(replayText, /event: done/);
  assert.match(replayText, /"status": "proved"/);
});

test("companion end-to-end: /formalize drives a run to formalized with a session link", async () => {
  const target = { targetKind: "theorem", targetLabel: "int_e2e_true", targetText: "True is true." };
  const result = await postJson(`${companionBaseUrl}/formalize`, {
    overleafProjectId: "itest-doc",
    ...target
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.status, "in_progress");
  const jobId = result.body.jobId;
  assert.ok(jobId);

  const info = await pollStatus("itest-doc", target, ["formalized", "failed"]);
  assert.equal(info.status, "formalized");
  assert.equal(info.resultKind, "proved");

  const jobs = JSON.parse(await fs.readFile(companionJobsPath, "utf8"));
  const job = jobs[jobId];
  assert.equal(job.status, "formalized");
  assert.ok(job.leaSessionId, "job records the adapter session id");
  assert.equal(job.costUsd, 0.002);

  // The session the extension deep-links to really exists adapter-side, is
  // Overleaf-tagged, and carries the document's project slug.
  const detail = await fetchApiSessionDetail({
    fetchImpl: fetch, baseUrl: adapterBaseUrl, apiKey: null, sessionId: job.leaSessionId
  });
  assert.equal(detail.ok, true);
  assert.equal(detail.body.origin, "overleaf");
});

test("companion push channel: /events streams jobs-changed during a formalize (PLAN 3.1)", async () => {
  const response = await fetch(`${companionBaseUrl}/events?projectId=itest-doc`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const readUntil = async (needle, timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs;
    while (!buffer.includes(needle)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${needle}`);
      const { value, done } = await reader.read();
      if (done) throw new Error(`stream ended before ${needle} arrived`);
      buffer += decoder.decode(value);
    }
  };

  try {
    await readUntil("event: hello");
    const target = { targetKind: "theorem", targetLabel: "int_push_true", targetText: "True is true." };
    const result = await postJson(`${companionBaseUrl}/formalize`, {
      overleafProjectId: "itest-doc",
      ...target
    });
    assert.equal(result.status, 200);
    await readUntil("event: jobs-changed");
    // And the run still completes normally underneath.
    const info = await pollStatus("itest-doc", target, ["formalized", "failed"]);
    assert.equal(info.status, "formalized");
  } finally {
    await reader.cancel().catch(() => {});
  }
});

test("companion end-to-end: a failing run surfaces as failed, not as a hang", async () => {
  const target = {
    targetKind: "theorem",
    targetLabel: "int_e2e_fails",
    targetText: "True is true. [stub:fail]"
  };
  const result = await postJson(`${companionBaseUrl}/formalize`, {
    overleafProjectId: "itest-doc",
    ...target
  });
  assert.equal(result.status, 200);

  const info = await pollStatus("itest-doc", target, ["failed"]);
  assert.equal(info.status, "failed");
});
