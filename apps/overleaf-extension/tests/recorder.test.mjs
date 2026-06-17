import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildRecorderArgs,
  parseRecorderResult,
  spawnLeaRecorder
} from "../companion/server.mjs";

function makeJobAndTarget(logPath) {
  const job = {
    jobId: "lemma-1-2026",
    logPath,
    leaModel: "o4-mini",
    leaMaxTurns: 20,
    leaRepoPath: "/repo/vendor/lea-prover"
  };
  const target = {
    overleafProjectId: "olp-123",
    theoremLabel: "lemma-1",
    projectSlug: "myproj",
    relativePath: "workspace/projects/myproj.md"
  };
  return { job, target };
}

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "overleaf-recorder-"));
}

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  return child;
}

test("buildRecorderArgs encodes run, origin, project, and external ref", () => {
  const { job, target } = makeJobAndTarget("/tmp/x.log");
  const args = buildRecorderArgs({ job, target, apiRunId: "run_abc", prompt: "Prove it" });

  assert.equal(args[0], "-m");
  assert.equal(args[1], "app.recorder");
  const flag = (name) => args[args.indexOf(name) + 1];
  assert.equal(flag("--api-run-id"), "run_abc");
  assert.equal(flag("--origin"), "overleaf");
  assert.equal(flag("--task"), "Prove it");
  assert.equal(flag("--title"), "lemma-1");
  assert.equal(flag("--model"), "o4-mini");
  assert.equal(flag("--max-turns"), "20");
  assert.equal(flag("--project-slug"), "myproj");
  assert.equal(flag("--project-path"), "workspace/projects/myproj.md");
  const externalRef = JSON.parse(flag("--external-ref"));
  assert.deepEqual(externalRef, {
    overleaf_project_id: "olp-123",
    theorem_label: "lemma-1",
    companion_job_id: "lemma-1-2026"
  });
});

test("parseRecorderResult reads the JSON result line, ignoring log noise", () => {
  const stdout = "some log line\n{\"session_id\":\"s1\",\"run_id\":\"r1\",\"status\":\"success\"}\n";
  assert.deepEqual(parseRecorderResult(stdout), {
    session_id: "s1",
    run_id: "r1",
    status: "success"
  });
  assert.equal(parseRecorderResult("no json here"), null);
});

test("spawnLeaRecorder does nothing when shared state is disabled", async () => {
  const dir = await makeTempDir();
  const { job, target } = makeJobAndTarget(path.join(dir, "job.log"));
  let spawned = false;
  const state = {
    jobsPath: path.join(dir, "jobs.json"),
    jobs: {},
    settings: { leaSharedState: false, leaRecorderPython: "python", leaUiServerDir: dir },
    spawnImpl: () => {
      spawned = true;
      return makeFakeChild();
    }
  };

  const result = await spawnLeaRecorder({ state, job, target, apiRunId: "run_abc", prompt: "Prove it" });
  assert.equal(result, null);
  assert.equal(spawned, false);
});

test("spawnLeaRecorder spawns the recorder and links the session on close", async () => {
  const dir = await makeTempDir();
  const { job, target } = makeJobAndTarget(path.join(dir, "job.log"));
  await fs.writeFile(job.logPath, "", "utf8");

  let captured = null;
  const child = makeFakeChild();
  const state = {
    jobsPath: path.join(dir, "jobs.json"),
    jobs: {},
    settings: {
      leaSharedState: true,
      leaRecorderPython: "/venv/bin/python",
      leaUiServerDir: "/repo/apps/lea-ui/server"
    },
    spawnImpl: (cmd, args, opts) => {
      captured = { cmd, args, opts };
      return child;
    }
  };

  const returned = await spawnLeaRecorder({ state, job, target, apiRunId: "run_abc", prompt: "Prove it" });
  assert.equal(returned, child);
  assert.equal(captured.cmd, "/venv/bin/python");
  assert.equal(captured.opts.cwd, "/repo/apps/lea-ui/server");
  assert.ok(captured.opts.env.PYTHONPATH.includes("/repo/vendor/lea-prover"));
  assert.equal(job.recorderSpawned, true);
  assert.equal(job.recorderPid, 4242);

  child.stdout.emit("data", "{\"session_id\":\"sess-9\",\"run_id\":\"run-9\",\"status\":\"success\"}\n");
  child.emit("close", 0);

  let logText = "";
  for (let i = 0; i < 50 && !logText.includes("linked session sess-9"); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    logText = await fs.readFile(job.logPath, "utf8");
  }

  assert.equal(job.recorderSessionId, "sess-9");
  assert.equal(job.recorderRunId, "run-9");
  assert.ok(logText.includes("linked session sess-9"));
});

test("spawnLeaRecorder only spawns once per job", async () => {
  const dir = await makeTempDir();
  const { job, target } = makeJobAndTarget(path.join(dir, "job.log"));
  let count = 0;
  const state = {
    jobsPath: path.join(dir, "jobs.json"),
    jobs: {},
    settings: { leaSharedState: true, leaRecorderPython: "python", leaUiServerDir: dir },
    spawnImpl: () => {
      count += 1;
      return makeFakeChild();
    }
  };

  await spawnLeaRecorder({ state, job, target, apiRunId: "run_abc", prompt: "p" });
  await spawnLeaRecorder({ state, job, target, apiRunId: "run_abc", prompt: "p" });
  assert.equal(count, 1);
});
