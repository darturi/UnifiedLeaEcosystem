import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LEA_MODEL_OPTIONS,
  buildOverleafDocumentUrl,
  buildSettingsResponse,
  ensureStartupLeaRuntime,
  handleFormalize,
  handleGetStatuses,
  handleGetUsage,
  handleLeanPaneManifest,
  handleMirrorTex,
  handleStub,
  handleUpdateLeaSettings,
  recoverInterruptedJobs,
  resolveProofOutcome,
  validateLeaRepo
} from "../companion/server.mjs";
import {
  buildLeaProjectMarkdownPath,
  buildLeaWorkspacePath,
  slugProjectId
} from "../shared/leanStub.mjs";

test("buildOverleafDocumentUrl builds the canonical public-Overleaf URL", () => {
  assert.equal(
    buildOverleafDocumentUrl("abc123"),
    "https://www.overleaf.com/project/abc123"
  );
  // Empty / unknown ids yield no link (the session shows the badge without a click target).
  assert.equal(buildOverleafDocumentUrl(""), null);
  assert.equal(buildOverleafDocumentUrl("unknown"), null);
  assert.equal(buildOverleafDocumentUrl(null), null);
});

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
    leaMaxSpendUsd: 0.5,
    env: { OPENAI_API_KEY: "env-openai", ANTHROPIC_API_KEY: "env-anthropic" }
  });
  state.jobs.usage = makeUsageJob({
    jobId: "usage",
    projectId: "project-1",
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.125
  });

  const response = await buildSettingsResponse(state);

  assert.deepEqual(response.leaModelOptions, LEA_MODEL_OPTIONS);
  assert.deepEqual(response.leaModelOptions.map((model) => model.value), [
    "o4-mini",
    "gpt-5.4-mini",
    "gpt-5.4",
    "gpt-5.5",
    "gpt-4o",
    "gemini/gemini-3.1-pro-preview",
    "gemini/gemini-2.5-pro",
    "gemini/gemini-2.5-flash",
    "anthropic/claude-opus-4-8",
    "anthropic/claude-sonnet-4-6"
  ]);
  assert.equal(response.leaModelOptions.find((model) => model.value === "o4-mini").family, "openai");
  assert.equal(response.leaModelOptions.find((model) => model.value === "gemini/gemini-2.5-pro").family, "google");
  assert.equal(response.leaProviderKeys.openai.configured, true);
  assert.equal(response.leaProviderKeys.google.configured, false);
  assert.equal(response.leaProviderKeys.anthropic.configured, true);
  assert.equal(response.leaTexMirrorEnabled, true);
  assert.equal(response.leaMaxSpendUsd, 0.5);
  assert.equal(response.leaCurrentSpendUsd, 0.125);
});

test("settings response reloads model selection from env file", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({
    leaRepoPath: leaRepo,
    leaModel: "o4-mini",
    env: { OPENAI_API_KEY: "openai-key", ANTHROPIC_API_KEY: "anthropic-key" }
  });
  await fs.writeFile(
    state.envPath,
    "LEA_MODEL=anthropic/claude-sonnet-4-6\nANTHROPIC_API_KEY=anthropic-key\n",
    "utf8"
  );

  const response = await buildSettingsResponse(state);

  assert.equal(response.leaModel, "anthropic/claude-sonnet-4-6");
  assert.equal(response.leaProvider, "anthropic");
});

test("settings reject unsupported models and missing family keys", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({ leaRepoPath: leaRepo, env: {} });

  const badModel = await handleUpdateLeaSettings({
    leaRepoPath: leaRepo,
    leaApiBaseUrl: "http://127.0.0.1:8001",
    leaModel: "anthropic/claude-does-not-exist",
    leaMaxTurns: 20
  }, state);
  const missingGeminiKey = await handleUpdateLeaSettings({
    leaRepoPath: leaRepo,
    leaApiBaseUrl: "http://127.0.0.1:8001",
    leaModel: "gemini/gemini-2.5-pro",
    leaMaxTurns: 20
  }, state);

  assert.equal(badModel.statusCode, 400);
  assert.equal(badModel.body.error, "invalid_lea_model");
  assert.equal(missingGeminiKey.statusCode, 400);
  assert.equal(missingGeminiKey.body.error, "missing_google_key");
});

test("settings save supported models when their family key is configured", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({ leaRepoPath: leaRepo, env: { OPENAI_API_KEY: "openai-key", GEMINI_API_KEY: "gemini-key", ANTHROPIC_API_KEY: "anthropic-key" } });

  const openAiResult = await handleUpdateLeaSettings({
    leaRepoPath: leaRepo,
    leaApiBaseUrl: "http://127.0.0.1:8001",
    leaModel: "gpt-5.4-mini",
    leaMaxTurns: 34,
    leaMaxSpendUsd: 9.5,
    leaTheoremTranslationMaxRetries: 8
  }, state);
  const geminiResult = await handleUpdateLeaSettings({
    leaRepoPath: leaRepo,
    leaApiBaseUrl: "http://127.0.0.1:8001",
    leaModel: "gemini/gemini-2.5-flash",
    leaMaxTurns: 12
  }, state);
  const anthropicResult = await handleUpdateLeaSettings({
    leaRepoPath: leaRepo,
    leaApiBaseUrl: "http://127.0.0.1:8001",
    leaModel: "anthropic/claude-sonnet-4-6",
    leaMaxTurns: 21
  }, state);

  assert.equal(openAiResult.statusCode, 200);
  assert.equal(openAiResult.body.leaProvider, "openai");
  assert.equal(openAiResult.body.leaModel, "gpt-5.4-mini");
  assert.equal(openAiResult.body.leaMaxTurns, 34);
  assert.equal(openAiResult.body.leaMaxSpendUsd, 9.5);
  assert.equal(openAiResult.body.leaTexMirrorEnabled, true);
  assert.equal(geminiResult.statusCode, 200);
  assert.equal(geminiResult.body.leaProvider, "google");
  assert.equal(geminiResult.body.leaModel, "gemini/gemini-2.5-flash");
  assert.equal(anthropicResult.statusCode, 200);
  assert.equal(anthropicResult.body.leaProvider, "anthropic");
  assert.equal(anthropicResult.body.leaModel, "anthropic/claude-sonnet-4-6");

  const envFile = await fs.readFile(state.envPath, "utf8");
  assert.match(envFile, /LEA_MODEL=anthropic\/claude-sonnet-4-6/);
  assert.match(envFile, /LEA_MAX_TURNS=21/);
  assert.match(envFile, /LEA_MAX_SPEND_USD=9.5/);

  const saved = JSON.parse(await fs.readFile(state.settingsPath, "utf8"));
  assert.equal(Object.prototype.hasOwnProperty.call(saved, "leaModel"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(saved, "leaMaxTurns"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(saved, "leaMaxSpendUsd"), false);
  assert.equal(saved.leaTexMirrorEnabled, true);
});

test("settings persist the tex-mirror toggle off", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({ leaRepoPath: leaRepo, env: { OPENAI_API_KEY: "openai-key" } });

  const result = await handleUpdateLeaSettings({
    leaRepoPath: leaRepo,
    leaApiBaseUrl: "http://127.0.0.1:8001",
    leaModel: "o4-mini",
    leaMaxTurns: 20,
    leaTexMirrorEnabled: false
  }, state);

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.leaTexMirrorEnabled, false);
  const saved = JSON.parse(await fs.readFile(state.settingsPath, "utf8"));
  assert.equal(saved.leaTexMirrorEnabled, false);
});

function makeMirrorFetch(captured) {
  return async (url, options = {}) => {
    if (String(url).includes("/mirror")) {
      captured.push({ url: String(url), body: JSON.parse(options.body || "{}") });
      return { ok: true, status: 200, text: async () => JSON.stringify({ written: 2, changed: true, committed: false }) };
    }
    return { ok: true, status: 200, text: async () => "{}" };
  };
}

