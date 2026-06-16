import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { applyEnvDefaults, loadDotEnv } from "../companion/config.mjs";

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

test("applies environment defaults without replacing explicit settings", () => {
  const settings = applyEnvDefaults(
    { leaModel: "explicit-model", leaApiKey: "legacy-openai-key" },
    {
      LEA_REPO_PATH: "/tmp/lea",
      LEA_MODEL: "env-model",
      LEA_MAX_TURNS: "7",
      LEA_THEOREM_TRANSLATION_MAX_RETRIES: "5",
      LEA_LATEX_CONTEXT_MODE: "active_file",
      LEA_MAX_SPEND_USD: "12.5"
    }
  );

  assert.equal(settings.leaRepoPath, "/tmp/lea");
  assert.equal(settings.leaModel, "explicit-model");
  assert.equal(settings.leaMaxTurns, 7);
  assert.equal(settings.leaTheoremTranslationMaxRetries, 5);
  assert.equal(settings.leaLatexContextMode, "active_file");
  assert.equal(settings.leaMaxSpendUsd, 12.5);
  assert.equal(settings.leaApiKey, "legacy-openai-key");
  assert.equal(settings.leaProviderApiKeys, undefined);
});

test("explicit max spend overrides environment default", () => {
  const settings = applyEnvDefaults(
    { leaMaxSpendUsd: 3.25 },
    { LEA_MAX_SPEND_USD: "12.5" }
  );

  assert.equal(settings.leaMaxSpendUsd, 3.25);
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

  assert.equal(settings.leaRepoPath, path.join(PROJECT_ROOT, "vendor", "lea-prover"));
  assert.equal(settings.leaLatexContextMode, "off");
  assert.equal(settings.leaMaxSpendUsd, null);
});
