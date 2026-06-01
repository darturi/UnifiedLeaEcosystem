import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ensureStartupWorkspace,
  handleCreateStub,
  handleFormalize,
  handleGetStatuses,
  validateWorkspace
} from "../companion/server.mjs";
import { buildProjectRelativeLeanPath, slugProjectId } from "../shared/leanStub.mjs";

test("validates a Lean workspace path", async () => {
  const workspace = await makeWorkspace();
  assert.deepEqual(await validateWorkspace(workspace), { ok: true });
});

test("creates and caches a generated Lean stub", async () => {
  const workspace = await makeWorkspace();
  const state = await makeState(workspace);
  const payload = {
    overleafProjectId: "project-id",
    theoremLabel: "tree_leaves",
    theoremText: "Every finite tree has at least two leaves."
  };

  const first = await handleCreateStub(payload, state);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.status, "sorry_stub");
  assert.equal(first.body.action, "created");
  assert.equal(first.body.relativePath, path.join("Formalization", "Generated", "tree_leaves.lean"));

  const file = await fs.readFile(first.body.absolutePath, "utf8");
  assert.match(file, /theorem tree_leaves : True := by/);
  assert.match(file, /sorry/);

  const second = await handleCreateStub(payload, state);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.status, "sorry_stub");
  assert.equal(second.body.action, "checked");
});

test("returns conflict for same label with different theorem text", async () => {
  const workspace = await makeWorkspace();
  const state = await makeState(workspace);

  await handleCreateStub({
    theoremLabel: "same_label",
    theoremText: "First theorem."
  }, state);

  const conflict = await handleCreateStub({
    theoremLabel: "same_label",
    theoremText: "Second theorem."
  }, state);

  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.body.error, "stub_conflict");
});

test("returns clear error when workspace is unset", async () => {
  const state = await makeState("");
  const result = await handleCreateStub({
    theoremLabel: "foo",
    theoremText: "A"
  }, state);

  assert.equal(result.statusCode, 400);
  assert.equal(result.body.error, "workspace_unset");
});

test("rejects invalid labels", async () => {
  const workspace = await makeWorkspace();
  const state = await makeState(workspace);
  const result = await handleCreateStub({
    theoremLabel: "bad-label",
    theoremText: "A"
  }, state);

  assert.equal(result.statusCode, 400);
  assert.equal(result.body.error, "invalid_label");
});

test("sets up a minimal Lean workspace when default workspace is invalid", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "overleaf-startup-workspace-"));
  const state = await makeState("");

  const result = await ensureStartupWorkspace(state, workspace);

  assert.equal(result.created, true);
  assert.equal(state.settings.workspacePath, workspace);
  assert.equal((await validateWorkspace(workspace)).ok, true);
  assert.match(await fs.readFile(path.join(workspace, "lean-toolchain"), "utf8"), /leanprover\/lean4/);
  assert.match(await fs.readFile(path.join(workspace, "lakefile.lean"), "utf8"), /package/);
});

test("reports unformalized and sorry stub statuses", async () => {
  const workspace = await makeWorkspace();
  const state = await makeState(workspace);

  const before = await handleGetStatuses({
    theorems: [{ theoremLabel: "status_test", theoremText: "A theorem." }]
  }, state);
  assert.equal(before.statusCode, 200);
  assert.equal(before.body.statuses.status_test.status, "unformalized");

  await handleCreateStub({
    theoremLabel: "status_test",
    theoremText: "A theorem."
  }, state);

  const after = await handleGetStatuses({
    theorems: [{ theoremLabel: "status_test", theoremText: "A theorem." }]
  }, state);
  assert.equal(after.statusCode, 200);
  assert.equal(after.body.statuses.status_test.status, "sorry_stub");
});

test("reports formalized status when generated file no longer has sorry", async () => {
  const workspace = await makeWorkspace();
  const state = await makeState(workspace);

  await handleCreateStub({
    theoremLabel: "formalized_test",
    theoremText: "A theorem."
  }, state);

  const filePath = path.join(workspace, "Formalization", "Generated", "formalized_test.lean");
  await fs.writeFile(filePath, "theorem formalized_test : True := by\n  trivial\n", "utf8");

  const result = await handleGetStatuses({
    theorems: [{ theoremLabel: "formalized_test", theoremText: "A theorem." }]
  }, state);

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.statuses.formalized_test.status, "formalized");
  assert.equal(
    result.body.statuses.formalized_test.leanStatement,
    "theorem formalized_test : True"
  );
});