test("mirror-tex forwards the project's .tex set to the adapter by slug", async () => {
  const leaRepo = await makeLeaRepo();
  const captured = [];
  const state = await makeState({ leaRepoPath: leaRepo, fetchImpl: makeMirrorFetch(captured) });

  const res = await handleMirrorTex({
    overleafProjectId: "Project-1",
    files: [
      { path: "main.tex", content: "A" },
      { path: "", content: "dropped" },
      { path: "sections/intro.tex", content: "B" }
    ]
  }, state);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(captured.length, 1);
  assert.match(captured[0].url, /\/api\/projects\/by-slug\/Project-1\/mirror$/);
  assert.equal(captured[0].body.source, "overleaf");
  assert.deepEqual(captured[0].body.files.map((file) => file.path), ["main.tex", "sections/intro.tex"]);
});

test("mirror-tex rejects a missing project id and respects the disable toggle", async () => {
  const leaRepo = await makeLeaRepo();

  const missing = await handleMirrorTex({ files: [] }, await makeState({ leaRepoPath: leaRepo }));
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.body.error, "missing_project_id");

  const disabled = await handleMirrorTex(
    { overleafProjectId: "p1", files: [] },
    await makeState({ leaRepoPath: leaRepo, leaTexMirrorEnabled: false })
  );
  assert.equal(disabled.statusCode, 400);
  assert.equal(disabled.body.error, "tex_mirror_disabled");
});

test("lean pane manifest returns missing-stub items without artifacts", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({ leaRepoPath: leaRepo });

  const res = await handleLeanPaneManifest({
    overleafProjectId: "project-1",
    activePath: "main.tex",
    files: [{
      path: "main.tex",
      content: [
        "\\documentclass{article}",
        "\\begin{theorem}\\label{thm:compactness}",
        "% lea: formalize label=compactness_criterion",
        "Every open cover has a finite subcover.",
        "\\end{theorem}"
      ].join("\n")
    }]
  }, state);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].label, "compactness_criterion");
  assert.equal(res.body.items[0].latexLabel, "thm:compactness");
  assert.equal(res.body.items[0].status, "missing-stub");
  assert.equal(res.body.items[0].leanDeclarationName, "compactness_criterion");
});

test("lean pane manifest surfaces sorry stubs and valid artifacts", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({ leaRepoPath: leaRepo });
  await writeLeaProjectProof(
    leaRepo,
    path.join("workspace", "proofs", "Lea", "Project", "compactness.lean"),
    "theorem compactness_criterion : True := by\n  sorry\n"
  );
  await writeLeaProjectProof(
    leaRepo,
    path.join("workspace", "proofs", "Lea", "Project", "locally_finite.lean"),
    "def locally_finite_family : Prop := True\n"
  );
  await writeLeaProjectMarkdownEntries(leaRepo, "project-1", [
    {
      theoremName: "compactness_criterion",
      proofPath: path.join("workspace", "proofs", "Lea", "Project", "compactness.lean")
    },
    {
      theoremName: "locally_finite_family",
      proofPath: path.join("workspace", "proofs", "Lea", "Project", "locally_finite.lean")
    }
  ]);

  const res = await handleLeanPaneManifest({
    overleafProjectId: "project-1",
    activePath: "main.tex",
    files: [{
      path: "main.tex",
      content: [
        "\\documentclass{article}",
        "\\begin{theorem}\\label{thm:compactness}",
        "% lea: formalize label=compactness_criterion",
        "Every open cover has a finite subcover.",
        "\\end{theorem}",
        "\\begin{definition}\\label{def:locally-finite}",
        "% lea: define label=locally_finite_family",
        "A family is locally finite if every point has a neighborhood meeting finitely many members.",
        "\\end{definition}"
      ].join("\n")
    }]
  }, state);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.items.map((item) => item.status), ["stub-generated", "valid"]);
  assert.match(res.body.items[0].leanStub, /theorem compactness_criterion/);
  assert.match(res.body.items[0].leanArtifactContent, /sorry/);
  assert.match(res.body.items[1].leanArtifactContent, /def locally_finite_family/);
  assert.equal(res.body.items[1].leanKind, "def");
});

test("lean pane manifest marks generated artifacts stale when source hash changes", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({ leaRepoPath: leaRepo });
  const proofPath = path.join("workspace", "proofs", "Lea", "Project", "compactness.lean");
  await writeLeaProjectProof(leaRepo, proofPath, "theorem compactness_criterion : True := by\n  trivial\n");
  state.jobs.stale = {
    jobId: "stale",
    jobKey: "project-1:theorem:compactness_criterion",
    status: "formalized",
    targetKind: "theorem",
    targetLabel: "compactness_criterion",
    declarationName: "compactness_criterion",
    recordedProofPath: proofPath,
    targetTextHash: "old-source-hash",
    leaRepoPath: leaRepo,
    leaUiBaseUrl: "http://localhost:5173",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z"
  };

  const res = await handleLeanPaneManifest({
    overleafProjectId: "project-1",
    files: [{
      path: "main.tex",
      content: [
        "\\begin{theorem}\\label{thm:compactness}",
        "% lea: formalize label=compactness_criterion",
        "The source has changed.",
        "\\end{theorem}"
      ].join("\n")
    }]
  }, state);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.items[0].status, "stale");
  assert.equal(res.body.items[0].generatedFromSourceHash, "old-source-hash");
});

test("lean pane manifest degrades when Lea lookup is unavailable", async () => {
  const state = await makeState();

  const res = await handleLeanPaneManifest({
    overleafProjectId: "project-1",
    files: [{
      path: "main.tex",
      content: [
        "\\begin{theorem}\\label{thm:main}",
        "% lea: formalize label=main_theorem",
        "A.",
        "\\end{theorem}"
      ].join("\n")
    }]
  }, state);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.items[0].status, "unknown");
  assert.equal(res.body.diagnostics.at(-1).code, "lea_unconfigured");
});

test("settings clear max spend and reject negative caps", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({
    leaRepoPath: leaRepo,
    leaMaxSpendUsd: 4,
    env: { OPENAI_API_KEY: "openai-key" }
  });

  const cleared = await handleUpdateLeaSettings({
    leaRepoPath: leaRepo,
    leaApiBaseUrl: "http://127.0.0.1:8001",
    leaModel: "o4-mini",
    leaMaxTurns: 20,
    leaMaxSpendUsd: null
  }, state);
  const negative = await handleUpdateLeaSettings({
    leaRepoPath: leaRepo,
    leaApiBaseUrl: "http://127.0.0.1:8001",
    leaModel: "o4-mini",
    leaMaxTurns: 20,
    leaMaxSpendUsd: -1
  }, state);

  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.body.leaMaxSpendUsd, null);
  assert.equal(negative.statusCode, 400);
  assert.equal(negative.body.error, "invalid_max_spend");
});

test("settings normalize legacy Anthropic model ids", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({
    leaRepoPath: leaRepo,
    leaModel: "anthropic/claude-sonnet-4-20250514",
    env: { ANTHROPIC_API_KEY: "anthropic-key" }
  });

  assert.equal((await buildSettingsResponse(state)).leaModel, "anthropic/claude-sonnet-4-6");

  const result = await handleUpdateLeaSettings({
    leaRepoPath: leaRepo,
    leaApiBaseUrl: "http://127.0.0.1:8001",
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
  assert.equal(Object.prototype.hasOwnProperty.call(saved, "leaModel"), false);
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
    leaApiBaseUrl: "http://127.0.0.1:8001",
    leaModel: "anthropic/claude-sonnet-4-6",
    leaMaxTurns: 20,
    leaProviderApiKeys: { anthropic: "anthropic-key" }
  }, state);

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.leaProviderKeys.anthropic.configured, true);
  assert.equal(state.env.ANTHROPIC_API_KEY, "anthropic-key");

  const envFile = await fs.readFile(state.envPath, "utf8");
  assert.match(envFile, /ANTHROPIC_API_KEY=anthropic-key/);
  assert.match(envFile, /LEA_MODEL=anthropic\/claude-sonnet-4-6/);
  assert.match(envFile, /LEA_MAX_TURNS=20/);

  const saved = JSON.parse(await fs.readFile(state.settingsPath, "utf8"));
  assert.equal(Object.prototype.hasOwnProperty.call(saved, "leaApiKey"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(saved, "leaProviderApiKeys"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(saved, "leaModel"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(saved, "leaMaxTurns"), false);
});

test("adapter settings read overlays shared values and key status", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const adapter = makeAdapterStore({
    model: "anthropic/claude-sonnet-4-6",
    max_turns: 55,
    max_spend_usd: 7.5,
    api_keys: { ANTHROPIC_API_KEY: keyStatus("dcba") }
  });
  const state = await makeState({
    leaRepoPath: leaRepo,
    leaModel: "o4-mini",
    env: { OPENAI_API_KEY: "env-openai" },
    fetchImpl: makeAdapterFetch(adapter, calls)
  });

  const response = await buildSettingsResponse(state);

  // The adapter (single source of truth) wins for the shared scalars...
  assert.equal(response.leaModel, "anthropic/claude-sonnet-4-6");
  assert.equal(response.leaMaxTurns, 55);
  assert.equal(response.leaMaxSpendUsd, 7.5);
  // ...and a key configured only in the adapter (lea-standalone UI) reads as configured.
  assert.equal(response.leaProviderKeys.anthropic.configured, true);
  // while a key in the companion env is still recognized.
  assert.equal(response.leaProviderKeys.openai.configured, true);
  assert.ok(calls.some((call) => call.method === "GET" && call.url.endsWith("/api/settings")));
});

