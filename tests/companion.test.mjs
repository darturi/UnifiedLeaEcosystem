import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LEA_MODEL_OPTIONS,
  buildSettingsResponse,
  ensureStartupLeaRuntime,
  handleFormalize,
  handleGetStatuses,
  handleGetUsage,
  handleStub,
  handleUpdateLeaSettings,
  recoverInterruptedJobs,
  validateLeaRepo
} from "../companion/server.mjs";
import {
  buildLeaProjectMarkdownPath,
  buildLeaWorkspacePath,
  slugProjectId
} from "../shared/leanStub.mjs";

test("validates a Lea repo and derives its workspace", async () => {
  const leaRepo = await makeLeaRepo();

  assert.deepEqual(await validateLeaRepo(leaRepo), {
    ok: true,
    leaWorkspacePath: path.join(leaRepo, "workspace")
  });
});

test("startup records the derived Lea workspace without creating root Lean files", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({ leaRepoPath: leaRepo });

  const result = await ensureStartupLeaRuntime(state);

  assert.equal(result.ok, true);
  assert.equal(state.settings.leaWorkspacePath, buildLeaWorkspacePath(leaRepo));
  assert.equal(await fileExists(path.join(path.dirname(state.settingsPath), "lean-toolchain")), false);
  assert.equal(await fileExists(path.join(path.dirname(state.settingsPath), "lakefile.lean")), false);
});

test("builds Lea-compatible Overleaf project slugs and markdown paths", () => {
  const long = `9${"a".repeat(120)}`;
  assert.equal(slugProjectId("abc/123?x"), "abc_123_x");
  assert.equal(slugProjectId("-abc"), "project_-abc");
  assert.equal(slugProjectId("_abc"), "project__abc");
  assert.equal(slugProjectId(""), "unknown");
  assert.equal(slugProjectId(long).length, 80);
  assert.match(slugProjectId("!!!"), /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/);
  assert.equal(
    buildLeaProjectMarkdownPath({ leaRepoPath: "/tmp/lea", overleafProjectId: "abc/123?x" }),
    path.join("/tmp/lea", "workspace", "projects", "abc_123_x.md")
  );
});

test("settings response includes model families and key status", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "env-openai", ANTHROPIC_API_KEY: "env-anthropic" }
  });

  const response = buildSettingsResponse(state);

  assert.deepEqual(response.leaModelOptions, LEA_MODEL_OPTIONS);
  assert.deepEqual(response.leaModelOptions.map((model) => model.id), [
    "o4-mini",
    "gpt-5.4-mini",
    "gpt-5.4",
    "gpt-5.5",
    "gemini/gemini-3.1-pro-preview",
    "gemini/gemini-2.5-pro",
    "gemini/gemini-2.5-flash",
    "anthropic/claude-opus-4-8",
    "anthropic/claude-sonnet-4-6"
  ]);
  assert.equal(response.leaModelOptions.find((model) => model.id === "o4-mini").family, "openai");
  assert.equal(response.leaModelOptions.find((model) => model.id === "gemini/gemini-2.5-pro").family, "gemini");
  assert.equal(response.leaProviderKeys.openai.configured, true);
  assert.equal(response.leaProviderKeys.gemini.configured, false);
  assert.equal(response.leaProviderKeys.anthropic.configured, true);
});

test("settings reject unsupported models and missing family keys", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({ leaRepoPath: leaRepo, env: {} });

  const badModel = await handleUpdateLeaSettings({
    leaRepoPath: leaRepo,
    leaApiBaseUrl: "http://127.0.0.1:8000",
    leaModel: "anthropic/claude-does-not-exist",
    leaMaxTurns: 20
  }, state);
  const missingGeminiKey = await handleUpdateLeaSettings({
    leaRepoPath: leaRepo,
    leaApiBaseUrl: "http://127.0.0.1:8000",
    leaModel: "gemini/gemini-2.5-pro",
    leaMaxTurns: 20
  }, state);

  assert.equal(badModel.statusCode, 400);
  assert.equal(badModel.body.error, "invalid_lea_model");
  assert.equal(missingGeminiKey.statusCode, 400);
  assert.equal(missingGeminiKey.body.error, "missing_gemini_key");
});

test("settings save supported models when their family key is configured", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({ leaRepoPath: leaRepo, env: { OPENAI_API_KEY: "openai-key", GEMINI_API_KEY: "gemini-key", ANTHROPIC_API_KEY: "anthropic-key" } });

  const openAiResult = await handleUpdateLeaSettings({
    leaRepoPath: leaRepo,
    leaApiBaseUrl: "http://127.0.0.1:8000",
    leaModel: "gpt-5.4-mini",
    leaMaxTurns: 34
  }, state);
  const geminiResult = await handleUpdateLeaSettings({
    leaRepoPath: leaRepo,
    leaApiBaseUrl: "http://127.0.0.1:8000",
    leaModel: "gemini/gemini-2.5-flash",
    leaMaxTurns: 12
  }, state);
  const anthropicResult = await handleUpdateLeaSettings({
    leaRepoPath: leaRepo,
    leaApiBaseUrl: "http://127.0.0.1:8000",
    leaModel: "anthropic/claude-sonnet-4-6",
    leaMaxTurns: 21
  }, state);

  assert.equal(openAiResult.statusCode, 200);
  assert.equal(openAiResult.body.leaProvider, "openai");
  assert.equal(openAiResult.body.leaModel, "gpt-5.4-mini");
  assert.equal(openAiResult.body.leaMaxTurns, 34);
  assert.equal(geminiResult.statusCode, 200);
  assert.equal(geminiResult.body.leaProvider, "gemini");
  assert.equal(geminiResult.body.leaModel, "gemini/gemini-2.5-flash");
  assert.equal(anthropicResult.statusCode, 200);
  assert.equal(anthropicResult.body.leaProvider, "anthropic");
  assert.equal(anthropicResult.body.leaModel, "anthropic/claude-sonnet-4-6");
});

test("settings normalize legacy Anthropic model ids", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({
    leaRepoPath: leaRepo,
    leaModel: "anthropic/claude-sonnet-4-20250514",
    env: { ANTHROPIC_API_KEY: "anthropic-key" }
  });

  assert.equal(buildSettingsResponse(state).leaModel, "anthropic/claude-sonnet-4-6");

  const result = await handleUpdateLeaSettings({
    leaRepoPath: leaRepo,
    leaApiBaseUrl: "http://127.0.0.1:8000",
    leaModel: "anthropic/claude-opus-4-20250514",
    leaMaxTurns: 20
  }, state);

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.leaModel, "anthropic/claude-opus-4-8");
});

test("settings writes scrub legacy key fields", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({
    leaRepoPath: leaRepo,
    leaModel: "anthropic/claude-sonnet-4-20250514",
    leaApiKey: "legacy-openai-key",
    leaProviderApiKeys: { anthropic: "legacy-anthropic-key" },
    env: {}
  });

  const startup = await ensureStartupLeaRuntime(state);
  assert.equal(startup.ok, true);
  assert.equal(state.settings.leaModel, "anthropic/claude-sonnet-4-6");
  assert.equal(state.settings.leaApiKey, undefined);
  assert.equal(state.settings.leaProviderApiKeys, undefined);
  assert.equal(state.env.ANTHROPIC_API_KEY, "legacy-anthropic-key");
  assert.equal(state.env.OPENAI_API_KEY, "legacy-openai-key");

  const envFile = await fs.readFile(state.envPath, "utf8");
  assert.match(envFile, /ANTHROPIC_API_KEY=legacy-anthropic-key/);
  assert.match(envFile, /OPENAI_API_KEY=legacy-openai-key/);
  const saved = JSON.parse(await fs.readFile(state.settingsPath, "utf8"));
  assert.equal(saved.leaModel, "anthropic/claude-sonnet-4-6");
  assert.equal(Object.prototype.hasOwnProperty.call(saved, "leaApiKey"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(saved, "leaProviderApiKeys"), false);
});

test("settings save provider key patches to env file without settings persistence", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "openai-key" }
  });

  const result = await handleUpdateLeaSettings({
    leaRepoPath: leaRepo,
    leaApiBaseUrl: "http://127.0.0.1:8000",
    leaModel: "anthropic/claude-sonnet-4-6",
    leaMaxTurns: 20,
    leaProviderApiKeys: { anthropic: "anthropic-key" }
  }, state);

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.leaProviderKeys.anthropic.configured, true);
  assert.equal(state.env.ANTHROPIC_API_KEY, "anthropic-key");

  const envFile = await fs.readFile(state.envPath, "utf8");
  assert.match(envFile, /ANTHROPIC_API_KEY=anthropic-key/);

  const saved = JSON.parse(await fs.readFile(state.settingsPath, "utf8"));
  assert.equal(Object.prototype.hasOwnProperty.call(saved, "leaApiKey"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(saved, "leaProviderApiKeys"), false);
});

test("settings reject invalid submitted Gemini keys before persistence", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "openai-key" },
    fetchImpl: makeProviderValidationFetch(calls, { gemini: 401 })
  });

  const result = await handleUpdateLeaSettings({
    leaRepoPath: leaRepo,
    leaApiBaseUrl: "http://127.0.0.1:8000",
    leaModel: "gemini/gemini-2.5-pro",
    leaMaxTurns: 20,
    leaProviderApiKeys: { gemini: "PLACEHOLDER" }
  }, state);

  assert.equal(result.statusCode, 400);
  assert.equal(result.body.error, "invalid_gemini_key");
  assert.match(result.body.message, /Gemini API key was rejected/);
  assert.equal(state.env.GEMINI_API_KEY, undefined);
  assert.equal(await fileExists(state.envPath), false);
  assert.deepEqual(calls.map((call) => call.family), ["gemini"]);
});

