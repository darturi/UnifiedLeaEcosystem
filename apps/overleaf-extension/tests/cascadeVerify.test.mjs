// Unit tests for the factored-out cascade pipeline (self-repair Phase 0).
// Every collaborator is injected, so these tests drive runCascadeVerification
// directly with stubs -- no HTTP server, no filesystem. Handler-level coverage
// (the same pipeline reached through POST /lean-pane/edit/save) stays in
// leanPaneEdit.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";

import { breakageDescriptor, runCascadeVerification } from "../companion/cascadeVerify.mjs";

const NAMESPACE = "Lea.Project1";

function makeUpstream(overrides = {}) {
  return {
    overleafProjectId: "project-1",
    targetLabel: "compactness_criterion",
    effectiveName: "compactness_criterion",
    classification: { kind: "signature" },
    via: "edit",
    editedAt: "2026-07-04T12:00:00.000Z",
    sessionId: "sess-a",
    path: "compactness_criterion.lean",
    namespace: NAMESPACE,
    moduleName: `${NAMESPACE}.compactness_criterion`,
    ...overrides
  };
}

function dependentFile(name, imports = [`${NAMESPACE}.compactness_criterion`]) {
  return {
    stepPath: `${name}.lean`,
    moduleName: `${NAMESPACE}.${name}`,
    content: `${imports.map((m) => `import ${m}`).join("\n")}\n\ntheorem ${name} : True := by\n  sorry\n`
  };
}

// A deps bundle where every adapter call succeeds and every dependent has a
// linked session/job. Individual tests override pieces of it.
function makeDeps({ files = [], rebuildResults = {}, jobs = {} } = {}) {
  const calls = { rebuilds: [], leanChecks: [], verdicts: [] };
  const deps = {
    fetchImpl: () => { throw new Error("fetchImpl must not be called directly (all calls are injected)"); },
    baseUrl: "http://127.0.0.1:8001",
    apiKey: "key",
    dependentsOf: async () => files,
    rebuildApiSessionModule: async ({ sessionId, path }) => {
      calls.rebuilds.push({ sessionId, path });
      const result = rebuildResults[path] ?? { ok: true, body: { status: "ok" } };
      return result;
    },
    runApiSessionLeanCheck: async ({ sessionId, path, author, summary }) => {
      calls.leanChecks.push({ sessionId, path, author, summary });
      return { ok: true, body: { status: "ok" } };
    },
    resolveDependentSession: ({ targetLabel }) => {
      const job = jobs[targetLabel];
      if (!job) return { leaSessionId: null, activeJob: null, linkedJob: null };
      return { leaSessionId: job.leaSessionId, activeJob: job.activeJob || null, linkedJob: job };
    },
    recordEditCheckVerdict: (job, { status, detail } = {}, breakage = null) => {
      if (!job) return false;
      calls.verdicts.push({ job: job.label, status, detail, breakage });
      job.lastEditCheckStatus = String(status || "").toLowerCase() === "ok" ? "ok" : "error";
      if (String(status || "").toLowerCase() === "ok") delete job.lastEditBreakage;
      else if (breakage) job.lastEditBreakage = breakage;
      return true;
    },
    summarizeDependentFile: (file) => ({
      targetLabel: file.moduleName.split(".").pop(),
      moduleName: file.moduleName,
      relativePath: file.stepPath
    }),
    parseLeanImports: (content) => new Set(
      content.split("\n").filter((l) => l.startsWith("import ")).map((l) => l.slice("import ".length).trim())
    )
  };
  return { deps, calls };
}

const STATE = { settings: { leaRepoPath: "/tmp/lea" } };