test("saving settings forwards shared fields to the adapter", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const adapter = makeAdapterStore({ api_keys: { OPENAI_API_KEY: keyStatus("akey") } });
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "env-openai" },
    fetchImpl: makeAdapterFetch(adapter, calls)
  });

  const result = await handleUpdateLeaSettings({
    leaRepoPath: leaRepo,
    leaApiBaseUrl: "http://127.0.0.1:8001",
    leaModel: "gpt-5.4-mini",
    leaMaxTurns: 42,
    leaMaxSpendUsd: 3.5
  }, state);

  assert.equal(result.statusCode, 200);
  const put = calls.find((call) => call.method === "PUT");
  assert.ok(put, "expected a PUT to /api/settings");
  assert.equal(put.body.model, "gpt-5.4-mini");
  assert.equal(put.body.max_turns, 42);
  assert.equal(put.body.max_spend_usd, 3.5);
  // the selected model's key is forwarded so the adapter holds what the model needs
  assert.equal(put.body.api_keys.OPENAI_API_KEY.value, "env-openai");
  // and the adapter store actually moved
  assert.equal(adapter.settings.model, "gpt-5.4-mini");
  assert.equal(adapter.settings.max_turns, 42);
});

test("adapter validation rejection surfaces as a 422", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const adapter = makeAdapterStore({
    api_keys: { ANTHROPIC_API_KEY: keyStatus("good") },
    reject: { field: "api_keys.ANTHROPIC_API_KEY", message: "The Anthropic API key was rejected by the provider." }
  });
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: {},
    fetchImpl: makeAdapterFetch(adapter, calls)
  });

  const result = await handleUpdateLeaSettings({
    leaRepoPath: leaRepo,
    leaApiBaseUrl: "http://127.0.0.1:8001",
    leaModel: "anthropic/claude-sonnet-4-6",
    leaMaxTurns: 20
  }, state);

  assert.equal(result.statusCode, 422);
  assert.equal(result.body.error, "adapter_settings_rejected");
  assert.equal(result.body.field, "api_keys.ANTHROPIC_API_KEY");
  assert.match(result.body.message, /rejected by the provider/);
});

test("settings reject invalid submitted Gemini keys before persistence", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "openai-key" },
    fetchImpl: makeProviderValidationFetch(calls, { google: 401 })
  });

  const result = await handleUpdateLeaSettings({
    leaRepoPath: leaRepo,
    leaApiBaseUrl: "http://127.0.0.1:8001",
    leaModel: "gemini/gemini-2.5-pro",
    leaMaxTurns: 20,
    leaProviderApiKeys: { gemini: "PLACEHOLDER" }
  }, state);

  assert.equal(result.statusCode, 400);
  assert.equal(result.body.error, "invalid_google_key");
  assert.match(result.body.message, /Google AI API key was rejected/);
  assert.equal(state.env.GEMINI_API_KEY, undefined);
  assert.equal(await fileExists(state.envPath), false);
  assert.deepEqual(calls.map((call) => call.family), ["google"]);
});

test("settings reject invalid existing key for selected provider family", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: { GEMINI_API_KEY: "bad-gemini-key" },
    fetchImpl: makeProviderValidationFetch(calls, { google: 403 })
  });

  const result = await handleUpdateLeaSettings({
    leaRepoPath: leaRepo,
    leaApiBaseUrl: "http://127.0.0.1:8001",
    leaModel: "gemini/gemini-2.5-flash",
    leaMaxTurns: 20
  }, state);

  assert.equal(result.statusCode, 400);
  assert.equal(result.body.error, "invalid_google_key");
  assert.equal(state.settings.leaModel, "o4-mini");
  assert.deepEqual(calls.map((call) => call.family), ["google"]);
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
    leaApiBaseUrl: "http://127.0.0.1:8001",
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
    leaApiBaseUrl: "http://127.0.0.1:8001",
    leaModel: "gemini/gemini-2.5-flash",
    leaMaxTurns: 20,
    leaProviderApiKeys: { gemini: "valid-gemini-key" }
  }, state);

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.leaProviderKeys.google.configured, true);
  assert.equal(state.env.GEMINI_API_KEY, "valid-gemini-key");
  assert.deepEqual(calls.map((call) => call.family), ["google"]);

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
    leaApiBaseUrl: "http://127.0.0.1:8001",
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
    leaApiBaseUrl: "http://127.0.0.1:8001",
    leaModel: "gpt-5.4",
    leaMaxTurns: 20
  }, state);

  assert.equal(result.statusCode, 200);
  assert.deepEqual(calls.map((call) => call.family), ["openai"]);
});

test("completed formalization status keeps Lea UI session link", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "test-key" }
  });
  const proofPath = path.join("workspace", "proofs", "Lea", "Project1", "linked_done_test.lean");
  await writeLeaProjectProof(leaRepo, proofPath, "theorem linked_done_test : True := by\n  trivial\n");
  await writeLeaProjectMarkdown(leaRepo, "project-1", {
    theoremName: "linked_done_test",
    proofPath,
    moduleName: "Lea.Project1.linked_done_test"
  });
  state.jobs.completed_link = {
    jobId: "completed_link",
    jobKey: "project-1:theorem:linked_done_test",
    status: "success",
    overleafProjectId: "project-1",
    projectId: "project-1",
    projectSlug: "project-1",
    targetLabel: "linked_done_test",
    declarationName: "linked_done_test",
    recorderSessionId: "sess-done",
    recorderRunId: "run-done",
    leaUiBaseUrl: "http://localhost:5173",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z"
  };

  const statuses = await handleGetStatuses({
    overleafProjectId: "project-1",
    targets: [{ targetKind: "theorem", targetLabel: "linked_done_test", targetText: "A theorem." }]
  }, state);

  assert.equal(statuses.statusCode, 200);
  assert.equal(statuses.body.statuses["theorem:linked_done_test"].status, "formalized");
  assert.equal(statuses.body.statuses["theorem:linked_done_test"].leaSessionId, "sess-done");
  assert.equal(statuses.body.statuses["theorem:linked_done_test"].leaSessionUrl, "http://localhost:5173/?session=sess-done");
});