test("reports formalized status when generated metadata remains but sorry is removed", async () => {
  const workspace = await makeWorkspace();
  const state = await makeState(workspace);

  await handleCreateStub({
    theoremLabel: "metadata_formalized_test",
    theoremText: "A theorem."
  }, state);

  const filePath = path.join(workspace, "Formalization", "Generated", "metadata_formalized_test.lean");
  const original = await fs.readFile(filePath, "utf8");
  await fs.writeFile(filePath, original.replace("sorry", "trivial"), "utf8");

  const result = await handleGetStatuses({
    theorems: [{ theoremLabel: "metadata_formalized_test", theoremText: "A theorem." }]
  }, state);

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.statuses.metadata_formalized_test.status, "formalized");
});

test("formalized status returns declaration statement without proof body", async () => {
  const workspace = await makeWorkspace();
  const state = await makeState(workspace);
  const relativePath = path.join("Formalization", "Overleaf", "project-1", "statement_test.lean");
  const filePath = path.join(workspace, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    "lemma statement_test (n : Nat) : n = n := by\n  rfl\n",
    "utf8"
  );

  const result = await handleGetStatuses({
    overleafProjectId: "project-1",
    theorems: [{ theoremLabel: "statement_test", theoremText: "A theorem." }]
  }, state);

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.statuses.statement_test.status, "formalized");
  assert.equal(result.body.statuses.statement_test.leanStatement, "lemma statement_test (n : Nat) : n = n");
});

test("rechecking an existing file returns current status when proof changes back to sorry", async () => {
  const workspace = await makeWorkspace();
  const state = await makeState(workspace);
  const payload = {
    theoremLabel: "recheck_test",
    theoremText: "A theorem."
  };

  await handleCreateStub(payload, state);
  const filePath = path.join(workspace, "Formalization", "Generated", "recheck_test.lean");
  const original = await fs.readFile(filePath, "utf8");
  await fs.writeFile(filePath, original.replace("sorry", "trivial"), "utf8");

  const formalized = await handleCreateStub(payload, state);
  assert.equal(formalized.statusCode, 200);
  assert.equal(formalized.body.status, "formalized");
  assert.equal(formalized.body.action, "checked");

  await fs.writeFile(filePath, original, "utf8");

  const sorryStub = await handleCreateStub(payload, state);
  assert.equal(sorryStub.statusCode, 200);
  assert.equal(sorryStub.body.status, "sorry_stub");
  assert.equal(sorryStub.body.action, "checked");
});

test("builds project-scoped Lean paths", () => {
  assert.equal(slugProjectId("abc/123?x"), "abc_123_x");
  assert.equal(
    buildProjectRelativeLeanPath({ overleafProjectId: "abc/123?x", theoremLabel: "foo" }),
    path.join("Formalization", "Overleaf", "abc_123_x", "foo.lean")
  );
  assert.throws(
    () => buildProjectRelativeLeanPath({ overleafProjectId: "abc", theoremLabel: "bad-label" }),
    /valid Lean identifier/
  );
});

test("formalize starts Lea without creating a placeholder file first", async () => {
  const workspace = await makeWorkspace();
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const state = await makeState(workspace, {
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "test-key" },
    spawnImpl: makeHangingSpawn(calls),
    commandExists: () => true
  });

  const result = await handleFormalize({
    overleafProjectId: "project-1",
    theoremLabel: "lea_test",
    theoremText: "A theorem."
  }, state);

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, "in_progress");
  assert.equal(result.body.relativePath, path.join("Formalization", "Overleaf", "project-1", "lea_test.lean"));
  assert.equal(await fileExists(path.join(workspace, result.body.relativePath)), false);
  await waitFor(() => calls.length > 0);
  assert.equal(calls[0].command, "uv");
  assert.deepEqual(calls[0].args.slice(0, 10), [
    "run",
    "python",
    "-m",
    "lea.cli",
    "-p",
    "openai",
    "-m",
    "o4-mini",
    "--max-turns",
    "20"
  ]);
  assert.match(calls[0].options.env.PYTHONPATH, /lea-prover-/);
  assert.match(calls[0].args.at(-1), /create or edit only Formalization\/Overleaf\/project-1\/lea_test\.lean/);
  assert.match(calls[0].args.at(-1), /A theorem\./);
});

test("formalize returns active job instead of starting a duplicate", async () => {
  const workspace = await makeWorkspace();
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const state = await makeState(workspace, {
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "test-key" },
    spawnImpl: makeHangingSpawn(calls),
    commandExists: () => true
  });
  const payload = {
    overleafProjectId: "project-1",
    theoremLabel: "duplicate_test",
    theoremText: "A theorem."
  };

  const first = await handleFormalize(payload, state);
  const second = await handleFormalize(payload, state);
  await waitFor(() => calls.length > 0);

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.status, "in_progress");
  assert.equal(second.body.jobId, first.body.jobId);
  assert.equal(calls.length, 1);
});

