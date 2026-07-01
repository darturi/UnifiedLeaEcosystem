import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleLeanPaneEditSave, handleLeanPaneEditStart, handleLeanPaneManifest } from "../companion/server.mjs";

async function makeLeaRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lea-edit-repo-"));
  await fs.mkdir(path.join(dir, "workspace", "proofs"), { recursive: true });
  // handleLeanPaneManifest validates the repo (validateLeaRepo) before
  // enrichment; without these it degrades every item to status "unknown"
  // rather than actually computing a status, which would mask this file's
  // manifest-level regression test rather than exercise it.
  await fs.writeFile(path.join(dir, "pyproject.toml"), "[project]\nname = \"lea-prover\"\n", "utf8");
  await fs.writeFile(path.join(dir, "workspace", "lean-toolchain"), "leanprover/lean4:stable\n", "utf8");
  await fs.writeFile(path.join(dir, "workspace", "lakefile.lean"), "import Lake\nopen Lake DSL\n", "utf8");
  return dir;
}

async function writeProof(leaRepo, relativePath, content) {
  const absolute = path.join(leaRepo, "workspace", "proofs", relativePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, "utf8");
}

function makeState({ leaRepo, jobs = {}, fetchImpl }) {
  return {
    settings: { leaRepoPath: leaRepo, leaApiBaseUrl: "http://127.0.0.1:8001" },
    jobs,
    jobsPath: path.join(leaRepo, "jobs.json"),
    env: {},
    fetchImpl
  };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(body); } };
}

// Routes GET/POST /api/sessions/{id}[/file|/lean-check] against per-session
// fixtures, and records every call for assertions on exactly what the
// cascade logic did/didn't touch.
function makeEditFetch(calls, { sessionDetails = {}, writeResponses = {}, checkResponses = {} } = {}) {
  return async (url, requestOptions = {}) => {
    const method = requestOptions.method || "GET";
    const body = requestOptions.body ? JSON.parse(requestOptions.body) : null;
    calls.push({ url: String(url), method, body });
    const match = String(url).match(/\/api\/sessions\/([^/]+)(?:\/(file|lean-check))?$/);
    if (!match) return jsonResponse(404, { detail: "unmapped url in test fetch stub" });
    const sessionId = decodeURIComponent(match[1]);
    const kind = match[2] || "detail";
    if (kind === "detail") {
      return jsonResponse(200, sessionDetails[sessionId] || { code_steps: [] });
    }
    if (kind === "file") {
      const response = writeResponses[sessionId];
      return jsonResponse(200, typeof response === "function" ? response(body) : (response || { unchanged: false, code_step: null, note: null }));
    }
    if (kind === "lean-check") {
      const response = checkResponses[sessionId];
      return jsonResponse(200, typeof response === "function" ? response(body) : (response || { path: body?.path, status: "ok", detail: null }));
    }
    return jsonResponse(404, { detail: "unmapped kind" });
  };
}

const NAMESPACE = "Lea.Project1";

function editedJob(overrides = {}) {
  return {
    jobKey: "project-1:theorem:compactness_criterion",
    status: "formalized",
    leaSessionId: "sess-a",
    projectSlug: "project-1",
    projectNamespace: NAMESPACE,
    ...overrides
  };
}

function dependentJob(overrides = {}) {
  return {
    jobKey: "project-1:theorem:compactness_corollary",
    status: "formalized",
    leaSessionId: "sess-b",
    projectSlug: "project-1",
    projectNamespace: NAMESPACE,
    ...overrides
  };
}

const EDITED_SESSION_DETAIL = {
  project_namespace: NAMESPACE,
  code_steps: [
    { path: "compactness_criterion.lean", seq: 1, code: "theorem compactness_criterion : True := by\n  sorry\n" }
  ]
};

test("edit start returns no_session when the item has never been formalized", async () => {
  const leaRepo = await makeLeaRepo();
  const state = makeState({ leaRepo, fetchImpl: makeEditFetch([]) });

  const res = await handleLeanPaneEditStart(
    { overleafProjectId: "project-1", targetKind: "theorem", targetLabel: "compactness_criterion" },
    state
  );

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, "no_session");
});