test("settings reject invalid existing key for selected provider family", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: { GEMINI_API_KEY: "bad-gemini-key" },
    fetchImpl: makeProviderValidationFetch(calls, { gemini: 403 })
  });

  const result = await handleUpdateLeaSettings({
    leaRepoPath: leaRepo,
    leaApiBaseUrl: "http://127.0.0.1:8000",
    leaModel: "gemini/gemini-2.5-flash",
    leaMaxTurns: 20
  }, state);

  assert.equal(result.statusCode, 400);
  assert.equal(result.body.error, "invalid_gemini_key");
  assert.equal(state.settings.leaModel, "o4-mini");
  assert.deepEqual(calls.map((call) => call.family), ["gemini"]);
});

test("settings validate newly entered non-selected provider keys", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "openai-key" },
    fetchImpl: makeProviderValidationFetch(calls, { anthropic: 401 })
  });

  const result = await handleUpdateLeaSettings({
    leaRepoPath: leaRepo,
    leaApiBaseUrl: "http://127.0.0.1:8000",
    leaModel: "gpt-5.4-mini",
    leaMaxTurns: 20,
    leaProviderApiKeys: { anthropic: "bad-anthropic-key" }
  }, state);

  assert.equal(result.statusCode, 400);
  assert.equal(result.body.error, "invalid_anthropic_key");
  assert.equal(state.env.ANTHROPIC_API_KEY, undefined);
  assert.deepEqual(calls.map((call) => call.family), ["anthropic"]);
});

test("settings save valid submitted keys after provider verification", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "openai-key" },
    fetchImpl: makeProviderValidationFetch(calls)
  });

  const result = await handleUpdateLeaSettings({
    leaRepoPath: leaRepo,
    leaApiBaseUrl: "http://127.0.0.1:8000",
    leaModel: "gemini/gemini-2.5-flash",
    leaMaxTurns: 20,
    leaProviderApiKeys: { gemini: "valid-gemini-key" }
  }, state);

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.leaProviderKeys.gemini.configured, true);
  assert.equal(state.env.GEMINI_API_KEY, "valid-gemini-key");
  assert.deepEqual(calls.map((call) => call.family), ["gemini"]);

  const envFile = await fs.readFile(state.envPath, "utf8");
  assert.match(envFile, /GEMINI_API_KEY=valid-gemini-key/);
});

test("settings reject provider key verification network failures", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "openai-key" },
    fetchImpl: makeProviderValidationFetch(calls, { openai: "throw" })
  });

  const result = await handleUpdateLeaSettings({
    leaRepoPath: leaRepo,
    leaApiBaseUrl: "http://127.0.0.1:8000",
    leaModel: "gpt-5.4-mini",
    leaMaxTurns: 20
  }, state);

  assert.equal(result.statusCode, 400);
  assert.equal(result.body.error, "openai_key_verification_failed");
  assert.match(result.body.message, /Could not verify OpenAI API key/);
});

test("settings do not validate untouched non-selected provider keys", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: {
      OPENAI_API_KEY: "openai-key",
      GEMINI_API_KEY: "existing-gemini-key",
      ANTHROPIC_API_KEY: "existing-anthropic-key"
    },
    fetchImpl: makeProviderValidationFetch(calls)
  });

  const result = await handleUpdateLeaSettings({
    leaRepoPath: leaRepo,
    leaApiBaseUrl: "http://127.0.0.1:8000",
    leaModel: "gpt-5.4",
    leaMaxTurns: 20
  }, state);

  assert.equal(result.statusCode, 200);
  assert.deepEqual(calls.map((call) => call.family), ["openai"]);
});

test("formalize starts Lea without root workspace paths", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "test-key" },
    fetchImpl: makeLeaApiFetch(calls)
  });

  const result = await handleFormalize({
    overleafProjectId: "project-1",
    theoremLabel: "lea_test",
    theoremText: "A theorem."
  }, state);

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, "in_progress");
  assert.equal(result.body.relativePath, path.join("workspace", "projects", "project-1.md"));
  assert.equal(result.body.projectMarkdownPath, path.join(leaRepo, "workspace", "projects", "project-1.md"));
  await waitFor(() => calls.length > 0);
  assert.equal(calls[0].url, "http://127.0.0.1:8000/v1/runs");
  assert.equal(calls[0].body.config.model.name, "o4-mini");
  assert.equal(calls[0].body.config.model.model_kwargs.api_key, "test-key");
  assert.equal(calls[0].body.config.model.model_kwargs.max_tokens, 16384);
  assert.equal(calls[0].body.config.agent.max_turns, 20);
  assert.deepEqual(calls[0].body.project, {
    project_id: "project-1",
    project_path: path.join("workspace", "projects", "project-1.md"),
    record_on_success: true
  });
  assert.match(calls[0].body.task, /project project-1/);
  assert.match(calls[0].body.task, /A theorem\./);
  assert.match(calls[0].body.task, /Use the Lea project context/);
  assert.doesNotMatch(calls[0].body.task, /also record the theorem/);
});

test("formalize includes optional theorem context in the Lea prompt", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "test-key" },
    fetchImpl: makeLeaApiFetch(calls)
  });

  const result = await handleFormalize({
    overleafProjectId: "project-1",
    theoremLabel: "context_test",
    theoremText: "A theorem.",
    theoremContext: "Use induction on n."
  }, state);

  assert.equal(result.statusCode, 200);
  await waitFor(() => calls.length > 0);
  assert.match(calls[0].body.task, /A theorem\.\n\nFormalization Guidance: Use induction on n\./);
  assert.equal(state.jobs[result.body.jobId].theoremContext, "Use induction on n.");
});

test("formalize omits blank theorem context from the Lea prompt", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "test-key" },
    fetchImpl: makeLeaApiFetch(calls)
  });

  const result = await handleFormalize({
    overleafProjectId: "project-1",
    theoremLabel: "blank_context_test",
    theoremText: "A theorem.",
    theoremContext: "   "
  }, state);

  assert.equal(result.statusCode, 200);
  await waitFor(() => calls.length > 0);
  assert.doesNotMatch(calls[0].body.task, /Formalization Guidance:/);
  assert.equal(state.jobs[result.body.jobId].theoremContext, "");
});

test("formalize sends the selected model family key to Lea", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const state = await makeState({
    leaRepoPath: leaRepo,
    leaModel: "gemini/gemini-2.5-pro",
    env: { GEMINI_API_KEY: "gemini-key" },
    fetchImpl: makeLeaApiFetch(calls)
  });

  const result = await handleFormalize({
    overleafProjectId: "project-1",
    theoremLabel: "gemini_test",
    theoremText: "A theorem."
  }, state);

  assert.equal(result.statusCode, 200);
  await waitFor(() => calls.length > 0);
  assert.equal(calls[0].body.config.model.name, "gemini/gemini-2.5-pro");
  assert.equal(calls[0].body.config.model.model_kwargs.api_key, "gemini-key");
  assert.equal(calls[0].body.config.model.model_kwargs.max_tokens, 16384);
});

test("formalize sends normalized legacy model ids to Lea", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const state = await makeState({
    leaRepoPath: leaRepo,
    leaModel: "anthropic/claude-sonnet-4-20250514",
    env: { ANTHROPIC_API_KEY: "anthropic-key" },
    fetchImpl: makeLeaApiFetch(calls)
  });

  const result = await handleFormalize({
    overleafProjectId: "project-1",
    theoremLabel: "anthropic_test",
    theoremText: "A theorem."
  }, state);

  assert.equal(result.statusCode, 200);
  await waitFor(() => calls.length > 0);
  assert.equal(calls[0].body.config.model.name, "anthropic/claude-sonnet-4-6");
  assert.equal(calls[0].body.config.model.model_kwargs.api_key, "anthropic-key");
});

test("formalize returns active job instead of starting a duplicate", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "test-key" },
    fetchImpl: makeLeaApiFetch(calls)
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
  assert.equal(calls.filter((call) => call.url.endsWith("/v1/runs")).length, 1);
});

test("stub starts Lea in theorem translation approval mode and records a sorry stub", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "test-key" },
    fetchImpl: makeLeaApiFetch(calls, {
      approval: {
        leanCode: "import Mathlib\n\ntheorem generated_stub_test : True := by sorry",
        theoremName: "generated_stub_test"
      }
    })
  });

  const result = await handleStub({
    overleafProjectId: "project-1",
    theoremLabel: "stub_label",
    theoremText: "A theorem."
  }, state);

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, "sorry_stub");
  assert.equal(result.body.declarationName, "generated_stub_test");
  assert.equal(calls[0].url, "http://127.0.0.1:8000/v1/runs");
  assert.equal(calls[0].body.config.agent.permission_tier, "theorem_translation");
  assert.equal(calls[0].body.config.model.model_kwargs.api_key, "test-key");
  const job = state.jobs[result.body.jobId];
  assert.equal(job.status, "sorry_stub");
  assert.equal(job.apiRunId, "api-run-1");
  assert.equal(job.approvalId, "ap_1");
  assert.equal(
    await fs.readFile(path.join(leaRepo, job.recordedProofPath), "utf8"),
    "import Mathlib\n\ntheorem generated_stub_test : True := by sorry\n"
  );
  assert.match(
    await fs.readFile(path.join(leaRepo, "workspace", "projects", "project-1.md"), "utf8"),
    /<!-- lea:theorem name="generated_stub_test" proof="workspace\/proofs\/Lea\/Project1\/generated_stub_test\.lean" module="Lea\.Project1\.generated_stub_test" -->/
  );
});

