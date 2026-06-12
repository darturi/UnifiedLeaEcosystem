import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ensureStartupLeaRuntime,
  handleFormalize,
  handleGetStatuses,
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

test("statuses are in progress when project proof still contains sorry", async () => {
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
  assert.equal(result.body.statuses.project_sorry_test.status, "in_progress");
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
    settings: {
      ...(overrides.leaRepoPath ? {
        leaRepoPath: overrides.leaRepoPath,
        leaWorkspacePath: buildLeaWorkspacePath(overrides.leaRepoPath),
        leaProvider: "openai",
        leaModel: "o4-mini",
        leaMaxTurns: 20,
        ...(overrides.leaJobTimeoutSeconds ? {
          leaJobTimeoutSeconds: overrides.leaJobTimeoutSeconds
        } : {})
      } : {})
    },
    jobs: {},
    env: overrides.env || process.env,
    fetchImpl: overrides.fetchImpl
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
  return async (url, requestOptions = {}) => {
    const body = requestOptions.body ? JSON.parse(requestOptions.body) : null;
    calls.push({ url, options: requestOptions, body });
    if (String(url).endsWith("/v1/runs")) {
      return jsonResponse(200, { run_id: "api-run-1", status: "running" });
    }
    if (!statusRequestHandled && options.onStatusRequest) {
      statusRequestHandled = true;
      await options.onStatusRequest();
    }
    return jsonResponse(200, options.statusBody || { run_id: "api-run-1", status: "running" });
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