test("in-progress status links Lea UI session from leaSessionId (no recorder)", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "test-key" }
  });
  state.jobs.active_link = {
    jobId: "active_link",
    jobKey: "project-1:theorem:in_progress_test",
    status: "in_progress",
    overleafProjectId: "project-1",
    projectId: "project-1",
    projectSlug: "project-1",
    targetLabel: "in_progress_test",
    declarationName: "in_progress_test",
    // Adapter session id from run start; recorder CLI never ran.
    leaSessionId: "sess-running",
    recorderSessionId: null,
    leaUiBaseUrl: "http://localhost:5173",
    startedAt: "2026-01-01T00:00:00.000Z"
  };

  const statuses = await handleGetStatuses({
    overleafProjectId: "project-1",
    targets: [{ targetKind: "theorem", targetLabel: "in_progress_test", targetText: "A theorem." }]
  }, state);

  assert.equal(statuses.statusCode, 200);
  assert.equal(statuses.body.statuses["theorem:in_progress_test"].status, "in_progress");
  assert.equal(statuses.body.statuses["theorem:in_progress_test"].leaSessionId, "sess-running");
  assert.equal(statuses.body.statuses["theorem:in_progress_test"].leaSessionUrl, "http://localhost:5173/?session=sess-running");
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
    targets: [{ targetKind: "theorem", targetLabel: "saved_stub_test", targetText: "A theorem." }]
  }, state);

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.statuses["theorem:saved_stub_test"].status, "sorry_stub");
  assert.equal(result.body.statuses["theorem:saved_stub_test"].leanStatement, "theorem saved_stub_test : True");
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
    targetKind: "theorem",
    targetLabel: "active_status_test",
    targetText: "A theorem."
  }, state);

  const statuses = await handleGetStatuses({
    overleafProjectId: "project-1",
    targets: [{ targetKind: "theorem", targetLabel: "active_status_test", targetText: "A theorem." }]
  }, state);

  assert.equal(statuses.statusCode, 200);
  assert.equal(statuses.body.statuses["theorem:active_status_test"].status, "in_progress");
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
    targetKind: "theorem",
    targetLabel: "active_progress_test",
    targetText: "A theorem."
  }, state);

  await waitFor(() => state.jobs[result.body.jobId]?.leaCurrentTurn === 6);
  const statuses = await handleGetStatuses({
    overleafProjectId: "project-1",
    targets: [{ targetKind: "theorem", targetLabel: "active_progress_test", targetText: "A theorem." }]
  }, state);

  assert.equal(statuses.statusCode, 200);
  assert.equal(state.jobs[result.body.jobId].leaCurrentTurn, 6);
  assert.equal(state.jobs[result.body.jobId].leaMaxTurns, 20);
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
    targetKind: "theorem",
    targetLabel: "unknown_turn_test",
    targetText: "A theorem."
  }, state);

  await waitFor(() => state.jobs[result.body.jobId]?.status === "in_progress");
  const statuses = await handleGetStatuses({
    overleafProjectId: "project-1",
    targets: [{ targetKind: "theorem", targetLabel: "unknown_turn_test", targetText: "A theorem." }]
  }, state);

  assert.equal(statuses.statusCode, 200);
  assert.equal(statuses.body.statuses["theorem:unknown_turn_test"].status, "in_progress");
  assert.equal(statuses.body.statuses["theorem:unknown_turn_test"].turnProgress, undefined);
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
    targets: [{ targetKind: "theorem", targetLabel: "project_markdown_test", targetText: "A theorem." }]
  }, state);
  const status = configured.body.statuses["theorem:project_markdown_test"];
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
      targetKind: "theorem",
    targetLabel: "epsilon_one",
      targetText: [
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
    assert.equal(job.targetLabel, "epsilon_one");
    assert.equal(job.declarationName, "even_square_of_even");
    assert.equal(job.recordedProofPath, proofPath);
    assert.equal(job.moduleName, "Lea.Project1.even_square_of_even");

    const statuses = await handleGetStatuses({
      overleafProjectId: "project-1",
      targets: [{ targetKind: "theorem", targetLabel: "epsilon_one", targetText: "A theorem." }]
    }, state);

    const status = statuses.body.statuses["theorem:epsilon_one"];
    assert.equal(statuses.statusCode, 200);
    assert.equal(status.status, "formalized");
    assert.equal(status.targetLabel, "epsilon_one");
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
      jobKey: "project-1:theorem:epsilon_one",
      status: "formalized",
      declarationName: "even_square_of_even",
      recordedProofPath: dependencyProofPath,
      moduleName: "Lea.Project1.even_square_of_even",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z"
    };

    const result = await handleFormalize({
      overleafProjectId: "project-1",
      targetKind: "theorem",
    targetLabel: "epsilon_two",
      targetText: [
        "Theorem name: even_square_of_double_plus_double",
        "Lean signature:",
        "theorem even_square_of_double_plus_double : True := by"
      ].join("\n"),
      targetUses: ["epsilon_one"]
    }, state);

    await waitFor(() => state.jobs[result.body.jobId]?.status === "formalized");
    assert.equal(result.statusCode, 200);
    assert.match(
      calls[0].body.task,
      new RegExp(`To formalize the theorem make use of the even_square_of_even theorem at ${escapeRegExp(path.join(leaRepo, dependencyProofPath))}\\.`)
    );
    assert.deepEqual(state.jobs[result.body.jobId].targetUses, [{ targetKind: "theorem", targetLabel: "epsilon_one",
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
      jobKey: "project-1:theorem:first_label",
      status: "formalized",
      declarationName: "first_support",
      recordedProofPath: firstProofPath,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z"
    };
    state.jobs["second-support-job"] = {
      jobId: "second-support-job",
      jobKey: "project-1:theorem:second_label",
      status: "formalized",
      declarationName: "second_support",
      recordedProofPath: secondProofPath,
      startedAt: "2026-01-01T00:00:02.000Z",
      finishedAt: "2026-01-01T00:00:03.000Z"
    };

    const result = await handleFormalize({
      overleafProjectId: "project-1",
      targetKind: "theorem",
    targetLabel: "multi_use_target",
      targetText: "theorem multi_use_target : True := by",
      targetUses: ["first_label", "second_label"],
      targetContext: "Reuse the support lemmas in the listed order."
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
      targetKind: "theorem",
    targetLabel: "uses_stub_support",
      targetText: "theorem uses_stub_support : True := by",
      targetUses: ["stub_support"]
    }, state);

    assert.equal(result.statusCode, 200);
    await waitFor(() => state.jobs[result.body.jobId]?.status === "formalized");
    assert.match(
      calls[0].body.task,
      new RegExp(`To formalize the theorem make use of the stub_support theorem at ${escapeRegExp(path.join(leaRepo, dependencyProofPath))}\\.`)
    );
    assert.deepEqual(state.jobs[result.body.jobId].targetUses, [{ targetKind: "theorem", targetLabel: "stub_support",
      declarationName: "stub_support",
      relativePath: dependencyProofPath,
      absolutePath: path.join(leaRepo, dependencyProofPath),
      moduleName: "Lea.Project1.stub_support",
      status: "sorry_stub"
    }]);
    assert.deepEqual(state.jobs[result.body.jobId].stubbedTheoremUses, [{ targetKind: "theorem", targetLabel: "stub_support",
      declarationName: "stub_support",
      moduleName: "Lea.Project1.stub_support",
      relativePath: dependencyProofPath,
      absolutePath: path.join(leaRepo, dependencyProofPath)
    }]);
    const statuses = await handleGetStatuses({
      overleafProjectId: "project-1",
      targets: [{ targetKind: "theorem", targetLabel: "uses_stub_support", targetText: "A theorem." }]
    }, state);
    assert.equal(statuses.body.statuses["theorem:uses_stub_support"].status, "formalized");
    assert.deepEqual(statuses.body.statuses["theorem:uses_stub_support"].stubbedTheoremUses, [{ targetKind: "theorem", targetLabel: "stub_support",
      declarationName: "stub_support",
      moduleName: "Lea.Project1.stub_support",
      relativePath: dependencyProofPath,
      absolutePath: path.join(leaRepo, dependencyProofPath)
    }]);
    assert.equal(statuses.body.statuses["theorem:uses_stub_support"].hasStubbedTheoremUses, true);

    await writeLeaProjectProof(leaRepo, dependencyProofPath, "theorem stub_support : True := by\n  trivial\n");
    const refreshedStatuses = await handleGetStatuses({
      overleafProjectId: "project-1",
      targets: [{ targetKind: "theorem", targetLabel: "uses_stub_support", targetText: "A theorem." }]
    }, state);
    assert.equal(refreshedStatuses.body.statuses["theorem:uses_stub_support"].status, "formalized");
    assert.equal(refreshedStatuses.body.statuses["theorem:uses_stub_support"].stubbedTheoremUses, undefined);
    assert.equal(refreshedStatuses.body.statuses["theorem:uses_stub_support"].hasStubbedTheoremUses, undefined);
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
      targetKind: "theorem",
    targetLabel: "does_not_import_stub_support",
      targetText: "theorem does_not_import_stub_support : True := by",
      targetUses: ["unused_stub_support"]
    }, state);

    assert.equal(result.statusCode, 200);
    await waitFor(() => state.jobs[result.body.jobId]?.status === "formalized");
    assert.deepEqual(state.jobs[result.body.jobId].stubbedTheoremUses, []);
    const statuses = await handleGetStatuses({
      overleafProjectId: "project-1",
      targets: [{ targetKind: "theorem", targetLabel: "does_not_import_stub_support", targetText: "A theorem." }]
    }, state);
    assert.equal(statuses.body.statuses["theorem:does_not_import_stub_support"].status, "formalized");
    assert.equal(statuses.body.statuses["theorem:does_not_import_stub_support"].stubbedTheoremUses, undefined);
    assert.equal(statuses.body.statuses["theorem:does_not_import_stub_support"].hasStubbedTheoremUses, undefined);
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
      targetKind: "theorem",
    targetLabel: "imports_formalized_support",
      targetText: "theorem imports_formalized_support : True := by",
      targetUses: ["formalized_support"]
    }, state);

    assert.equal(result.statusCode, 200);
    await waitFor(() => state.jobs[result.body.jobId]?.status === "formalized");
    assert.deepEqual(state.jobs[result.body.jobId].stubbedTheoremUses, []);
    assert.deepEqual(state.jobs[result.body.jobId].targetUses, [{ targetKind: "theorem", targetLabel: "formalized_support",
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
      jobKey: "project-1:theorem:failed_stub_support",
      status: "failed",
      finalStatus: "sorry_stub",
      targetLabel: "failed_stub_support",
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
      targets: [{ targetKind: "theorem", targetLabel: "failed_stub_support", targetText: "A theorem." }]
    }, state);

    assert.equal(statuses.statusCode, 200);
    assert.equal(statuses.body.statuses["theorem:failed_stub_support"].status, "failed");
    assert.equal(statuses.body.statuses["theorem:failed_stub_support"].effectiveStatus, "sorry_stub");
    assert.equal(statuses.body.statuses["theorem:failed_stub_support"].leanStatement, "theorem failed_stub_support : True");

    const result = await handleFormalize({
      overleafProjectId: "project-1",
      targetKind: "theorem",
    targetLabel: "uses_failed_stub_support",
      targetText: "theorem uses_failed_stub_support : True := by",
      targetUses: ["failed_stub_support"]
    }, state);

    assert.equal(result.statusCode, 200);
    await waitFor(() => state.jobs[result.body.jobId]?.status === "formalized");
    assert.match(
      calls[0].body.task,
      new RegExp(`To formalize the theorem make use of the failed_stub_support theorem at ${escapeRegExp(path.join(leaRepo, dependencyProofPath))}\\.`)
    );
    assert.deepEqual(state.jobs[result.body.jobId].targetUses, [{ targetKind: "theorem", targetLabel: "failed_stub_support",
      declarationName: "failed_stub_support",
      relativePath: dependencyProofPath,
      absolutePath: path.join(leaRepo, dependencyProofPath),
      moduleName: "Lea.Project1.failed_stub_support",
      status: "sorry_stub"
    }]);
    assert.deepEqual(state.jobs[result.body.jobId].stubbedTheoremUses, [{ targetKind: "theorem", targetLabel: "failed_stub_support",
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
    targetKind: "theorem",
    targetLabel: "needs_support",
    targetText: "A theorem.",
    targetUses: ["missing_support"]
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
    targetKind: "theorem",
    targetLabel: "needs_support",
    targetText: "A theorem.",
    targetUses: ["invalid-label"]
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
      targetKind: "theorem",
    targetLabel: "label_named_result",
      targetText: "A theorem without a Lean name."
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
      targetKind: "theorem",
    targetLabel: "usage_capture_test",
      targetText: "A theorem."
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

test("formalize definition uses a declaration-oriented prompt and typed job key", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const proofPath = path.join("workspace", "proofs", "Lea", "Project1", "Subadditive.lean");
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
            "def Subadditive (a : Nat -> Int) : Prop := True\n"
          );
          await writeLeaProjectMarkdown(leaRepo, "project-1", {
            theoremName: "Subadditive",
            proofPath,
            moduleName: "Lea.Project1.Subadditive"
          });
        }
      })
    });

    const result = await handleFormalize({
      overleafProjectId: "project-1",
      targetKind: "definition",
      targetLabel: "Subadditive",
      targetText: "A sequence is subadditive when a_{m+n} <= a_m + a_n.",
      targetContext: "Represent this as a predicate on functions Nat -> Int."
    }, state);

    await waitFor(() => state.jobs[result.body.jobId]?.status === "formalized");
    const job = state.jobs[result.body.jobId];
    assert.equal(result.statusCode, 200);
    assert.equal(job.jobKey, "project-1:definition:Subadditive");
    assert.equal(job.targetKind, "definition");
    assert.equal(job.targetLabel, "Subadditive");
    assert.equal(job.resultKind, "defined");
    assert.match(calls[0].body.task, /This target is a definition, not a theorem/);
    assert.match(calls[0].body.task, /Do not create a fake theorem/);
    assert.match(calls[0].body.task, /Represent this as a predicate/);

    const statuses = await handleGetStatuses({
      overleafProjectId: "project-1",
      targets: [{ targetKind: "definition", targetLabel: "Subadditive", targetText: "A definition." }]
    }, state);
    assert.equal(statuses.body.statuses["definition:Subadditive"].status, "formalized");
    assert.equal(statuses.body.statuses["definition:Subadditive"].resultKind, "defined");
  } finally {
    restorePath();
  }
});