test("stub allows retrying failed unformalized theorems", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "test-key" },
    fetchImpl: makeLeaApiFetch(calls, {
      approval: {
        leanCode: "import Mathlib\n\ntheorem retried_failed_stub_test : True := by sorry",
        theoremName: "retried_failed_stub_test"
      }
    })
  });
  state.jobs.failed_job = {
    jobId: "failed_job",
    jobKey: "project-1:failed_stub_retry",
    status: "failed",
    theoremLabel: "failed_stub_retry",
    relativePath: path.join("workspace", "projects", "project-1.md"),
    absolutePath: path.join(leaRepo, "workspace", "projects", "project-1.md"),
    logPath: path.join(path.dirname(state.jobsPath), "failed-stub-retry.log"),
    leaRepoPath: leaRepo,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z"
  };
  await fs.writeFile(state.jobs.failed_job.logPath, "failed proof\n", "utf8");

  const result = await handleStub({
    overleafProjectId: "project-1",
    theoremLabel: "failed_stub_retry",
    theoremText: "A theorem."
  }, state);

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, "sorry_stub");
  assert.equal(result.body.declarationName, "retried_failed_stub_test");
  assert.equal(calls[0].body.config.agent.permission_tier, "theorem_translation");
});

test("statuses report saved sorry stubs", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({ leaRepoPath: leaRepo });
  const proofPath = path.join("workspace", "proofs", "Lea", "Project1", "SavedStub.lean");
  await writeLeaProjectProof(
    leaRepo,
    proofPath,
    "theorem saved_stub_test : True := by\n  sorry\n"
  );
  await writeLeaProjectMarkdown(leaRepo, "project-1", {
    theoremName: "saved_stub_test",
    proofPath
  });

  const result = await handleGetStatuses({
    overleafProjectId: "project-1",
    theorems: [{ theoremLabel: "saved_stub_test", theoremText: "A theorem." }]
  }, state);

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.statuses.saved_stub_test.status, "sorry_stub");
  assert.equal(result.body.statuses.saved_stub_test.leanStatement, "theorem saved_stub_test : True");
});

test("formalize after stub accepts the saved Lea approval and completes proof search", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const proofPath = path.join("workspace", "proofs", "Lea", "Project1", "generated_stub_test.lean");
  const restorePath = await installFakeLake();
  try {
    const state = await makeState({
      leaRepoPath: leaRepo,
      env: { OPENAI_API_KEY: "test-key" },
      fetchImpl: makeLeaApiFetch(calls, {
        approval: {
          leanCode: "import Mathlib\n\ntheorem generated_stub_test : True := by sorry",
          theoremName: "generated_stub_test"
        },
        statusBody: { run_id: "api-run-1", status: "completed", result: { reason: "success" } },
        onStatusRequest: async () => {
          await writeLeaProjectProof(
            leaRepo,
            proofPath,
            "theorem generated_stub_test : True := by\n  trivial\n"
          );
          await writeLeaProjectMarkdown(leaRepo, "project-1", {
            theoremName: "generated_stub_test",
            proofPath,
            moduleName: "Lea.Project1.generated_stub_test"
          });
        }
      })
    });

    const stubResult = await handleStub({
      overleafProjectId: "project-1",
      theoremLabel: "stub_label",
      theoremText: "A theorem."
    }, state);
    const formalizeResult = await handleFormalize({
      overleafProjectId: "project-1",
      theoremLabel: "stub_label",
      theoremText: "A theorem."
    }, state);

    assert.equal(stubResult.statusCode, 200);
    assert.equal(formalizeResult.statusCode, 200);
    assert.equal(formalizeResult.body.status, "in_progress");
    await waitFor(() => state.jobs[stubResult.body.jobId]?.status === "formalized");
    assert.ok(calls.some((call) => String(call.url).endsWith("/v1/runs/api-run-1/approvals/ap_1")));
    assert.equal(state.jobs[stubResult.body.jobId].declarationName, "generated_stub_test");
    assert.equal(state.jobs[stubResult.body.jobId].recordedProofPath, proofPath);
  } finally {
    restorePath();
  }
});

test("stub rejects missing provider keys and non-unformalized theorems", async () => {
  const leaRepo = await makeLeaRepo();
  const missingKeyState = await makeState({ leaRepoPath: leaRepo, env: {} });
  const missingKey = await handleStub({
    overleafProjectId: "project-1",
    theoremLabel: "missing_key_stub",
    theoremText: "A theorem."
  }, missingKeyState);
  assert.equal(missingKey.statusCode, 400);
  assert.equal(missingKey.body.error, "missing_openai_key");

  const proofPath = path.join("workspace", "proofs", "Lea", "Project1", "Already.lean");
  await writeLeaProjectProof(leaRepo, proofPath, "theorem already_formalized : True := by\n  trivial\n");
  await writeLeaProjectMarkdown(leaRepo, "project-1", {
    theoremName: "already_formalized",
    proofPath
  });
  const formalizedState = await makeState({
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "test-key" },
    fetchImpl: makeLeaApiFetch([])
  });
  const formalized = await handleStub({
    overleafProjectId: "project-1",
    theoremLabel: "already_formalized",
    theoremText: "A theorem."
  }, formalizedState);

  assert.equal(formalized.statusCode, 409);
  assert.equal(formalized.body.error, "not_unformalized");
});

test("statuses report active Lea jobs as in progress", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "test-key" },
    fetchImpl: makeLeaApiFetch([])
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

test("formalize response includes turn progress after Lea events report a current turn", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "test-key" },
    fetchImpl: makeLeaApiFetch([], {
      eventFrames: [
        { type: "turn_started", turn: 6 }
      ]
    })
  });
  const payload = {
    overleafProjectId: "project-1",
    theoremLabel: "event_turn_test",
    theoremText: "A theorem."
  };

  const first = await handleFormalize(payload, state);
  await waitFor(() => state.jobs[first.body.jobId]?.leaCurrentTurn === 6);
  const second = await handleFormalize(payload, state);

  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.body.turnProgress, { current: 6, max: 20 });
});

test("statuses include turn progress for active Lea jobs", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "test-key" },
    fetchImpl: makeLeaApiFetch([], {
      eventFrames: [
        { type: "turn_started", turn: 6 }
      ]
    })
  });

  const result = await handleFormalize({
    overleafProjectId: "project-1",
    theoremLabel: "active_progress_test",
    theoremText: "A theorem."
  }, state);

  await waitFor(() => state.jobs[result.body.jobId]?.leaCurrentTurn === 6);
  const statuses = await handleGetStatuses({
    overleafProjectId: "project-1",
    theorems: [{ theoremLabel: "active_progress_test", theoremText: "A theorem." }]
  }, state);

  assert.equal(statuses.statusCode, 200);
  assert.deepEqual(statuses.body.statuses.active_progress_test.turnProgress, { current: 6, max: 20 });
});

test("status polling updates active Lea job turn progress when events omit it", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "test-key" },
    fetchImpl: makeLeaApiFetch([], {
      statusBody: {
        run_id: "api-run-1",
        status: "running",
        progress: {
          turn: 6
        }
      }
    })
  });

  const result = await handleFormalize({
    overleafProjectId: "project-1",
    theoremLabel: "poll_turn_test",
    theoremText: "A theorem."
  }, state);

  await waitFor(() => state.jobs[result.body.jobId]?.leaCurrentTurn === 6);
  assert.deepEqual(state.jobs[result.body.jobId].leaMaxTurns, 20);

  const statuses = await handleGetStatuses({
    overleafProjectId: "project-1",
    theorems: [{ theoremLabel: "poll_turn_test", theoremText: "A theorem." }]
  }, state);

  assert.deepEqual(statuses.body.statuses.poll_turn_test.turnProgress, { current: 6, max: 20 });
});

test("active Lea job omits turn progress when current turn is unknown or invalid", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "test-key" },
    fetchImpl: makeLeaApiFetch([], {
      eventFrames: [
        { type: "agent_progress", current_turn: 0, max_turns: 20 }
      ]
    })
  });

  const result = await handleFormalize({
    overleafProjectId: "project-1",
    theoremLabel: "unknown_turn_test",
    theoremText: "A theorem."
  }, state);

  await waitFor(() => state.jobs[result.body.jobId]?.status === "in_progress");
  const statuses = await handleGetStatuses({
    overleafProjectId: "project-1",
    theorems: [{ theoremLabel: "unknown_turn_test", theoremText: "A theorem." }]
  }, state);

  assert.equal(statuses.statusCode, 200);
  assert.equal(statuses.body.statuses.unknown_turn_test.status, "in_progress");
  assert.equal(statuses.body.statuses.unknown_turn_test.turnProgress, undefined);
});

test("statuses report formalized proofs recorded in Lea project markdown", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({ leaRepoPath: leaRepo });
  const proofPath = path.join("workspace", "proofs", "Lea", "Project1", "ProjectProof.lean");
  await writeLeaProjectProof(
    leaRepo,
    proofPath,
    "namespace Lea.Project1\n\nlemma project_markdown_test : True := by\n  trivial\n\nend Lea.Project1\n"
  );
  await writeLeaProjectMarkdown(leaRepo, "project-1", {
    theoremName: "project_markdown_test",
    proofPath,
    moduleName: "Lea.Project1.ProjectProof"
  });

  const configured = await handleGetStatuses({
    overleafProjectId: "project-1",
    theorems: [{ theoremLabel: "project_markdown_test", theoremText: "A theorem." }]
  }, state);
  const status = configured.body.statuses.project_markdown_test;
  assert.equal(configured.statusCode, 200);
  assert.equal(status.status, "formalized");
  assert.equal(status.leanStatement, "lemma project_markdown_test : True");
  assert.equal(status.projectId, "project-1");
  assert.equal(status.projectSlug, "project-1");
  assert.equal(status.projectMarkdownPath, path.join(leaRepo, "workspace", "projects", "project-1.md"));
  assert.equal(status.recordedProofPath, proofPath);
  assert.equal(status.moduleName, "Lea.Project1.ProjectProof");
  assert.equal(status.absolutePath, path.join(leaRepo, proofPath));
});