test("cascade: a broken dependent gets invalid + attributed brokenByUpstream with via/editedAt, and the verdict persists breakage", async () => {
  const files = [dependentFile("compactness_corollary")];
  const job = { label: "compactness_corollary", leaSessionId: "sess-b" };
  const { deps, calls } = makeDeps({
    files,
    jobs: { compactness_corollary: job },
    rebuildResults: {
      "compactness_criterion.lean": { ok: true, body: { status: "ok" } },
      "compactness_corollary.lean": { ok: true, body: { status: "error", detail: "unknown identifier" } }
    }
  });
  const upstream = makeUpstream();

  const { dependentsImpact, jobsChanged } = await runCascadeVerification({ state: STATE, deps, upstream });

  assert.equal(jobsChanged, true);
  assert.equal(dependentsImpact.length, 1);
  const impact = dependentsImpact[0];
  assert.equal(impact.status, "invalid");
  assert.deepEqual(impact.brokenByUpstream, {
    targetLabel: "compactness_criterion",
    renamed: false,
    via: "edit",
    editedAt: "2026-07-04T12:00:00.000Z"
  });
  // the persisted attribution landed on the dependent's job via the verdict choke point
  assert.equal(job.lastEditBreakage.upstreamLabel, "compactness_criterion");
  assert.equal(job.lastEditBreakage.classificationKind, "signature");
  assert.equal(job.lastEditBreakage.via, "edit");
  // timeline entry recorded with author=cascade against the dependent's session
  const timeline = calls.leanChecks.find((c) => c.sessionId === "sess-b");
  assert.equal(timeline.author, "cascade");
  assert.match(timeline.summary, /Re-checked after edit to compactness_criterion/);
});

test("cascade: a still-valid dependent is reverified with no brokenByUpstream, and a passing verdict clears stale breakage", async () => {
  const files = [dependentFile("compactness_corollary")];
  const job = {
    label: "compactness_corollary",
    leaSessionId: "sess-b",
    lastEditBreakage: { upstreamLabel: "old", classificationKind: "signature", via: "edit", editedAt: "old" }
  };
  const { deps } = makeDeps({ files, jobs: { compactness_corollary: job } });

  const { dependentsImpact } = await runCascadeVerification({ state: STATE, deps, upstream: makeUpstream() });

  assert.equal(dependentsImpact[0].status, "reverified");
  assert.equal(dependentsImpact[0].brokenByUpstream, null);
  assert.equal(job.lastEditBreakage, undefined);
});

test("cascade: upstream rebuild failure fails closed -- every dependent unknown with an error verdict + breakage, none checked", async () => {
  const files = [dependentFile("compactness_corollary"), dependentFile("heine_borel_application")];
  const jobA = { label: "compactness_corollary", leaSessionId: "sess-b" };
  const jobB = { label: "heine_borel_application", leaSessionId: "sess-c" };
  const { deps, calls } = makeDeps({
    files,
    jobs: { compactness_corollary: jobA, heine_borel_application: jobB },
    rebuildResults: {
      "compactness_criterion.lean": { ok: true, body: { status: "error", detail: "compile failed" } }
    }
  });

  const { dependentsImpact } = await runCascadeVerification({ state: STATE, deps, upstream: makeUpstream() });

  assert.equal(dependentsImpact.length, 2);
  for (const impact of dependentsImpact) {
    assert.equal(impact.status, "unknown");
    assert.equal(impact.busy, false);
    assert.equal(impact.brokenByUpstream, null);
  }
  // fail-closed: verdicts written as error with attribution, chips cannot keep reading valid
  assert.equal(jobA.lastEditCheckStatus, "error");
  assert.equal(jobA.lastEditBreakage.upstreamLabel, "compactness_criterion");
  assert.equal(jobB.lastEditCheckStatus, "error");
  // only the upstream rebuild ran; no dependent build or timeline check
  assert.equal(calls.rebuilds.length, 1);
  assert.equal(calls.leanChecks.length, 0);
});

test("cascade: a dependent with an active run is skipped as busy in both the normal and fail-closed branches", async () => {
  const files = [dependentFile("compactness_corollary")];
  const busyJob = { label: "compactness_corollary", leaSessionId: "sess-b", activeJob: { jobId: "live" } };

  for (const upstreamRebuild of [{ ok: true, body: { status: "ok" } }, { ok: true, body: { status: "error" } }]) {
    const { deps, calls } = makeDeps({
      files,
      jobs: { compactness_corollary: busyJob },
      rebuildResults: { "compactness_criterion.lean": upstreamRebuild }
    });
    const { dependentsImpact } = await runCascadeVerification({ state: STATE, deps, upstream: makeUpstream() });
    assert.equal(dependentsImpact[0].status, "busy");
    assert.equal(dependentsImpact[0].busy, true);
    // never raced: no rebuild/check against the busy dependent's session
    assert.ok(!calls.rebuilds.some((c) => c.sessionId === "sess-b"));
    assert.ok(!calls.leanChecks.some((c) => c.sessionId === "sess-b"));
  }
});