test("same-label theorem and definition targets do not collide", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({ leaRepoPath: leaRepo });
  state.jobs.same_theorem = {
    jobId: "same_theorem",
    jobKey: "project-1:theorem:SameName",
    status: "in_progress",
    mode: "formalization",
    targetKind: "theorem",
    targetLabel: "SameName",
    overleafProjectId: "project-1",
    projectId: "project-1",
    projectSlug: "project-1",
    declarationName: "SameName",
    projectMarkdownPath: buildLeaProjectMarkdownPath({ leaRepoPath: leaRepo, overleafProjectId: "project-1" }),
    leaRepoPath: leaRepo,
    leaUiBaseUrl: "http://localhost:5173",
    startedAt: "2026-01-01T00:00:00.000Z"
  };
  state.jobs.same_definition = {
    ...state.jobs.same_theorem,
    jobId: "same_definition",
    jobKey: "project-1:definition:SameName",
    targetKind: "definition",
    status: "failed",
    finalStatus: "unformalized",
    error: "definition failed",
    startedAt: "2026-01-01T00:00:01.000Z"
  };

  const statuses = await handleGetStatuses({
    overleafProjectId: "project-1",
    targets: [
      { targetKind: "theorem", targetLabel: "SameName", targetText: "A theorem." },
      { targetKind: "definition", targetLabel: "SameName", targetText: "A definition." }
    ]
  }, state);

  assert.equal(statuses.body.statuses["theorem:SameName"].status, "in_progress");
  assert.equal(statuses.body.statuses["definition:SameName"].status, "failed");
  assert.equal(statuses.body.statuses["definition:SameName"].message, "definition failed");
});

test("usage falls back to in-memory job totals when the adapter is unavailable", async () => {
  const leaRepo = await makeLeaRepo();
  // With the adapter unavailable, handleGetUsage uses the in-memory job tally
  // fallback rather than GET /api/stats.
  const state = await makeState({ leaRepoPath: leaRepo, leaMaxSpendUsd: 1 });
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

  const result = await handleGetUsage({ overleafProjectId: "project-a" }, state);

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
  assert.equal(result.body.leaMaxSpendUsd, 1);
  assert.equal(result.body.leaCurrentSpendUsd, 0.48);
  assert.equal(result.body.leaSpendLimitReached, false);
});