test("formalize maps an Overleaf label to the Lean artifact Lea records", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const proofPath = path.join("workspace", "proofs", "Lea", "Project1", "even_square_of_even.lean");
  const restorePath = await installFakeLake();
  try {
    const state = await makeState({
      leaRepoPath: leaRepo,
      env: { OPENAI_API_KEY: "test-key" },
      fetchImpl: makeLeaApiFetch(calls, {
        statusBody: { run_id: "api-run-1", status: "completed", result: { reason: "success" } },
        onStatusRequest: async () => {
          await writeLeaProjectProof(
            leaRepo,
            proofPath,
            "theorem even_square_of_even : True := by\n  trivial\n"
          );
          await writeLeaProjectMarkdown(leaRepo, "project-1", {
            theoremName: "even_square_of_even",
            proofPath,
            moduleName: "Lea.Project1.even_square_of_even"
          });
        }
      })
    });

    const result = await handleFormalize({
      overleafProjectId: "project-1",
      theoremLabel: "epsilon_one",
      theoremText: [
        "Formalize this theorem as part of project epsilon.",
        "Theorem name: even_square_of_even",
        "Lean signature:",
        "theorem even_square_of_even : True := by"
      ].join("\n")
    }, state);

    await waitFor(() => state.jobs[result.body.jobId]?.status === "formalized");
    assert.match(calls[0].body.task, /Overleaf theorem labeled epsilon_one/);
    assert.match(calls[0].body.task, /use that name/);
    assert.match(calls[0].body.task, /no sorry\/admit in theorem even_square_of_even/);
    const job = state.jobs[result.body.jobId];
    assert.equal(job.theoremLabel, "epsilon_one");
    assert.equal(job.declarationName, "even_square_of_even");
    assert.equal(job.recordedProofPath, proofPath);
    assert.equal(job.moduleName, "Lea.Project1.even_square_of_even");

    const statuses = await handleGetStatuses({
      overleafProjectId: "project-1",
      theorems: [{ theoremLabel: "epsilon_one", theoremText: "A theorem." }]
    }, state);

    const status = statuses.body.statuses.epsilon_one;
    assert.equal(statuses.statusCode, 200);
    assert.equal(status.status, "formalized");
    assert.equal(status.theoremLabel, "epsilon_one");
    assert.equal(status.declarationName, "even_square_of_even");
    assert.equal(status.recordedProofPath, proofPath);
    assert.equal(status.leanStatement, "theorem even_square_of_even : True");
  } finally {
    restorePath();
  }
});

test("formalize includes resolved theorem uses in the Lea prompt", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const dependencyProofPath = path.join("workspace", "proofs", "Lea", "Project1", "even_square_of_even.lean");
  const targetProofPath = path.join("workspace", "proofs", "Lea", "Project1", "even_square_of_double_plus_double.lean");
  const restorePath = await installFakeLake();
  try {
    await writeLeaProjectProof(
      leaRepo,
      dependencyProofPath,
      "theorem even_square_of_even : True := by\n  trivial\n"
    );
    const state = await makeState({
      leaRepoPath: leaRepo,
      env: { OPENAI_API_KEY: "test-key" },
      fetchImpl: makeLeaApiFetch(calls, {
        statusBody: { run_id: "api-run-1", status: "completed", result: { reason: "success" } },
        onStatusRequest: async () => {
          await writeLeaProjectProof(
            leaRepo,
            targetProofPath,
            "theorem even_square_of_double_plus_double : True := by\n  trivial\n"
          );
          await writeLeaProjectMarkdown(leaRepo, "project-1", {
            theoremName: "even_square_of_double_plus_double",
            proofPath: targetProofPath,
            moduleName: "Lea.Project1.even_square_of_double_plus_double"
          });
        }
      })
    });
    state.jobs["epsilon-one-job"] = {
      jobId: "epsilon-one-job",
      jobKey: "project-1:epsilon_one",
      status: "formalized",
      declarationName: "even_square_of_even",
      recordedProofPath: dependencyProofPath,
      moduleName: "Lea.Project1.even_square_of_even",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z"
    };

    const result = await handleFormalize({
      overleafProjectId: "project-1",
      theoremLabel: "epsilon_two",
      theoremText: [
        "Theorem name: even_square_of_double_plus_double",
        "Lean signature:",
        "theorem even_square_of_double_plus_double : True := by"
      ].join("\n"),
      theoremUses: ["epsilon_one"]
    }, state);

    await waitFor(() => state.jobs[result.body.jobId]?.status === "formalized");
    assert.equal(result.statusCode, 200);
    assert.match(
      calls[0].body.task,
      new RegExp(`To formalize the theorem make use of the even_square_of_even theorem at ${escapeRegExp(path.join(leaRepo, dependencyProofPath))}\\.`)
    );
    assert.deepEqual(state.jobs[result.body.jobId].theoremUses, [{
      theoremLabel: "epsilon_one",
      declarationName: "even_square_of_even",
      relativePath: dependencyProofPath,
      absolutePath: path.join(leaRepo, dependencyProofPath),
      moduleName: "Lea.Project1.even_square_of_even",
      status: "formalized"
    }]);
  } finally {
    restorePath();
  }
});

test("formalize includes multiple resolved theorem uses in source order", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const firstProofPath = path.join("workspace", "proofs", "Lea", "Project1", "first_support.lean");
  const secondProofPath = path.join("workspace", "proofs", "Lea", "Project1", "second_support.lean");
  const targetProofPath = path.join("workspace", "proofs", "Lea", "Project1", "multi_use_target.lean");
  const restorePath = await installFakeLake();
  try {
    await writeLeaProjectProof(leaRepo, firstProofPath, "theorem first_support : True := by\n  trivial\n");
    await writeLeaProjectProof(leaRepo, secondProofPath, "theorem second_support : True := by\n  trivial\n");
    const state = await makeState({
      leaRepoPath: leaRepo,
      env: { OPENAI_API_KEY: "test-key" },
      fetchImpl: makeLeaApiFetch(calls, {
        statusBody: { run_id: "api-run-1", status: "completed", result: { reason: "success" } },
        onStatusRequest: async () => {
          await writeLeaProjectProof(leaRepo, targetProofPath, "theorem multi_use_target : True := by\n  trivial\n");
          await writeLeaProjectMarkdown(leaRepo, "project-1", {
            theoremName: "multi_use_target",
            proofPath: targetProofPath
          });
        }
      })
    });
    state.jobs["first-support-job"] = {
      jobId: "first-support-job",
      jobKey: "project-1:first_label",
      status: "formalized",
      declarationName: "first_support",
      recordedProofPath: firstProofPath,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z"
    };
    state.jobs["second-support-job"] = {
      jobId: "second-support-job",
      jobKey: "project-1:second_label",
      status: "formalized",
      declarationName: "second_support",
      recordedProofPath: secondProofPath,
      startedAt: "2026-01-01T00:00:02.000Z",
      finishedAt: "2026-01-01T00:00:03.000Z"
    };

    const result = await handleFormalize({
      overleafProjectId: "project-1",
      theoremLabel: "multi_use_target",
      theoremText: "theorem multi_use_target : True := by",
      theoremUses: ["first_label", "second_label"],
      theoremContext: "Reuse the support lemmas in the listed order."
    }, state);

    await waitFor(() => state.jobs[result.body.jobId]?.status === "formalized");
    const task = calls[0].body.task;
    const firstIndex = task.indexOf(`make use of the first_support theorem at ${path.join(leaRepo, firstProofPath)}.`);
    const secondIndex = task.indexOf(`make use of the second_support theorem at ${path.join(leaRepo, secondProofPath)}.`);
    assert.notEqual(firstIndex, -1);
    assert.notEqual(secondIndex, -1);
    assert.ok(firstIndex < secondIndex);
    assert.match(task, /Formalization Guidance: Reuse the support lemmas in the listed order\./);
  } finally {
    restorePath();
  }
});