test("cascade: unattributed dependent (no session) is reported at-risk but gets no verdict write", async () => {
  const files = [dependentFile("compactness_corollary")];
  const { deps, calls } = makeDeps({ files, jobs: {} });

  const { dependentsImpact, jobsChanged } = await runCascadeVerification({ state: STATE, deps, upstream: makeUpstream() });

  assert.equal(dependentsImpact[0].status, "unknown");
  assert.equal(dependentsImpact[0].attributed, false);
  assert.equal(jobsChanged, false);
  assert.equal(calls.verdicts.length, 0);
});

test("cascade: transitive fixpoint flips a spuriously-passing second-hop dependent to invalid with viaModule + persisted breakage", async () => {
  // C imports B (not A directly); B imports A and breaks; C's own build
  // spuriously passes against B's stale .olean.
  const fileB = dependentFile("compactness_corollary");
  const fileC = dependentFile("heine_borel_application", [`${NAMESPACE}.compactness_corollary`]);
  const jobB = { label: "compactness_corollary", leaSessionId: "sess-b" };
  const jobC = { label: "heine_borel_application", leaSessionId: "sess-c" };
  const { deps } = makeDeps({
    files: [fileB, fileC],
    jobs: { compactness_corollary: jobB, heine_borel_application: jobC },
    rebuildResults: {
      "compactness_criterion.lean": { ok: true, body: { status: "ok" } },
      "compactness_corollary.lean": { ok: true, body: { status: "error", detail: "type mismatch" } },
      "heine_borel_application.lean": { ok: true, body: { status: "ok" } } // the stale-build lie
    }
  });
  const upstream = makeUpstream({ classification: { kind: "renamed", from: "compactness_criterion", to: "compactness_thm" } });

  const { dependentsImpact } = await runCascadeVerification({ state: STATE, deps, upstream });

  const byLabel = Object.fromEntries(dependentsImpact.map((d) => [d.targetLabel, d]));
  assert.equal(byLabel.compactness_corollary.status, "invalid");
  assert.equal(byLabel.heine_borel_application.status, "invalid");
  assert.equal(byLabel.heine_borel_application.brokenByUpstream.viaModule, `${NAMESPACE}.compactness_corollary`);
  assert.equal(byLabel.heine_borel_application.brokenByUpstream.renamed, true);
  assert.equal(byLabel.heine_borel_application.brokenByUpstream.via, "edit");
  // the second-hop dependent's job also carries persisted breakage for the repair offer
  assert.equal(jobC.lastEditBreakage.upstreamLabel, "compactness_criterion");
  assert.equal(jobC.lastEditBreakage.renamedTo, "compactness_thm");
});

test("cascade: a dependentsOf failure degrades to an empty impact list, not a throw", async () => {
  const { deps } = makeDeps();
  deps.dependentsOf = async () => { throw new Error("scan failed"); };
  const { dependentsImpact, jobsChanged } = await runCascadeVerification({ state: STATE, deps, upstream: makeUpstream() });
  assert.deepEqual(dependentsImpact, []);
  assert.equal(jobsChanged, false);
});

test("breakageDescriptor: rename carries from/to and the NEW declaration name; other kinds carry the effective name", () => {
  const renamed = breakageDescriptor(makeUpstream({
    classification: { kind: "renamed", from: "compactness_criterion", to: "compactness_thm" },
    via: "chat"
  }));
  assert.equal(renamed.upstreamDeclarationName, "compactness_thm");
  assert.equal(renamed.renamedFrom, "compactness_criterion");
  assert.equal(renamed.renamedTo, "compactness_thm");
  assert.equal(renamed.via, "chat");

  const signature = breakageDescriptor(makeUpstream());
  assert.equal(signature.upstreamDeclarationName, "compactness_criterion");
  assert.equal(signature.renamedTo, undefined);
  assert.equal(signature.classificationKind, "signature");
});