test("usage sourced from the adapter matches /api/stats (all-time + this project)", async () => {
  const leaRepo = await makeLeaRepo();
  const projectSlug = slugProjectId("doc-a");
  const stats = {
    global: {
      input_tokens: 1000,
      output_tokens: 250,
      total_tokens: 1250,
      cost_usd: 0.7,
      session_count: 4
    },
    sessions: [
      // Two sessions for this Overleaf doc → summed into "This project".
      { project_slug: projectSlug, input_tokens: 200, output_tokens: 50, cost_usd: 0.10, run_count: 1 },
      { project_slug: projectSlug, input_tokens: 300, output_tokens: 75, cost_usd: 0.20, run_count: 2 },
      // A different doc and an untagged session → excluded from "This project".
      { project_slug: slugProjectId("doc-b"), input_tokens: 400, output_tokens: 100, cost_usd: 0.30, run_count: 1 },
      { project_slug: null, input_tokens: 100, output_tokens: 25, cost_usd: 0.10, run_count: 1 }
    ]
  };
  const state = await makeState({
    leaRepoPath: leaRepo,
    leaApiBaseUrl: "http://127.0.0.1:8001",
    leaMaxSpendUsd: 1,
    fetchImpl: makeStatsFetch(stats)
  });
  // An in-memory job exists but must be ignored once the adapter is the source.
  state.jobs.stale = makeUsageJob({
    jobId: "stale", projectId: "doc-a", inputTokens: 9, outputTokens: 9, costUsd: 9
  });

  const result = await handleGetUsage({ overleafProjectId: "doc-a" }, state);

  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body.project, {
    inputTokens: 500,
    outputTokens: 125,
    totalTokens: 625,
    costUsd: 0.3,
    runCount: 3
  });
  assert.deepEqual(result.body.allTime, {
    inputTokens: 1000,
    outputTokens: 250,
    totalTokens: 1250,
    costUsd: 0.7,
    runCount: 4
  });
  assert.equal(result.body.leaCurrentSpendUsd, 0.7);
  assert.equal(result.body.leaSpendLimitReached, false);
});

test("usage from the adapter flags the spend cap from all-time cost", async () => {
  const leaRepo = await makeLeaRepo();
  const stats = {
    global: { input_tokens: 10, output_tokens: 5, total_tokens: 15, cost_usd: 0.5, session_count: 1 },
    sessions: []
  };
  const state = await makeState({
    leaRepoPath: leaRepo,
    leaApiBaseUrl: "http://127.0.0.1:8001",
    leaMaxSpendUsd: 0.5,
    fetchImpl: makeStatsFetch(stats)
  });

  const result = await handleGetUsage({ overleafProjectId: "doc-a" }, state);

  assert.equal(result.body.leaCurrentSpendUsd, 0.5);
  assert.equal(result.body.leaSpendLimitReached, true);
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
      jobKey: "project-1:theorem:retry_label",
      status: "failed",
      targetLabel: "retry_label",
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
      targetKind: "theorem",
    targetLabel: "retry_label",
      targetText: [
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
      targetKind: "theorem",
    targetLabel: "ambiguous_result",
      targetText: "A theorem without a Lean name."
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
    targets: [{ targetKind: "theorem", targetLabel: "missing_entry_test", targetText: "A theorem." }]
  }, state);

  const status = result.body.statuses["theorem:missing_entry_test"];
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
    targets: [{ targetKind: "theorem", targetLabel: "missing_proof_test", targetText: "A theorem." }]
  }, state);

  const status = result.body.statuses["theorem:missing_proof_test"];
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
    targets: [{ targetKind: "theorem", targetLabel: "project_sorry_test", targetText: "A theorem." }]
  }, state);

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.statuses["theorem:project_sorry_test"].status, "sorry_stub");
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
    targets: [{ targetKind: "theorem", targetLabel: "direct_proof_test", targetText: "A theorem." }]
  }, state);

  const status = result.body.statuses["theorem:direct_proof_test"];
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
    jobKey: "project-1:theorem:failed_but_written_test",
    status: "failed",
    targetLabel: "failed_but_written_test",
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
    targets: [{ targetKind: "theorem", targetLabel: "failed_but_written_test", targetText: "A theorem." }]
  }, state);

  assert.equal(statuses.statusCode, 200);
  assert.equal(statuses.body.statuses["theorem:failed_but_written_test"].status, "formalized");
});

test("formalize rejects missing OpenAI key", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: {}
  });

  const result = await handleFormalize({
    overleafProjectId: "project-1",
    targetKind: "theorem",
    targetLabel: "missing_key_test",
    targetText: "A theorem."
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
    jobKey: "project-1:theorem:failed_precedence_test",
    status: "failed",
    targetLabel: "failed_precedence_test",
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
    targets: [{ targetKind: "theorem", targetLabel: "failed_precedence_test", targetText: "A theorem." }]
  }, state);

  assert.equal(statuses.statusCode, 200);
  assert.equal(statuses.body.statuses["theorem:failed_precedence_test"].status, "failed");
  assert.equal(statuses.body.statuses["theorem:failed_precedence_test"].effectiveStatus, "unformalized");
  assert.match(statuses.body.statuses["theorem:failed_precedence_test"].logTail, /failed proof/);
});

test("formalize fails a Lea job that exceeds the job timeout", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({
    leaRepoPath: leaRepo,
    leaJobTimeoutSeconds: 0.01,
    env: { OPENAI_API_KEY: "test-key" },
    fetchImpl: makeLeaApiFetch([], { neverDone: true })
  });

  const result = await handleFormalize({
    overleafProjectId: "project-1",
    targetKind: "theorem",
    targetLabel: "timeout_test",
    targetText: "A theorem."
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
    targets: [{ targetKind: "theorem", targetLabel: "timeout_test", targetText: "A theorem." }]
  }, state);

  assert.equal(statuses.statusCode, 200);
  assert.equal(statuses.body.statuses["theorem:timeout_test"].status, "failed");
  assert.match(statuses.body.statuses["theorem:timeout_test"].logTail, /timed out/);
});

test("startup recovery fails interrupted in-progress jobs", async () => {
  const leaRepo = await makeLeaRepo();
  const state = await makeState({ leaRepoPath: leaRepo });
  const logPath = path.join(path.dirname(state.jobsPath), "interrupted.log");
  state.jobs.interrupted_job = {
    jobId: "interrupted_job",
    jobKey: "project-1:theorem:interrupted_status_test",
    status: "in_progress",
    targetLabel: "interrupted_status_test",
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
    targets: [{ targetKind: "theorem", targetLabel: "interrupted_status_test", targetText: "A theorem." }]
  }, state);

  assert.equal(statuses.statusCode, 200);
  assert.equal(statuses.body.statuses["theorem:interrupted_status_test"].status, "failed");
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
        leaApiBaseUrl: overrides.leaApiBaseUrl || "http://127.0.0.1:8001",
        leaProvider: overrides.leaProvider || "openai",
        leaModel: overrides.leaModel || "o4-mini",
        leaProviderApiKeys: overrides.leaProviderApiKeys || {},
        ...(overrides.leaApiKey ? { leaApiKey: overrides.leaApiKey } : {}),
        leaMaxTurns: 20,
        leaMaxSpendUsd: overrides.leaMaxSpendUsd ?? null,
        leaTexMirrorEnabled: overrides.leaTexMirrorEnabled ?? true,
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
  let eventHookHandled = false;
  return async (url, requestOptions = {}) => {
    if (String(url).endsWith("/api/settings")) {
      return jsonResponse(404, { detail: "not found" });
    }
    const body = requestOptions.body ? JSON.parse(requestOptions.body) : null;
    const recordedBody = body?.message ? { ...body, task: body.message } : body;
    calls.push({ url, options: requestOptions, body: recordedBody });
    if (String(url).endsWith("/api/runs") && requestOptions.method === "POST") {
      return jsonResponse(200, { run_id: "api-run-1", session_id: "sess-api-1", status: "running" });
    }
    if (String(url).includes("/api/runs/") && String(url).endsWith("/events")) {
      if (!eventHookHandled && options.onStatusRequest) {
        eventHookHandled = true;
        await options.onStatusRequest();
      }
      if (options.neverDone) {
        return {
          ok: true,
          status: 200,
          body: (async function* () {
            await new Promise((_, reject) => {
              requestOptions.signal?.addEventListener("abort", () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              }, { once: true });
            });
          })()
        };
      }
      const frames = options.eventFrames
        ? options.eventFrames.map((event) => ({
            type: event.type === "usage_updated" ? "status" : event.type,
            data: event
          }))
        : [
            { type: "status", data: { status: "tool_call", turn: 1 } },
            { type: "done", data: { status: options.statusBody?.result?.reason || options.doneStatus || "success" } }
          ];
      return adapterSseResponse(frames);
    }
    if (String(url).includes("/api/sessions/")) {
      const usage = options.statusBody?.result?.usage || {};
      return jsonResponse(200, {
        runs: [{
          id: "api-run-1",
          input_tokens: usage.input_tokens || 0,
          output_tokens: usage.output_tokens || 0,
          cost_usd: options.statusBody?.result?.cost || 0
        }]
      });
    }
    if (String(url).endsWith("/interrupt")) {
      return jsonResponse(options.cancelStatus || 200, options.cancelBody || { status: "interrupting" });
    }
    return jsonResponse(404, { detail: "not found" });
  };
}