test("formalize allows theorem uses backed by sorry stubs", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const dependencyProofPath = path.join("workspace", "proofs", "Lea", "Project1", "stub_support.lean");
  const targetProofPath = path.join("workspace", "proofs", "Lea", "Project1", "uses_stub_support.lean");
  const restorePath = await installFakeLake();
  try {
    await writeLeaProjectProof(leaRepo, dependencyProofPath, "theorem stub_support : True := by\n  sorry\n");
    await writeLeaProjectMarkdown(leaRepo, "project-1", {
      theoremName: "stub_support",
      proofPath: dependencyProofPath,
      moduleName: "Lea.Project1.stub_support"
    });
    const state = await makeState({
      leaRepoPath: leaRepo,
      env: { OPENAI_API_KEY: "test-key" },
      fetchImpl: makeLeaApiFetch(calls, {
        statusBody: { run_id: "api-run-1", status: "completed", result: { reason: "success" } },
        onStatusRequest: async () => {
          await writeLeaProjectProof(leaRepo, targetProofPath, "import Lea.Project1.stub_support\n\ntheorem uses_stub_support : True := by\n  trivial\n");
          await writeLeaProjectMarkdownEntries(leaRepo, "project-1", [
            {
              theoremName: "stub_support",
              proofPath: dependencyProofPath,
              moduleName: "Lea.Project1.stub_support"
            },
            {
              theoremName: "uses_stub_support",
              proofPath: targetProofPath
            }
          ]);
        }
      })
    });

    const result = await handleFormalize({
      overleafProjectId: "project-1",
      theoremLabel: "uses_stub_support",
      theoremText: "theorem uses_stub_support : True := by",
      theoremUses: ["stub_support"]
    }, state);

    assert.equal(result.statusCode, 200);
    await waitFor(() => state.jobs[result.body.jobId]?.status === "formalized");
    assert.match(
      calls[0].body.task,
      new RegExp(`To formalize the theorem make use of the stub_support theorem at ${escapeRegExp(path.join(leaRepo, dependencyProofPath))}\\.`)
    );
    assert.deepEqual(state.jobs[result.body.jobId].theoremUses, [{
      theoremLabel: "stub_support",
      declarationName: "stub_support",
      relativePath: dependencyProofPath,
      absolutePath: path.join(leaRepo, dependencyProofPath),
      moduleName: "Lea.Project1.stub_support",
      status: "sorry_stub"
    }]);
    assert.deepEqual(state.jobs[result.body.jobId].stubbedTheoremUses, [{
      theoremLabel: "stub_support",
      declarationName: "stub_support",
      moduleName: "Lea.Project1.stub_support",
      relativePath: dependencyProofPath,
      absolutePath: path.join(leaRepo, dependencyProofPath)
    }]);
    const statuses = await handleGetStatuses({
      overleafProjectId: "project-1",
      theorems: [{ theoremLabel: "uses_stub_support", theoremText: "A theorem." }]
    }, state);
    assert.equal(statuses.body.statuses.uses_stub_support.status, "formalized");
    assert.deepEqual(statuses.body.statuses.uses_stub_support.stubbedTheoremUses, [{
      theoremLabel: "stub_support",
      declarationName: "stub_support",
      moduleName: "Lea.Project1.stub_support",
      relativePath: dependencyProofPath,
      absolutePath: path.join(leaRepo, dependencyProofPath)
    }]);
    assert.equal(statuses.body.statuses.uses_stub_support.hasStubbedTheoremUses, true);

    await writeLeaProjectProof(leaRepo, dependencyProofPath, "theorem stub_support : True := by\n  trivial\n");
    const refreshedStatuses = await handleGetStatuses({
      overleafProjectId: "project-1",
      theorems: [{ theoremLabel: "uses_stub_support", theoremText: "A theorem." }]
    }, state);
    assert.equal(refreshedStatuses.body.statuses.uses_stub_support.status, "formalized");
    assert.equal(refreshedStatuses.body.statuses.uses_stub_support.stubbedTheoremUses, undefined);
    assert.equal(refreshedStatuses.body.statuses.uses_stub_support.hasStubbedTheoremUses, undefined);
  } finally {
    restorePath();
  }
});

test("formalized theorem has no stubbed-use warning when stub support is not imported", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const dependencyProofPath = path.join("workspace", "proofs", "Lea", "Project1", "unused_stub_support.lean");
  const targetProofPath = path.join("workspace", "proofs", "Lea", "Project1", "does_not_import_stub_support.lean");
  const restorePath = await installFakeLake();
  try {
    await writeLeaProjectProof(leaRepo, dependencyProofPath, "theorem unused_stub_support : True := by\n  sorry\n");
    await writeLeaProjectMarkdown(leaRepo, "project-1", {
      theoremName: "unused_stub_support",
      proofPath: dependencyProofPath,
      moduleName: "Lea.Project1.unused_stub_support"
    });
    const state = await makeState({
      leaRepoPath: leaRepo,
      env: { OPENAI_API_KEY: "test-key" },
      fetchImpl: makeLeaApiFetch(calls, {
        statusBody: { run_id: "api-run-1", status: "completed", result: { reason: "success" } },
        onStatusRequest: async () => {
          await writeLeaProjectProof(leaRepo, targetProofPath, "theorem does_not_import_stub_support : True := by\n  trivial\n");
          await writeLeaProjectMarkdownEntries(leaRepo, "project-1", [
            {
              theoremName: "unused_stub_support",
              proofPath: dependencyProofPath,
              moduleName: "Lea.Project1.unused_stub_support"
            },
            {
              theoremName: "does_not_import_stub_support",
              proofPath: targetProofPath
            }
          ]);
        }
      })
    });

    const result = await handleFormalize({
      overleafProjectId: "project-1",
      theoremLabel: "does_not_import_stub_support",
      theoremText: "theorem does_not_import_stub_support : True := by",
      theoremUses: ["unused_stub_support"]
    }, state);

    assert.equal(result.statusCode, 200);
    await waitFor(() => state.jobs[result.body.jobId]?.status === "formalized");
    assert.deepEqual(state.jobs[result.body.jobId].stubbedTheoremUses, []);
    const statuses = await handleGetStatuses({
      overleafProjectId: "project-1",
      theorems: [{ theoremLabel: "does_not_import_stub_support", theoremText: "A theorem." }]
    }, state);
    assert.equal(statuses.body.statuses.does_not_import_stub_support.status, "formalized");
    assert.equal(statuses.body.statuses.does_not_import_stub_support.stubbedTheoremUses, undefined);
    assert.equal(statuses.body.statuses.does_not_import_stub_support.hasStubbedTheoremUses, undefined);
  } finally {
    restorePath();
  }
});

test("formalized theorem has no stubbed-use warning when imported support is formalized", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const dependencyProofPath = path.join("workspace", "proofs", "Lea", "Project1", "formalized_support.lean");
  const targetProofPath = path.join("workspace", "proofs", "Lea", "Project1", "imports_formalized_support.lean");
  const restorePath = await installFakeLake();
  try {
    await writeLeaProjectProof(leaRepo, dependencyProofPath, "theorem formalized_support : True := by\n  trivial\n");
    await writeLeaProjectMarkdown(leaRepo, "project-1", {
      theoremName: "formalized_support",
      proofPath: dependencyProofPath,
      moduleName: "Lea.Project1.formalized_support"
    });
    const state = await makeState({
      leaRepoPath: leaRepo,
      env: { OPENAI_API_KEY: "test-key" },
      fetchImpl: makeLeaApiFetch(calls, {
        statusBody: { run_id: "api-run-1", status: "completed", result: { reason: "success" } },
        onStatusRequest: async () => {
          await writeLeaProjectProof(leaRepo, targetProofPath, "import Lea.Project1.formalized_support\n\ntheorem imports_formalized_support : True := by\n  trivial\n");
          await writeLeaProjectMarkdownEntries(leaRepo, "project-1", [
            {
              theoremName: "formalized_support",
              proofPath: dependencyProofPath,
              moduleName: "Lea.Project1.formalized_support"
            },
            {
              theoremName: "imports_formalized_support",
              proofPath: targetProofPath
            }
          ]);
        }
      })
    });

    const result = await handleFormalize({
      overleafProjectId: "project-1",
      theoremLabel: "imports_formalized_support",
      theoremText: "theorem imports_formalized_support : True := by",
      theoremUses: ["formalized_support"]
    }, state);

    assert.equal(result.statusCode, 200);
    await waitFor(() => state.jobs[result.body.jobId]?.status === "formalized");
    assert.deepEqual(state.jobs[result.body.jobId].stubbedTheoremUses, []);
    assert.deepEqual(state.jobs[result.body.jobId].theoremUses, [{
      theoremLabel: "formalized_support",
      declarationName: "formalized_support",
      relativePath: dependencyProofPath,
      absolutePath: path.join(leaRepo, dependencyProofPath),
      moduleName: "Lea.Project1.formalized_support",
      status: "formalized"
    }]);
  } finally {
    restorePath();
  }
});