test("edit start rejects an invalid payload before touching the adapter", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const state = makeState({ leaRepo, fetchImpl: makeEditFetch(calls) });

  const res = await handleLeanPaneEditStart({ overleafProjectId: "", targetKind: "theorem", targetLabel: "foo" }, state);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "missing_project_id");
  assert.deepEqual(calls, []);
});

test("edit start resolves the session's current content and pre-save dependents", async () => {
  const leaRepo = await makeLeaRepo();
  await writeProof(leaRepo, "Lea/Project1/compactness_criterion.lean", "theorem compactness_criterion : True := by\n  sorry\n");
  await writeProof(
    leaRepo,
    "Lea/Project1/compactness_corollary.lean",
    "import Lea.Project1.compactness_criterion\ntheorem compactness_corollary : True := by\n  sorry\n"
  );
  const calls = [];
  const state = makeState({
    leaRepo,
    jobs: { a: editedJob() },
    fetchImpl: makeEditFetch(calls, { sessionDetails: { "sess-a": EDITED_SESSION_DETAIL } })
  });

  const res = await handleLeanPaneEditStart(
    { overleafProjectId: "project-1", targetKind: "theorem", targetLabel: "compactness_criterion" },
    state
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.leaSessionId, "sess-a");
  assert.equal(res.body.path, "compactness_criterion.lean");
  assert.match(res.body.content, /theorem compactness_criterion : True/);
  assert.deepEqual(res.body.dependents.map((d) => d.targetLabel), ["compactness_corollary"]);
});

test("edit save: a proof-body-only edit never triggers a cascade re-check", async () => {
  const leaRepo = await makeLeaRepo();
  await writeProof(
    leaRepo,
    "Lea/Project1/compactness_corollary.lean",
    "import Lea.Project1.compactness_criterion\ntheorem compactness_corollary : True := by\n  sorry\n"
  );
  const calls = [];
  const state = makeState({
    leaRepo,
    jobs: { a: editedJob(), b: dependentJob() },
    fetchImpl: makeEditFetch(calls, {
      sessionDetails: { "sess-a": EDITED_SESSION_DETAIL },
      writeResponses: { "sess-a": { unchanged: false, code_step: { id: "step-2" }, note: null } },
      checkResponses: { "sess-a": { path: "compactness_criterion.lean", status: "ok", detail: null } }
    })
  });

  const res = await handleLeanPaneEditSave(
    {
      overleafProjectId: "project-1",
      targetKind: "theorem",
      targetLabel: "compactness_criterion",
      // same header ("theorem compactness_criterion : True"), different proof body
      content: "theorem compactness_criterion : True := by\n  trivial\n"
    },
    state
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ownResult.classification.kind, "proof-only");
  assert.deepEqual(res.body.dependentsImpact, []);
  // no lean-check call was ever made against the dependent's session
  assert.ok(!calls.some((c) => c.url.includes("/sess-b/")));
});

test("edit save: a signature edit cascades and reports a broken dependent, attributed to the upstream edit", async () => {
  const leaRepo = await makeLeaRepo();
  await writeProof(
    leaRepo,
    "Lea/Project1/compactness_corollary.lean",
    "import Lea.Project1.compactness_criterion\ntheorem compactness_corollary : True := by\n  sorry\n"
  );
  const calls = [];
  const state = makeState({
    leaRepo,
    jobs: { a: editedJob(), b: dependentJob() },
    fetchImpl: makeEditFetch(calls, {
      sessionDetails: { "sess-a": EDITED_SESSION_DETAIL },
      writeResponses: { "sess-a": { unchanged: false, code_step: { id: "step-2" }, note: null } },
      checkResponses: {
        "sess-a": { path: "compactness_criterion.lean", status: "ok", detail: null },
        "sess-b": (body) => ({ path: body.path, status: "error", detail: "unknown identifier: compactness_criterion" })
      }
    })
  });

  const res = await handleLeanPaneEditSave(
    {
      overleafProjectId: "project-1",
      targetKind: "theorem",
      targetLabel: "compactness_criterion",
      // hypothesis added -- header changes, so this is a signature edit
      content: "theorem compactness_criterion (h : True) : True := by\n  sorry\n"
    },
    state
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ownResult.classification.kind, "signature");
  assert.equal(res.body.dependentsImpact.length, 1);
  const impact = res.body.dependentsImpact[0];
  assert.equal(impact.targetLabel, "compactness_corollary");
  assert.equal(impact.status, "invalid");
  assert.equal(impact.attributed, true);
  assert.deepEqual(impact.brokenByUpstream, { targetLabel: "compactness_criterion", renamed: false });

  // the cascade check was recorded against the DEPENDENT's own session, with
  // author=cascade, not against the edited target's session
  const cascadeCall = calls.find((c) => c.url.endsWith("/sess-b/lean-check"));
  assert.ok(cascadeCall);
  assert.equal(cascadeCall.body.author, "cascade");
  assert.equal(cascadeCall.body.path, "compactness_corollary.lean");

  // both the edited item's own job and the broken dependent's job carry the
  // fresh verdict, so getTheoremStatus's override picks it up for both on the
  // next manifest refresh (not just the edited item)
  assert.equal(state.jobs.a.lastEditCheckStatus, "ok");
  assert.equal(state.jobs.b.lastEditCheckStatus, "error");
  assert.match(state.jobs.b.lastEditCheckDetail, /unknown identifier/);
});