test("statuses report active Lea jobs as in progress", async () => {
  const workspace = await makeWorkspace();
  const leaRepo = await makeLeaRepo();
  const state = await makeState(workspace, {
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "test-key" },
    spawnImpl: makeHangingSpawn([]),
    commandExists: () => true
  });

  await handleFormalize({
    overleafProjectId: "project-1",
    theoremLabel: "active_status_test",
    theoremText: "A theorem."
  }, state);

  const statuses = await handleGetStatuses({
    overleafProjectId: "project-1",
    theorems: [{ theoremLabel: "active_status_test", theoremText: "A theorem." }]
  }, state);

  assert.equal(statuses.statusCode, 200);
  assert.equal(statuses.body.statuses.active_status_test.status, "in_progress");
});

test("statuses report formalized when active job has already written a complete file", async () => {
  const workspace = await makeWorkspace();
  const leaRepo = await makeLeaRepo();
  const state = await makeState(workspace, {
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "test-key" },
    spawnImpl: makeHangingSpawn([]),
    commandExists: () => true
  });

  await handleFormalize({
    overleafProjectId: "project-1",
    theoremLabel: "active_complete_test",
    theoremText: "A theorem."
  }, state);

  const filePath = path.join(
    workspace,
    "Formalization",
    "Overleaf",
    "project-1",
    "active_complete_test.lean"
  );
  await fs.writeFile(filePath, "theorem active_complete_test : True := by\n  trivial\n", "utf8");

  const statuses = await handleGetStatuses({
    overleafProjectId: "project-1",
    theorems: [{ theoremLabel: "active_complete_test", theoremText: "A theorem." }]
  }, state);

  assert.equal(statuses.statusCode, 200);
  assert.equal(statuses.body.statuses.active_complete_test.status, "formalized");
  assert.equal(
    statuses.body.statuses.active_complete_test.leanStatement,
    "theorem active_complete_test : True"
  );
});

test("formalize rejects missing OpenAI key", async () => {
  const workspace = await makeWorkspace();
  const leaRepo = await makeLeaRepo();
  const state = await makeState(workspace, {
    leaRepoPath: leaRepo,
    env: {},
    commandExists: () => true
  });

  const result = await handleFormalize({
    overleafProjectId: "project-1",
    theoremLabel: "missing_key_test",
    theoremText: "A theorem."
  }, state);

  assert.equal(result.statusCode, 400);
  assert.equal(result.body.error, "missing_openai_key");
});

test("statuses report failed Lea jobs when target is still missing", async () => {
  const workspace = await makeWorkspace();
  const state = await makeState(workspace);
  state.jobs.failed_job = {
    jobId: "failed_job",
    jobKey: "project-1:failed_status_test",
    status: "failed",
    theoremLabel: "failed_status_test",
    relativePath: path.join("Formalization", "Overleaf", "project-1", "failed_status_test.lean"),
    absolutePath: path.join(workspace, "Formalization", "Overleaf", "project-1", "failed_status_test.lean"),
    logPath: path.join(path.dirname(state.jobsPath), "failed.log"),
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z"
  };
  await fs.writeFile(state.jobs.failed_job.logPath, "failed proof\n", "utf8");

  const statuses = await handleGetStatuses({
    overleafProjectId: "project-1",
    theorems: [{ theoremLabel: "failed_status_test", theoremText: "A theorem." }]
  }, state);

  assert.equal(statuses.statusCode, 200);
  assert.equal(statuses.body.statuses.failed_status_test.status, "failed");
  assert.match(statuses.body.statuses.failed_status_test.logTail, /failed proof/);
});

async function makeWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "overleaf-lean-workspace-"));
  await fs.writeFile(path.join(dir, "lean-toolchain"), "leanprover/lean4:stable\n", "utf8");
  await fs.writeFile(path.join(dir, "lakefile.lean"), "import Lake\nopen Lake DSL\n", "utf8");
  return dir;
}

async function makeLeaRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lea-prover-"));
  await fs.writeFile(path.join(dir, "pyproject.toml"), "[project]\nname = \"lea-prover\"\n", "utf8");
  return dir;
}

async function makeState(workspacePath, overrides = {}) {
  const appDir = await fs.mkdtemp(path.join(os.tmpdir(), "overleaf-lean-state-"));
  return {
    settingsPath: path.join(appDir, "settings.json"),
    cachePath: path.join(appDir, "cache.json"),
    jobsPath: path.join(appDir, "jobs.json"),
    settings: {
      ...(workspacePath ? { workspacePath } : {}),
      ...(overrides.leaRepoPath ? {
        leaRepoPath: overrides.leaRepoPath,
        leaProvider: "openai",
        leaModel: "o4-mini",
        leaMaxTurns: 20
      } : {})
    },
    cache: {},
    jobs: {},
    env: overrides.env || process.env,
    spawnImpl: overrides.spawnImpl,
    commandExists: overrides.commandExists
  };
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function makeHangingSpawn(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    return child;
  };
}

async function waitFor(predicate) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1000) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