test("formalize allows theorem uses backed by failed sorry stubs", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const dependencyProofPath = path.join("workspace", "proofs", "Lea", "Project1", "failed_stub_support.lean");
  const targetProofPath = path.join("workspace", "proofs", "Lea", "Project1", "uses_failed_stub_support.lean");
  const restorePath = await installFakeLake();
  try {
    await writeLeaProjectProof(leaRepo, dependencyProofPath, "theorem failed_stub_support : True := by\n  sorry\n");
    await writeLeaProjectMarkdown(leaRepo, "project-1", {
      theoremName: "failed_stub_support",
      proofPath: dependencyProofPath,
      moduleName: "Lea.Project1.failed_stub_support"
    });
    const state = await makeState({
      leaRepoPath: leaRepo,
      env: { OPENAI_API_KEY: "test-key" },
      fetchImpl: makeLeaApiFetch(calls, {
        statusBody: { run_id: "api-run-1", status: "completed", result: { reason: "success" } },
        onStatusRequest: async () => {
          await writeLeaProjectProof(leaRepo, targetProofPath, "import Lea.Project1.failed_stub_support\n\ntheorem uses_failed_stub_support : True := by\n  trivial\n");
          await writeLeaProjectMarkdownEntries(leaRepo, "project-1", [
            {
              theoremName: "failed_stub_support",
              proofPath: dependencyProofPath,
              moduleName: "Lea.Project1.failed_stub_support"
            },
            {
              theoremName: "uses_failed_stub_support",
              proofPath: targetProofPath
            }
          ]);
        }
      })
    });
    state.jobs.failed_stub_job = {
      jobId: "failed_stub_job",
      jobKey: "project-1:failed_stub_support",
      status: "failed",
      finalStatus: "sorry_stub",
      theoremLabel: "failed_stub_support",
      declarationName: "failed_stub_support",
      recordedProofPath: dependencyProofPath,
      moduleName: "Lea.Project1.failed_stub_support",
      relativePath: path.join("workspace", "projects", "project-1.md"),
      absolutePath: path.join(leaRepo, "workspace", "projects", "project-1.md"),
      logPath: path.join(path.dirname(state.jobsPath), "failed-stub-support.log"),
      leaRepoPath: leaRepo,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z"
    };
    await fs.writeFile(state.jobs.failed_stub_job.logPath, "failed after stub\n", "utf8");

    const statuses = await handleGetStatuses({
      overleafProjectId: "project-1",
      theorems: [{ theoremLabel: "failed_stub_support", theoremText: "A theorem." }]
    }, state);

    assert.equal(statuses.statusCode, 200);
    assert.equal(statuses.body.statuses.failed_stub_support.status, "failed");
    assert.equal(statuses.body.statuses.failed_stub_support.effectiveStatus, "sorry_stub");
    assert.equal(statuses.body.statuses.failed_stub_support.leanStatement, "theorem failed_stub_support : True");

    const result = await handleFormalize({
      overleafProjectId: "project-1",
      theoremLabel: "uses_failed_stub_support",
      theoremText: "theorem uses_failed_stub_support : True := by",
      theoremUses: ["failed_stub_support"]
    }, state);

    assert.equal(result.statusCode, 200);
    await waitFor(() => state.jobs[result.body.jobId]?.status === "formalized");
    assert.match(
      calls[0].body.task,
      new RegExp(`To formalize the theorem make use of the failed_stub_support theorem at ${escapeRegExp(path.join(leaRepo, dependencyProofPath))}\\.`)
    );
    assert.deepEqual(state.jobs[result.body.jobId].theoremUses, [{
      theoremLabel: "failed_stub_support",
      declarationName: "failed_stub_support",
      relativePath: dependencyProofPath,
      absolutePath: path.join(leaRepo, dependencyProofPath),
      moduleName: "Lea.Project1.failed_stub_support",
      status: "sorry_stub"
    }]);
    assert.deepEqual(state.jobs[result.body.jobId].stubbedTheoremUses, [{
      theoremLabel: "failed_stub_support",
      declarationName: "failed_stub_support",
      moduleName: "Lea.Project1.failed_stub_support",
      relativePath: dependencyProofPath,
      absolutePath: path.join(leaRepo, dependencyProofPath)
    }]);
  } finally {
    restorePath();
  }
});

test("formalize blocks unresolved theorem uses", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "test-key" },
    fetchImpl: makeLeaApiFetch(calls)
  });

  const result = await handleFormalize({
    overleafProjectId: "project-1",
    theoremLabel: "needs_support",
    theoremText: "A theorem.",
    theoremUses: ["missing_support"]
  }, state);

  assert.equal(result.statusCode, 400);
  assert.equal(result.body.error, "unresolved_uses");
  assert.match(result.body.message, /missing_support/);
  assert.equal(calls.length, 0);
});

test("formalize rejects invalid theorem uses labels", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "test-key" }
  });

  const result = await handleFormalize({
    overleafProjectId: "project-1",
    theoremLabel: "needs_support",
    theoremText: "A theorem.",
    theoremUses: ["invalid-label"]
  }, state);

  assert.equal(result.statusCode, 400);
  assert.equal(result.body.error, "invalid_uses");
});

test("formalize maps unnamed theorem output that uses the Overleaf label", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const proofPath = path.join("workspace", "proofs", "Lea", "Project1", "label_named_result.lean");
  const restorePath = await installFakeLake();
  try {
    const state = await makeState({
      leaRepoPath: leaRepo,
      env: { OPENAI_API_KEY: "test-key" },
      fetchImpl: makeLeaApiFetch(calls, {
        statusBody: { run_id: "api-run-1", status: "completed", result: { reason: "success" } },
        onStatusRequest: async () => {
          await writeLeaProjectProof(
            leaRepo,
            proofPath,
            "theorem label_named_result : True := by\n  trivial\n"
          );
          await writeLeaProjectMarkdown(leaRepo, "project-1", {
            theoremName: "label_named_result",
            proofPath
          });
        }
      })
    });

    const result = await handleFormalize({
      overleafProjectId: "project-1",
      theoremLabel: "label_named_result",
      theoremText: "A theorem without a Lean name."
    }, state);

    await waitFor(() => state.jobs[result.body.jobId]?.status === "formalized");
    assert.equal(state.jobs[result.body.jobId].declarationName, "label_named_result");
    assert.equal(state.jobs[result.body.jobId].recordedProofPath, proofPath);
  } finally {
    restorePath();
  }
});

test("formalize persists completed Lea usage and cost", async () => {
  const leaRepo = await makeLeaRepo();
  const proofPath = path.join("workspace", "proofs", "Lea", "Project1", "usage_capture_test.lean");
  const restorePath = await installFakeLake();
  try {
    const state = await makeState({
      leaRepoPath: leaRepo,
      env: { OPENAI_API_KEY: "test-key" },
      fetchImpl: makeLeaApiFetch([], {
        statusBody: {
          run_id: "api-run-1",
          status: "completed",
          result: {
            reason: "success",
            usage: { input_tokens: 1234, output_tokens: 567 },
            cost: 0.42
          }
        },
        onStatusRequest: async () => {
          await writeLeaProjectProof(
            leaRepo,
            proofPath,
            "theorem usage_capture_test : True := by\n  trivial\n"
          );
          await writeLeaProjectMarkdown(leaRepo, "project-1", {
            theoremName: "usage_capture_test",
            proofPath
          });
        }
      })
    });

    const result = await handleFormalize({
      overleafProjectId: "project-1",
      theoremLabel: "usage_capture_test",
      theoremText: "A theorem."
    }, state);

    await waitFor(() => state.jobs[result.body.jobId]?.status === "formalized");
    assert.deepEqual(state.jobs[result.body.jobId].usage, {
      inputTokens: 1234,
      outputTokens: 567,
      totalTokens: 1801
    });
    assert.equal(state.jobs[result.body.jobId].costUsd, 0.42);
  } finally {
    restorePath();
  }
});

test("usage reflects live Lea event costs while a run is in progress", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "test-key" },
    fetchImpl: makeLeaApiFetch([], {
      eventFrames: [
        { type: "usage_updated", input_tokens: 321, output_tokens: 45, cost: 0.018 },
        { type: "usage_updated", input_tokens: 79, output_tokens: 5, cost: 0.002 }
      ]
    })
  });

  const result = await handleFormalize({
    overleafProjectId: "project-1",
    theoremLabel: "live_usage_test",
    theoremText: "A theorem."
  }, state);

  await waitFor(() => state.jobs[result.body.jobId]?.usage?.inputTokens === 400);
  const job = state.jobs[result.body.jobId];
  assert.equal(job.status, "in_progress");
  assert.deepEqual(job.usage, {
    inputTokens: 400,
    outputTokens: 50,
    totalTokens: 450
  });
  assert.equal(job.costUsd, 0.02);

  const usage = handleGetUsage({ overleafProjectId: "project-1" }, state);
  assert.deepEqual(usage.body.project, {
    inputTokens: 400,
    outputTokens: 50,
    totalTokens: 450,
    costUsd: 0.02,
    runCount: 1
  });
});

test("usage aggregates project and all-time completed run totals", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({ leaRepoPath: leaRepo });
  state.jobs.project_a_first = makeUsageJob({
    jobId: "project_a_first",
    projectId: "project-a",
    inputTokens: 100,
    outputTokens: 25,
    costUsd: 0.12
  });
  state.jobs.project_a_second = makeUsageJob({
    jobId: "project_a_second",
    projectId: "project-a",
    inputTokens: 300,
    outputTokens: 75,
    costUsd: 0.34
  });
  state.jobs.project_b = makeUsageJob({
    jobId: "project_b",
    projectId: "project-b",
    inputTokens: 50,
    outputTokens: 10,
    costUsd: 0.02
  });
  state.jobs.old_without_usage = {
    jobId: "old_without_usage",
    status: "formalized",
    overleafProjectId: "project-a",
    projectSlug: "project-a"
  };

  const result = handleGetUsage({ overleafProjectId: "project-a" }, state);

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body.project, {
    inputTokens: 400,
    outputTokens: 100,
    totalTokens: 500,
    costUsd: 0.46,
    runCount: 2
  });
  assert.deepEqual(result.body.allTime, {
    inputTokens: 450,
    outputTokens: 110,
    totalTokens: 560,
    costUsd: 0.48,
    runCount: 3
  });
});