// Serves the lea-standalone adapter's GET /api/stats with a fixed payload so the
// popover-usage path can be exercised without a live adapter.
function makeStatsFetch(stats) {
  return async (url) => {
    if (String(url).endsWith("/api/stats")) {
      return jsonResponse(200, stats);
    }
    return jsonResponse(404, { detail: "not found" });
  };
}

function keyStatus(last4, label) {
  return { configured: true, last4, label: label || null };
}

function makeAdapterStore(overrides = {}) {
  return {
    settings: {
      model: overrides.model || "o4-mini",
      max_turns: overrides.max_turns ?? 20,
      max_spend_usd: overrides.max_spend_usd ?? null,
      current_spend_usd: 0,
      api_keys: overrides.api_keys || {},
      model_options: []
    },
    reject: overrides.reject || null
  };
}

// Simulates the lea-standalone adapter's GET/PUT /api/settings, plus falls through
// to provider-key validation URLs (api.openai.com, …) for the companion's own
// pre-save key checks.
function makeAdapterFetch(adapter, calls = []) {
  return async (url, requestOptions = {}) => {
    const u = String(url);
    if (u.endsWith("/api/settings")) {
      const method = requestOptions.method || "GET";
      if (method === "GET") {
        calls.push({ method: "GET", url: u });
        return jsonResponse(200, adapter.settings);
      }
      if (method === "PUT") {
        const body = requestOptions.body ? JSON.parse(requestOptions.body) : {};
        calls.push({ method: "PUT", url: u, body });
        if (adapter.reject) {
          return jsonResponse(422, { detail: { message: adapter.reject.message, field: adapter.reject.field } });
        }
        if (typeof body.max_turns === "number") adapter.settings.max_turns = body.max_turns;
        if (body.max_spend_usd === null || typeof body.max_spend_usd === "number") {
          adapter.settings.max_spend_usd = body.max_spend_usd;
        }
        if (body.model) adapter.settings.model = body.model;
        for (const [env, patch] of Object.entries(body.api_keys || {})) {
          if (patch?.value) adapter.settings.api_keys[env] = keyStatus(String(patch.value).slice(-4), env);
        }
        return jsonResponse(200, adapter.settings);
      }
    }
    return makeProviderValidationFetch(calls)(url, requestOptions);
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
  if (text.startsWith("https://generativelanguage.googleapis.com/")) return "google";
  if (text.startsWith("https://api.anthropic.com/")) return "anthropic";
  return "";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

// An adapter-style SSE response: the event name rides the `event:` line.
function adapterSseResponse(frames) {
  return {
    ok: true,
    status: 200,
    body: (async function* () {
      for (const { type, data } of frames) {
        yield new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    })()
  };
}

function makeAdapterApiFetch(calls, options = {}) {
  return async (url, requestOptions = {}) => {
    const body = requestOptions.body ? JSON.parse(requestOptions.body) : null;
    calls.push({ url, options: requestOptions, body });
    if (String(url).endsWith("/api/runs") && requestOptions.method === "POST") {
      return jsonResponse(200, {
        session_id: options.sessionId || "sess-api-1",
        run_id: options.runId || "api-run-1",
        message: {},
        project_id: options.projectId || "adapter-project-1",
        project_slug: options.projectSlug || body?.project_slug || null,
        project_namespace: options.projectNamespace || "Lea.Project1"
      });
    }
    if (String(url).includes("/api/runs/") && String(url).endsWith("/events")) {
      return adapterSseResponse(options.eventFrames || [
        { type: "status", data: { status: "tool_call", message: "Running write_file", turn: 1 } },
        { type: "done", data: { status: options.doneStatus || "success" } }
      ]);
    }
    if (String(url).includes("/approvals/")) {
      return jsonResponse(200, { status: "resolved", decision: "always_session" });
    }
    if (String(url).includes("/api/sessions/")) {
      return jsonResponse(200, options.sessionDetail || {
        runs: [{ id: options.runId || "api-run-1", input_tokens: 10, output_tokens: 5, cost_usd: 0.001 }],
        code_steps: []
      });
    }
    if (String(url).endsWith("/interrupt")) {
      return jsonResponse(200, { status: "interrupting" });
    }
    throw new Error(`unexpected adapter fetch: ${url}`);
  };
}

test("formalize on the /api backend posts to /api/runs and runs autonomously (no /v1 calls)", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "test-key" },
    fetchImpl: makeAdapterApiFetch(calls)
  });

  const result = await handleFormalize({
    overleafProjectId: "project-1",
    targetKind: "theorem",
    targetLabel: "t_api",
    targetText: "A theorem."
  }, state);

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, "in_progress");
  await waitFor(() => calls.some((c) => String(c.url).endsWith("/api/runs") && c.options?.method === "POST"));
  const runCall = calls.find((c) => String(c.url).endsWith("/api/runs"));
  assert.ok(runCall.body.message.includes("project project-1"));
  assert.ok(!calls.some((c) => String(c.url).includes("/v1/")));
});

test("stub on the /api backend records a checked sorry stub with a Lea session link", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const proofPath = path.join("workspace", "proofs", "Lea", "Project1", "GeneratedStub.lean");
  const code = "namespace Lea.Project1\n\ntheorem generated_stub : True := by\n  sorry\n\nend Lea.Project1\n";
  await writeLeaProjectProof(leaRepo, proofPath, code);
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "test-key" },
    fetchImpl: makeAdapterApiFetch(calls, {
      doneStatus: "answered",
      sessionDetail: {
        project_namespace: "Lea.Project1",
        runs: [{ id: "api-run-1", input_tokens: 4, output_tokens: 6, cost_usd: 0.002 }],
        code_steps: [{
          id: "step-1",
          seq: 1,
          path: "GeneratedStub.lean",
          code,
          check_status: "ok",
          check_detail: "warning: declaration uses 'sorry'"
        }]
      }
    })
  });

  const result = await handleStub({
    overleafProjectId: "project-1",
    targetKind: "theorem",
    targetLabel: "generated_stub",
    targetText: "A generated stub theorem."
  }, state);

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, "sorry_stub");
  assert.equal(result.body.leanStatement, "theorem generated_stub : True");
  assert.equal(result.body.leaSessionId, "sess-api-1");
  assert.equal(result.body.leaSessionUrl, "http://localhost:5173/?session=sess-api-1");
  assert.equal(state.jobs[result.body.jobId].recordedProofPath, proofPath);
  assert.match(calls.find((c) => String(c.url).endsWith("/api/runs")).body.message, /Create a Lean sorry stub/);

  const statuses = await handleGetStatuses({
    overleafProjectId: "project-1",
    targets: [{ targetKind: "theorem", targetLabel: "generated_stub", targetText: "A generated stub theorem." }]
  }, state);
  assert.equal(statuses.body.statuses["theorem:generated_stub"].status, "sorry_stub");
  assert.equal(statuses.body.statuses["theorem:generated_stub"].leanStatement, "theorem generated_stub : True");
});