test("edit save: a def body edit cascades even with an unchanged signature", async () => {
  const leaRepo = await makeLeaRepo();
  const defSessionDetail = {
    project_namespace: NAMESPACE,
    code_steps: [{ path: "locally_finite_family.lean", seq: 1, code: "def locally_finite_family : Prop := True\n" }]
  };
  await writeProof(
    leaRepo,
    "Lea/Project1/uses_it.lean",
    "import Lea.Project1.locally_finite_family\ntheorem uses_it : True := by\n  sorry\n"
  );
  const calls = [];
  const state = makeState({
    leaRepo,
    jobs: {
      a: { jobKey: "project-1:definition:locally_finite_family", status: "formalized", leaSessionId: "sess-def", projectSlug: "project-1", projectNamespace: NAMESPACE },
      b: { jobKey: "project-1:theorem:uses_it", status: "formalized", leaSessionId: "sess-uses", projectSlug: "project-1", projectNamespace: NAMESPACE }
    },
    fetchImpl: makeEditFetch(calls, {
      sessionDetails: { "sess-def": defSessionDetail },
      writeResponses: { "sess-def": { unchanged: false, code_step: { id: "step-x" }, note: null } },
      checkResponses: {
        "sess-def": { path: "locally_finite_family.lean", status: "ok", detail: null },
        "sess-uses": { path: "uses_it.lean", status: "ok", detail: null }
      }
    })
  });

  const res = await handleLeanPaneEditSave(
    {
      overleafProjectId: "project-1",
      targetKind: "definition",
      targetLabel: "locally_finite_family",
      // same signature ("def locally_finite_family : Prop"), different value
      content: "def locally_finite_family : Prop := False\n"
    },
    state
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ownResult.classification.kind, "definition-body");
  assert.equal(res.body.dependentsImpact.length, 1);
  assert.equal(res.body.dependentsImpact[0].status, "reverified");
  assert.equal(res.body.dependentsImpact[0].brokenByUpstream, null);
});

test("edit save: no-op content short-circuits with no lean-check or cascade calls", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const state = makeState({
    leaRepo,
    jobs: { a: editedJob() },
    fetchImpl: makeEditFetch(calls, {
      sessionDetails: { "sess-a": EDITED_SESSION_DETAIL },
      writeResponses: { "sess-a": { unchanged: true, code_step: null, note: null } }
    })
  });

  const res = await handleLeanPaneEditSave(
    {
      overleafProjectId: "project-1",
      targetKind: "theorem",
      targetLabel: "compactness_criterion",
      content: EDITED_SESSION_DETAIL.code_steps[0].code
    },
    state
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.unchanged, true);
  assert.ok(!calls.some((c) => c.url.endsWith("/lean-check")));
});

test("edit save is blocked with 409 while a run is already active for the item", async () => {
  const leaRepo = await makeLeaRepo();
  const state = makeState({
    leaRepo,
    jobs: { a: editedJob({ status: "in_progress" }) },
    fetchImpl: makeEditFetch([])
  });

  const res = await handleLeanPaneEditSave(
    { overleafProjectId: "project-1", targetKind: "theorem", targetLabel: "compactness_criterion", content: "theorem compactness_criterion : True := by\n  sorry\n" },
    state
  );

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, "run_in_progress");
});