test("formalize cleans previous failed Lea artifacts before retrying", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const proofPath = path.join("workspace", "proofs", "Lea", "Project1", "retry_target.lean");
  await writeLeaProjectProof(
    leaRepo,
    proofPath,
    "theorem retry_target : True := by\n  trivial\n"
  );
  await writeLeaProjectMarkdown(leaRepo, "project-1", {
    theoremName: "retry_target",
    proofPath
  });

  const restorePath = await installFakeLake();
  try {
    const state = await makeState({
      leaRepoPath: leaRepo,
      env: { OPENAI_API_KEY: "test-key" },
      fetchImpl: makeLeaApiFetch(calls, {
        statusBody: { run_id: "api-run-1", status: "completed", result: { reason: "success" } },
        onStatusRequest: async () => {
          assert.equal(await fileExists(path.join(leaRepo, proofPath)), false);
          assert.doesNotMatch(
            await fs.readFile(path.join(leaRepo, "workspace", "projects", "project-1.md"), "utf8"),
            /retry_target/
          );
          await writeLeaProjectProof(
            leaRepo,
            proofPath,
            "theorem retry_target : True := by\n  trivial\n"
          );
          await writeLeaProjectMarkdown(leaRepo, "project-1", {
            theoremName: "retry_target",
            proofPath
          });
        }
      })
    });
    state.jobs.previous_failed = {
      jobId: "previous_failed",
      jobKey: "project-1:retry_label",
      status: "failed",
      theoremLabel: "retry_label",
      declarationName: "retry_label",
      declarationNameHint: "retry_target",
      relativePath: path.join("workspace", "projects", "project-1.md"),
      absolutePath: path.join(leaRepo, "workspace", "projects", "project-1.md"),
      logPath: path.join(path.dirname(state.jobsPath), "previous-failed.log"),
      leaRepoPath: leaRepo,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z"
    };

    const result = await handleFormalize({
      overleafProjectId: "project-1",
      theoremLabel: "retry_label",
      theoremText: [
        "Theorem name: retry_target",
        "Lean signature:",
        "theorem retry_target : True := by"
      ].join("\n")
    }, state);

    await waitFor(() => state.jobs[result.body.jobId]?.status === "formalized");
    const job = state.jobs[result.body.jobId];
    assert.deepEqual(job.retryCleanup.removedProofPaths, [proofPath]);
    assert.deepEqual(job.retryCleanup.removedProjectEntries, ["retry_target"]);
    assert.equal(job.declarationName, "retry_target");
    assert.equal(job.recordedProofPath, proofPath);
  } finally {
    restorePath();
  }
});

test("formalize fails when Lea records multiple new artifacts without a hint", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const firstProofPath = path.join("workspace", "proofs", "Lea", "Project1", "first_result.lean");
  const secondProofPath = path.join("workspace", "proofs", "Lea", "Project1", "second_result.lean");
  const restorePath = await installFakeLake();
  try {
    const state = await makeState({
      leaRepoPath: leaRepo,
      env: { OPENAI_API_KEY: "test-key" },
      fetchImpl: makeLeaApiFetch(calls, {
        statusBody: { run_id: "api-run-1", status: "completed", result: { reason: "success" } },
        onStatusRequest: async () => {
          await writeLeaProjectProof(leaRepo, firstProofPath, "theorem first_result : True := by\n  trivial\n");
          await writeLeaProjectProof(leaRepo, secondProofPath, "theorem second_result : True := by\n  trivial\n");
          await writeLeaProjectMarkdownEntries(leaRepo, "project-1", [
            { theoremName: "first_result", proofPath: firstProofPath },
            { theoremName: "second_result", proofPath: secondProofPath }
          ]);
        }
      })
    });

    const result = await handleFormalize({
      overleafProjectId: "project-1",
      theoremLabel: "ambiguous_result",
      theoremText: "A theorem without a Lean name."
    }, state);

    await waitFor(() => state.jobs[result.body.jobId]?.status === "failed");
    const job = state.jobs[result.body.jobId];
    assert.equal(job.exitCode, 1);
    assert.match(job.error, /could not uniquely identify Lea output/);
    assert.match(job.error, /first_result/);
    assert.match(job.error, /second_result/);
  } finally {
    restorePath();
  }
});

test("statuses are unformalized when project markdown has no theorem entry", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({ leaRepoPath: leaRepo });
  await writeLeaProjectMarkdown(leaRepo, "project-1", {
    theoremName: "other_theorem",
    proofPath: path.join("workspace", "proofs", "Lea", "Project1", "Other.lean")
  });

  const result = await handleGetStatuses({
    overleafProjectId: "project-1",
    theorems: [{ theoremLabel: "missing_entry_test", theoremText: "A theorem." }]
  }, state);

  const status = result.body.statuses.missing_entry_test;
  assert.equal(result.statusCode, 200);
  assert.equal(status.status, "unformalized");
  assert.equal(status.projectSlug, "project-1");
});

test("statuses are unformalized when project markdown points to a missing proof file", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({ leaRepoPath: leaRepo });
  const proofPath = path.join("workspace", "proofs", "Lea", "Project1", "Missing.lean");
  await writeLeaProjectMarkdown(leaRepo, "project-1", {
    theoremName: "missing_proof_test",
    proofPath,
    moduleName: "Lea.Project1.Missing"
  });

  const result = await handleGetStatuses({
    overleafProjectId: "project-1",
    theorems: [{ theoremLabel: "missing_proof_test", theoremText: "A theorem." }]
  }, state);

  const status = result.body.statuses.missing_proof_test;
  assert.equal(result.statusCode, 200);
  assert.equal(status.status, "unformalized");
  assert.equal(status.recordedProofPath, proofPath);
  assert.match(status.message, /proof file is missing/);
});

test("statuses are sorry_stub when project proof still contains sorry", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({ leaRepoPath: leaRepo });
  const proofPath = path.join("workspace", "proofs", "Lea", "Project1", "Sorry.lean");
  await writeLeaProjectProof(
    leaRepo,
    proofPath,
    "namespace Lea.Project1\n\ntheorem project_sorry_test : True := by\n  sorry\n\nend Lea.Project1\n"
  );
  await writeLeaProjectMarkdown(leaRepo, "project-1", {
    theoremName: "project_sorry_test",
    proofPath
  });

  const result = await handleGetStatuses({
    overleafProjectId: "project-1",
    theorems: [{ theoremLabel: "project_sorry_test", theoremText: "A theorem." }]
  }, state);

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.statuses.project_sorry_test.status, "sorry_stub");
});

test("statuses report formalized direct proof files without project markdown", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({ leaRepoPath: leaRepo });
  const proofPath = path.join("workspace", "proofs", "direct_proof_test.lean");
  await writeLeaProjectProof(
    leaRepo,
    proofPath,
    "import Mathlib\n\ntheorem direct_proof_test : True := by\n  trivial\n"
  );

  const result = await handleGetStatuses({
    overleafProjectId: "project-1",
    theorems: [{ theoremLabel: "direct_proof_test", theoremText: "A theorem." }]
  }, state);

  const status = result.body.statuses.direct_proof_test;
  assert.equal(result.statusCode, 200);
  assert.equal(status.status, "formalized");
  assert.equal(status.relativePath, proofPath);
  assert.equal(status.absolutePath, path.join(leaRepo, proofPath));
  assert.equal(status.leanStatement, "theorem direct_proof_test : True");
});

test("completed direct proof files override stale failed jobs", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({ leaRepoPath: leaRepo });
  const proofPath = path.join("workspace", "proofs", "failed_but_written_test.lean");
  await writeLeaProjectProof(
    leaRepo,
    proofPath,
    "import Mathlib\n\ntheorem failed_but_written_test : True := by\n  trivial\n"
  );
  state.jobs.failed_job = {
    jobId: "failed_job",
    jobKey: "project-1:failed_but_written_test",
    status: "failed",
    theoremLabel: "failed_but_written_test",
    relativePath: path.join("workspace", "projects", "project-1.md"),
    absolutePath: path.join(leaRepo, "workspace", "projects", "project-1.md"),
    logPath: path.join(path.dirname(state.jobsPath), "failed-but-written.log"),
    leaRepoPath: leaRepo,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z"
  };
  await fs.writeFile(state.jobs.failed_job.logPath, "failed proof\n", "utf8");

  const statuses = await handleGetStatuses({
    overleafProjectId: "project-1",
    theorems: [{ theoremLabel: "failed_but_written_test", theoremText: "A theorem." }]
  }, state);

  assert.equal(statuses.statusCode, 200);
  assert.equal(statuses.body.statuses.failed_but_written_test.status, "formalized");
});

test("formalize rejects missing OpenAI key", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: {}
  });

  const result = await handleFormalize({
    overleafProjectId: "project-1",
    theoremLabel: "missing_key_test",
    theoremText: "A theorem."
  }, state);

  assert.equal(result.statusCode, 400);
  assert.equal(result.body.error, "missing_openai_key");
});

test("failed jobs take precedence over completed project markdown entries", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({ leaRepoPath: leaRepo });
  const proofPath = path.join("workspace", "proofs", "Lea", "Project1", "FailedPrecedence.lean");
  await writeLeaProjectProof(leaRepo, proofPath, "theorem failed_precedence_test : True := by\n  trivial\n");
  await writeLeaProjectMarkdown(leaRepo, "project-1", {
    theoremName: "failed_precedence_test",
    proofPath
  });
  state.jobs.failed_job = {
    jobId: "failed_job",
    jobKey: "project-1:failed_precedence_test",
    status: "failed",
    theoremLabel: "failed_precedence_test",
    relativePath: path.join("workspace", "projects", "project-1.md"),
    absolutePath: path.join(leaRepo, "workspace", "projects", "project-1.md"),
    logPath: path.join(path.dirname(state.jobsPath), "failed-precedence.log"),
    leaRepoPath: leaRepo,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z"
  };
  await fs.writeFile(state.jobs.failed_job.logPath, "failed proof\n", "utf8");

  const statuses = await handleGetStatuses({
    overleafProjectId: "project-1",
    theorems: [{ theoremLabel: "failed_precedence_test", theoremText: "A theorem." }]
  }, state);

  assert.equal(statuses.statusCode, 200);
  assert.equal(statuses.body.statuses.failed_precedence_test.status, "failed");
  assert.equal(statuses.body.statuses.failed_precedence_test.effectiveStatus, "unformalized");
  assert.match(statuses.body.statuses.failed_precedence_test.logTail, /failed proof/);
});