test("formalize after a saved stub reuses the stub session and proof file", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const proofPath = path.join("workspace", "proofs", "Lea", "Project1", "ReuseStub.lean");
  await writeLeaProjectProof(
    leaRepo,
    proofPath,
    "namespace Lea.Project1\n\ntheorem reuse_stub : True := by\n  sorry\n\nend Lea.Project1\n"
  );
  await writeLeaProjectMarkdown(leaRepo, "project-1", {
    theoremName: "reuse_stub",
    proofPath,
    moduleName: "Lea.Project1.ReuseStub"
  });
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "test-key" },
    fetchImpl: makeAdapterApiFetch(calls, {
      sessionDetail: { runs: [{ id: "api-run-1", input_tokens: 10, output_tokens: 5, cost_usd: 0.001 }], code_steps: [] }
    })
  });
  state.jobs.stub_job = {
    jobId: "stub_job",
    jobKey: "project-1:theorem:reuse_stub",
    status: "sorry_stub",
    finalStatus: "sorry_stub",
    overleafProjectId: "project-1",
    projectId: "project-1",
    projectSlug: "project-1",
    targetLabel: "reuse_stub",
    declarationName: "reuse_stub",
    recordedProofPath: proofPath,
    moduleName: "Lea.Project1.ReuseStub",
    leaRepoPath: leaRepo,
    leaSessionId: "sess-stub-1",
    leaUiBaseUrl: "http://localhost:5173",
    logPath: path.join(path.dirname(state.jobsPath), "stub.log"),
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z"
  };
  await fs.writeFile(state.jobs.stub_job.logPath, "stub\n", "utf8");

  const result = await handleFormalize({
    overleafProjectId: "project-1",
    targetKind: "theorem",
    targetLabel: "reuse_stub",
    targetText: "A theorem."
  }, state);

  assert.equal(result.statusCode, 200);
  await waitFor(() => calls.some((c) => String(c.url).endsWith("/api/runs") && c.options?.method === "POST"));
  const runCall = calls.find((c) => String(c.url).endsWith("/api/runs"));
  assert.equal(runCall.body.session_id, "sess-stub-1");
  assert.match(runCall.body.message, /Existing sorry stub to complete/);
  assert.equal(await fileExists(path.join(leaRepo, proofPath)), true);
});

test("resolveProofOutcome trusts an adapter-verified run even with no local proof file", async () => {
  // The adapter defers project-markdown recording, so the companion often
  // cannot locate the proof on disk (localStatus === unformalized). A successful
  // run (exit.ok) must still resolve to `formalized` — this is the core fix.
  const job = { targetKind: "theorem", targetLabel: "t1", leaWorkspacePath: "/tmp/does-not-matter" };
  const outcome = await resolveProofOutcome({
    job,
    localStatus: { status: "unformalized" },
    exit: { ok: true }
  });

  assert.equal(outcome.jobStatus, "formalized");
  assert.equal(outcome.finalStatus, "formalized");
  assert.equal(outcome.effectiveStatus.status, "formalized");
  assert.equal(outcome.error, null);
  assert.equal(outcome.leanCheck, null);
});

test("resolveProofOutcome maps adapter disproof to disproved status", async () => {
  const outcome = await resolveProofOutcome({
    job: { targetKind: "theorem", targetLabel: "false_claim", leaWorkspacePath: "/tmp/does-not-matter" },
    localStatus: { status: "unformalized" },
    exit: {
      ok: true,
      doneStatus: "disproved",
      resultKind: "disproved",
      resultDetail: "DISPROVED"
    }
  });

  assert.equal(outcome.jobStatus, "disproved");
  assert.equal(outcome.finalStatus, "disproved");
  assert.equal(outcome.effectiveStatus.status, "disproved");
  assert.equal(outcome.resultKind, "disproved");
  assert.equal(outcome.error, null);
});

test("resolveProofOutcome keeps a verified run formalized when local evidence is also formalized", async () => {
  const job = { targetKind: "theorem", targetLabel: "t2", leaWorkspacePath: "/tmp/x" };
  const localStatus = { status: "formalized", leanStatement: "theorem t2 : True" };
  const outcome = await resolveProofOutcome({ job, localStatus, exit: { ok: true } });

  assert.equal(outcome.jobStatus, "formalized");
  assert.equal(outcome.finalStatus, "formalized");
  assert.equal(outcome.effectiveStatus, localStatus);
  // No absolutePath, so no local lean check is attempted.
  assert.equal(outcome.leanCheck, null);
});

test("resolveProofOutcome records a leftover sorry as a failed run with sorry_stub effective status", async () => {
  const job = { targetKind: "theorem", targetLabel: "t3", leaWorkspacePath: "/tmp/x" };
  const localStatus = { status: "sorry_stub", absolutePath: "/tmp/x/t3.lean" };
  const outcome = await resolveProofOutcome({ job, localStatus, exit: { ok: true } });

  assert.equal(outcome.jobStatus, "failed");
  assert.equal(outcome.finalStatus, "sorry_stub");
  assert.equal(outcome.effectiveStatus.status, "sorry_stub");
  assert.match(outcome.error, /sorry\/admit/);
});

test("resolveProofOutcome marks a failed run as failed and surfaces the run error", async () => {
  const job = { targetKind: "theorem", targetLabel: "t4", leaWorkspacePath: "/tmp/x" };
  const outcome = await resolveProofOutcome({
    job,
    localStatus: { status: "unformalized" },
    exit: { ok: false, error: "Lea run ended with status: failed" }
  });

  assert.equal(outcome.jobStatus, "failed");
  assert.equal(outcome.finalStatus, "unformalized");
  assert.equal(outcome.error, "Lea run ended with status: failed");
});

test("formalize on the /api backend tags the theorem formalized when the run succeeds (regression)", async () => {
  // The /api adapter defers project-markdown recording, so the companion finds no
  // recorded artifact after the run. Before the fix the theorem was tagged
  // "failed" despite a verified proof; now the adapter's terminal `done: proved`
  // is authoritative and the tag must read "formalized".
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "test-key" },
    fetchImpl: makeAdapterApiFetch(calls)
  });

  const result = await handleFormalize({
    overleafProjectId: "project-1",
    targetKind: "theorem",
    targetLabel: "t_api_success",
    targetText: "A theorem."
  }, state);

  await waitFor(() => state.jobs[result.body.jobId]?.status === "formalized");
  const job = state.jobs[result.body.jobId];
  assert.equal(job.exitCode, 0);
  assert.equal(job.error, undefined);

  const statuses = await handleGetStatuses({
    overleafProjectId: "project-1",
    targets: [{ targetKind: "theorem", targetLabel: "t_api_success", targetText: "A theorem." }]
  }, state);
  assert.equal(statuses.statusCode, 200);
  assert.equal(statuses.body.statuses["theorem:t_api_success"].status, "formalized");
});

test("formalize on the /api backend tags the theorem failed when the run does not succeed", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const state = await makeState({
    leaRepoPath: leaRepo,
    env: { OPENAI_API_KEY: "test-key" },
    fetchImpl: makeAdapterApiFetch(calls, { doneStatus: "failed" })
  });

  const result = await handleFormalize({
    overleafProjectId: "project-1",
    targetKind: "theorem",
    targetLabel: "t_api_failure",
    targetText: "A theorem."
  }, state);

  await waitFor(() => state.jobs[result.body.jobId]?.status === "failed");
  const job = state.jobs[result.body.jobId];
  assert.equal(job.exitCode, 1);

  const statuses = await handleGetStatuses({
    overleafProjectId: "project-1",
    targets: [{ targetKind: "theorem", targetLabel: "t_api_failure", targetText: "A theorem." }]
  }, state);
  assert.equal(statuses.body.statuses["theorem:t_api_failure"].status, "failed");
});