test("edit save: a dependent with its own active run is skipped, not raced", async () => {
  const leaRepo = await makeLeaRepo();
  await writeProof(
    leaRepo,
    "Lea/Project1/compactness_corollary.lean",
    "import Lea.Project1.compactness_criterion\ntheorem compactness_corollary : True := by\n  sorry\n"
  );
  const calls = [];
  const state = makeState({
    leaRepo,
    jobs: { a: editedJob(), b: dependentJob({ status: "in_progress" }) },
    fetchImpl: makeEditFetch(calls, {
      sessionDetails: { "sess-a": EDITED_SESSION_DETAIL },
      writeResponses: { "sess-a": { unchanged: false, code_step: { id: "step-2" }, note: null } },
      checkResponses: { "sess-a": { path: "compactness_criterion.lean", status: "ok", detail: null } }
    })
  });

  const res = await handleLeanPaneEditSave(
    {
      overleafProjectId: "project-1",
      targetKind: "theorem",
      targetLabel: "compactness_criterion",
      content: "theorem compactness_criterion (h : True) : True := by\n  sorry\n"
    },
    state
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dependentsImpact.length, 1);
  assert.equal(res.body.dependentsImpact[0].busy, true);
  assert.ok(!calls.some((c) => c.url.endsWith("/sess-b/lean-check")));
});

// Regression test for the bug report: editing a proof to be broken must flip
// the pane's own status chip to invalid, not just surface a small-print note
// alongside a chip that still says valid. Exercises the real path a user
// hits: handleLeanPaneManifest (which computes the chip's status) before and
// after handleLeanPaneEditSave.
test("edit save flips the item's own status chip to invalid on the next manifest refresh (not just a side note)", async () => {
  const leaRepo = await makeLeaRepo();
  const calls = [];
  const state = makeState({
    leaRepo,
    jobs: { a: editedJob() }, // status: "formalized" -- what the pane read as "valid" before the bugfix
    fetchImpl: makeEditFetch(calls, {
      sessionDetails: { "sess-a": EDITED_SESSION_DETAIL },
      writeResponses: { "sess-a": { unchanged: false, code_step: { id: "step-2" }, note: null } },
      checkResponses: {
        "sess-a": { path: "compactness_criterion.lean", status: "error", detail: "unknown identifier: foo" }
      }
    })
  });

  const tex = [
    "\\begin{theorem}\\label{thm:x}",
    "% lea: formalize label=compactness_criterion",
    "Every open cover has a finite subcover.",
    "\\end{theorem}"
  ].join("\n");
  const files = [{ path: "main.tex", content: tex }];

  const before = await handleLeanPaneManifest({ overleafProjectId: "project-1", files }, state);
  assert.equal(before.body.items[0].status, "valid");

  const save = await handleLeanPaneEditSave(
    {
      overleafProjectId: "project-1",
      targetKind: "theorem",
      targetLabel: "compactness_criterion",
      content: "theorem compactness_criterion : True := by\n  exact foo\n"
    },
    state
  );
  assert.equal(save.statusCode, 200);
  assert.equal(save.body.ownResult.checkStatus, "error");

  const after = await handleLeanPaneManifest({ overleafProjectId: "project-1", files }, state);
  assert.equal(after.body.items[0].status, "invalid");
  assert.match(after.body.items[0].message, /unknown identifier: foo/);

  // and the override clears itself once a later edit compiles again
  state.fetchImpl = makeEditFetch(calls, {
    sessionDetails: { "sess-a": EDITED_SESSION_DETAIL },
    writeResponses: { "sess-a": { unchanged: false, code_step: { id: "step-3" }, note: null } },
    checkResponses: { "sess-a": { path: "compactness_criterion.lean", status: "ok", detail: null } }
  });
  await handleLeanPaneEditSave(
    {
      overleafProjectId: "project-1",
      targetKind: "theorem",
      targetLabel: "compactness_criterion",
      content: "theorem compactness_criterion : True := by\n  trivial\n"
    },
    state
  );
  const fixed = await handleLeanPaneManifest({ overleafProjectId: "project-1", files }, state);
  assert.equal(fixed.body.items[0].status, "valid");
});