test("formalize fails a Lea job that exceeds the job timeout", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({
    leaRepoPath: leaRepo,
    leaJobTimeoutSeconds: 0.01,
    env: { OPENAI_API_KEY: "test-key" },
    fetchImpl: makeLeaApiFetch([])
  });

  const result = await handleFormalize({
    overleafProjectId: "project-1",
    theoremLabel: "timeout_test",
    theoremText: "A theorem."
  }, state);

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, "in_progress");
  await waitFor(() => state.jobs[result.body.jobId]?.status === "failed");

  const job = state.jobs[result.body.jobId];
  assert.equal(job.timedOut, true);
  assert.equal(job.exitCode, 1);
  assert.match(job.error, /timed out/);

  const statuses = await handleGetStatuses({
    overleafProjectId: "project-1",
    theorems: [{ theoremLabel: "timeout_test", theoremText: "A theorem." }]
  }, state);

  assert.equal(statuses.statusCode, 200);
  assert.equal(statuses.body.statuses.timeout_test.status, "failed");
  assert.match(statuses.body.statuses.timeout_test.logTail, /timed out/);
});

test("formalize logs max-turn completions as failed jobs", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "test-key" },
    fetchImpl: makeLeaApiFetch([], {
      statusBody: {
        run_id: "api-run-1",
        status: "completed",
        result: {
          reason: "max_turns",
          text: "Error: max turns reached without completing the proof."
        }
      }
    })
  });

  const result = await handleFormalize({
    overleafProjectId: "project-1",
    theoremLabel: "max_turn_test",
    theoremText: "A theorem."
  }, state);

  await waitFor(() => state.jobs[result.body.jobId]?.status === "failed");
  const job = state.jobs[result.body.jobId];
  assert.equal(job.exitCode, 1);
  assert.match(job.error, /max turns reached/);
  assert.match(await fs.readFile(job.logPath, "utf8"), /max turns reached/);
});

test("startup recovery fails interrupted in-progress jobs", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({ leaRepoPath: leaRepo });
  const logPath = path.join(path.dirname(state.jobsPath), "interrupted.log");
  state.jobs.interrupted_job = {
    jobId: "interrupted_job",
    jobKey: "project-1:interrupted_status_test",
    status: "in_progress",
    theoremLabel: "interrupted_status_test",
    relativePath: path.join("workspace", "projects", "project-1.md"),
    absolutePath: path.join(leaRepo, "workspace", "projects", "project-1.md"),
    logPath,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null
  };

  await recoverInterruptedJobs(state);

  assert.equal(state.jobs.interrupted_job.status, "failed");
  assert.equal(state.jobs.interrupted_job.finalStatus, "interrupted");
  assert.match(state.jobs.interrupted_job.error, /Companion restarted/);
  assert.ok(state.jobs.interrupted_job.finishedAt);
  assert.match(await fs.readFile(logPath, "utf8"), /Companion restarted/);

  const statuses = await handleGetStatuses({
    overleafProjectId: "project-1",
    theorems: [{ theoremLabel: "interrupted_status_test", theoremText: "A theorem." }]
  }, state);

  assert.equal(statuses.statusCode, 200);
  assert.equal(statuses.body.statuses.interrupted_status_test.status, "failed");
});

async function makeLeaRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lea-prover-"));
  await fs.mkdir(path.join(dir, "lea_api"), { recursive: true });
  await fs.mkdir(path.join(dir, "workspace", "projects"), { recursive: true });
  await fs.mkdir(path.join(dir, "workspace", "proofs"), { recursive: true });
  await fs.writeFile(path.join(dir, "pyproject.toml"), "[project]\nname = \"lea-prover\"\n", "utf8");
  await fs.writeFile(path.join(dir, "workspace", "lean-toolchain"), "leanprover/lean4:stable\n", "utf8");
  await fs.writeFile(path.join(dir, "workspace", "lakefile.lean"), "import Lake\nopen Lake DSL\n", "utf8");
  return dir;
}

async function writeLeaProjectProof(leaRepo, proofPath, content) {
  const absolutePath = path.join(leaRepo, proofPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
}

async function writeLeaProjectMarkdown(leaRepo, projectId, { theoremName, proofPath, moduleName = null }) {
  await writeLeaProjectMarkdownEntries(leaRepo, projectId, [{ theoremName, proofPath, moduleName }]);
}

async function writeLeaProjectMarkdownEntries(leaRepo, projectId, entries) {
  const markdownPath = path.join(leaRepo, "workspace", "projects", `${slugProjectId(projectId)}.md`);
  await fs.mkdir(path.dirname(markdownPath), { recursive: true });
  await fs.writeFile(
    markdownPath,
    [
      `# Project ${projectId}`,
      "",
      `<!-- lea:project id="${slugProjectId(projectId)}" -->`,
      "",
      ...entries.flatMap(({ theoremName, proofPath, moduleName = null }) => {
        const moduleAttr = moduleName ? ` module="${moduleName}"` : "";
        return [
          `## Theorem: ${theoremName}`,
          "",
          `<!-- lea:theorem name="${theoremName}" proof="${proofPath}"${moduleAttr} -->`,
          "",
          "### Signature",
          "",
          "```lean",
          `theorem ${theoremName} : True := by`,
          "```",
          ""
        ];
      }),
      ""
    ].join("\n"),
    "utf8"
  );
}

async function installFakeLake() {
  const oldPath = process.env.PATH || "";
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "fake-lake-bin-"));
  const lakePath = path.join(binDir, "lake");
  await fs.writeFile(lakePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  process.env.PATH = `${binDir}${path.delimiter}${oldPath}`;
  return () => {
    process.env.PATH = oldPath;
  };
}

async function makeState(overrides = {}) {
  const appDir = await fs.mkdtemp(path.join(os.tmpdir(), "overleaf-lean-state-"));
  return {
    settingsPath: path.join(appDir, "settings.json"),
    jobsPath: path.join(appDir, "jobs.json"),
    envPath: path.join(appDir, ".env"),
    settings: {
      ...(overrides.leaRepoPath ? {
        leaRepoPath: overrides.leaRepoPath,
        leaWorkspacePath: buildLeaWorkspacePath(overrides.leaRepoPath),
        leaProvider: overrides.leaProvider || "openai",
        leaModel: overrides.leaModel || "o4-mini",
        leaProviderApiKeys: overrides.leaProviderApiKeys || {},
        ...(overrides.leaApiKey ? { leaApiKey: overrides.leaApiKey } : {}),
        leaMaxTurns: 20,
        ...(overrides.leaJobTimeoutSeconds ? {
          leaJobTimeoutSeconds: overrides.leaJobTimeoutSeconds
        } : {})
      } : {})
    },
    jobs: {},
    env: overrides.env || process.env,
    fetchImpl: overrides.fetchImpl || makeProviderValidationFetch([])
  };
}

function makeUsageJob({ jobId, projectId, inputTokens, outputTokens, costUsd }) {
  return {
    jobId,
    status: "formalized",
    overleafProjectId: projectId,
    projectSlug: slugProjectId(projectId),
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens
    },
    costUsd,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z"
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

function makeLeaApiFetch(calls, options = {}) {
  let statusRequestHandled = false;
  let approvalAccepted = false;
  return async (url, requestOptions = {}) => {
    const body = requestOptions.body ? JSON.parse(requestOptions.body) : null;
    calls.push({ url, options: requestOptions, body });
    if (String(url).endsWith("/v1/runs")) {
      return jsonResponse(200, { run_id: "api-run-1", status: "running" });
    }
    if (String(url).endsWith("/events")) {
      return sseResponse(200, options.eventFrames || []);
    }
    if (String(url).includes("/approvals/")) {
      approvalAccepted = true;
      return jsonResponse(200, { run_id: "api-run-1", approval_id: "ap_1", decision: "accept", status: "running" });
    }
    if (options.approval && !approvalAccepted) {
      return jsonResponse(200, {
        run_id: "api-run-1",
        status: "paused",
        pending_approval: {
          type: "approval_requested",
          approval_id: "ap_1",
          tier: "theorem_translation",
          candidate: 1,
          lean_code: options.approval.leanCode,
          theorem_name: options.approval.theoremName,
          check_result: options.approval.checkResult || "warning: declaration uses 'sorry'"
        }
      });
    }
    if (!statusRequestHandled && options.onStatusRequest) {
      statusRequestHandled = true;
      await options.onStatusRequest();
    }
    return jsonResponse(200, options.statusBody || { run_id: "api-run-1", status: "running" });
  };
}

function makeProviderValidationFetch(calls, statuses = {}) {
  return async (url, requestOptions = {}) => {
    const family = inferProviderValidationFamily(url);
    if (!family) {
      throw new Error(`Unexpected provider validation URL: ${url}`);
    }
    calls.push({ family, url, options: requestOptions });
    const status = statuses[family] || 200;
    if (status === "throw") {
      throw new Error(`${family} unavailable`);
    }
    return jsonResponse(status, { data: [] });
  };
}

function inferProviderValidationFamily(url) {
  const text = String(url);
  if (text.startsWith("https://api.openai.com/")) return "openai";
  if (text.startsWith("https://generativelanguage.googleapis.com/")) return "gemini";
  if (text.startsWith("https://api.anthropic.com/")) return "anthropic";
  return "";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sseResponse(status, frames) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: (async function* () {
      for (const frame of frames) {
        yield new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`);
      }
    })()
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    }
  };
}

async function waitFor(predicate) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 3000) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
