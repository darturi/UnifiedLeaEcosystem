import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { applyEnvDefaults, loadDotEnv } from "../companion/config.mjs";
import { patchEnvFile } from "../../../scripts/env.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("loads .env values without overriding existing environment", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "overleaf-env-"));
  await fs.writeFile(
    path.join(dir, ".env"),
    "OPENAI_API_KEY=from_file\nLEA_MODEL=o4-mini\nQUOTED=\"hello world\"\n",
    "utf8"
  );

  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "from_shell";
  delete process.env.LEA_MODEL;
  delete process.env.QUOTED;

  const result = loadDotEnv(dir);

  assert.equal(result.loaded, true);
  assert.equal(process.env.OPENAI_API_KEY, "from_shell");
  assert.equal(process.env.LEA_MODEL, "o4-mini");
  assert.equal(process.env.QUOTED, "hello world");

  if (previous === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = previous;
  }
  delete process.env.LEA_MODEL;
  delete process.env.QUOTED;
});

test("shared environment defaults replace explicit local settings", () => {
  const settings = applyEnvDefaults(
    {
      leaModel: "explicit-model",
      leaMaxTurns: 3,
      leaMaxSpendUsd: 3.25,
      leaApiKey: "legacy-openai-key",
      leaLatexContextMode: "active_file",
    },
    {
      LEA_REPO_PATH: "/tmp/lea",
      LEA_MODEL: "env-model",
      LEA_MAX_TURNS: "7",
      LEA_THEOREM_TRANSLATION_MAX_RETRIES: "5",
      LEA_LATEX_CONTEXT_MODE: "off",
      LEA_MAX_SPEND_USD: "12.5"
    }
  );

  assert.equal(settings.leaRepoPath, "/tmp/lea");
  assert.equal(settings.leaModel, "env-model");
  assert.equal(settings.leaMaxTurns, 7);
  assert.equal(settings.leaTheoremTranslationMaxRetries, 5);
  assert.equal(settings.leaLatexContextMode, "active_file");
  assert.equal(settings.leaMaxSpendUsd, 12.5);
  assert.equal(settings.leaApiKey, "legacy-openai-key");
  assert.equal(settings.leaProviderApiKeys, undefined);
});

test("environment max spend overrides explicit local setting", () => {
  const settings = applyEnvDefaults(
    { leaMaxSpendUsd: 3.25 },
    { LEA_MAX_SPEND_USD: "12.5" }
  );

  assert.equal(settings.leaMaxSpendUsd, 12.5);
});

test("negative max spend is rejected", () => {
  assert.throws(
    () => applyEnvDefaults({}, { LEA_MAX_SPEND_USD: "-1" }),
    /leaMaxSpendUsd/
  );
});

test("invalid latex context mode is rejected", () => {
  assert.throws(
    () => applyEnvDefaults({}, { LEA_LATEX_CONTEXT_MODE: "project" }),
    /leaLatexContextMode/
  );
});

test("derives local path defaults when env values are absent", () => {
  const settings = applyEnvDefaults({}, {});

  assert.equal(settings.leaRepoPath, path.resolve(PROJECT_ROOT, "../..", "vendor", "lea-prover"));
  assert.equal(settings.leaLatexContextMode, "off");
  assert.equal(settings.leaMaxSpendUsd, null);
});

test("patches env files while preserving unrelated entries", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "overleaf-env-patch-"));
  const envPath = path.join(dir, ".env");
  await fs.writeFile(envPath, "KEEP=yes\nOPENAI_API_KEY=old\n", "utf8");

  await patchEnvFile(envPath, {
    OPENAI_API_KEY: "new value",
    ANTHROPIC_API_KEY: "sk-ant-secret",
  });

  const text = await fs.readFile(envPath, "utf8");
  assert.match(text, /^KEEP=yes/m);
  assert.match(text, /^OPENAI_API_KEY="new value"/m);
  assert.match(text, /^ANTHROPIC_API_KEY=sk-ant-secret/m);
});
