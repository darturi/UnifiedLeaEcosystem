import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { handleLeanPaneEditSave, handleLeanPaneEditStart, handleLeanPaneManifest } from "../companion/server.mjs";
import { formatDependentOutcome } from "../extension/leanPaneView.mjs";

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
function makeEditFetch(calls, { sessionDetails = {}, writeResponses = {}, checkResponses = {}, rebuildResponses = {} } = {}) {
  return async (url, requestOptions = {}) => {
    const method = requestOptions.method || "GET";
    const body = requestOptions.body ? JSON.parse(requestOptions.body) : null;
    calls.push({ url: String(url), method, body });
    const match = String(url).match(/\/api\/sessions\/([^/]+)(?:\/(file|lean-check|rebuild))?$/);
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
    if (kind === "rebuild") {
      // Defaults to a successful rebuild so every existing test (none of which
      // configure rebuildResponses) sees the cascade proceed exactly as before
      // this step was introduced -- only tests that care about a *failed*
      // rebuild need to override it.
      const response = rebuildResponses[sessionId];
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

  // the edited module (sess-a) was rebuilt for real -- once, and before the
  // dependent's check -- so the dependent's "still valid"/"invalid" verdict
  // above is against A's *current* signature, not a stale compiled artifact.
  const rebuildCalls = calls.filter((c) => c.url.endsWith("/sess-a/rebuild"));
  assert.equal(rebuildCalls.length, 1);
  assert.equal(rebuildCalls[0].body.path, "compactness_criterion.lean");
  assert.ok(calls.indexOf(rebuildCalls[0]) < calls.indexOf(cascadeCall));

  // both the edited item's own job and the broken dependent's job carry the
  // fresh verdict, so getTheoremStatus's override picks it up for both on the
  // next manifest refresh (not just the edited item)
  assert.equal(state.jobs.a.lastEditCheckStatus, "ok");
  assert.equal(state.jobs.b.lastEditCheckStatus, "error");
  assert.match(state.jobs.b.lastEditCheckDetail, /unknown identifier/);

  // a same-name signature edit (not a rename) must not touch declarationName --
  // only classification.kind === "renamed" should
  assert.equal(state.jobs.a.declarationName, undefined);
});

test("edit save: a rename updates the job's cached declarationName, not just the classification", async () => {
  // Regression test for a bug found live: the pane's item identity
  // (targetLabel) correctly stays pinned to the LaTeX marker's label=...
  // forever, but linkedJob.declarationName is a *cache* of "what Lean symbol
  // this session's file currently defines," taken once at formalize time.
  // Nothing refreshed it on a manual rename, so readLeanPaneArtifactFromSession
  // (which selects the latest code_step whose content still contains
  // declarationName) kept falling back to the pre-rename step -- the edited
  // item's own displayed code block silently stayed stale even though the
  // rename itself, and the cascade break on its dependent, were both detected
  // and reported correctly. See docs/FEATURE-overleaf-lean-pane-manual-edit.md.
  const leaRepo = await makeLeaRepo();
  await writeProof(
    leaRepo,
    "Lea/Project1/compactness_corollary.lean",
    "import Lea.Project1.compactness_criterion\ntheorem compactness_corollary : True := by\n  sorry\n"
  );
  const calls = [];
  const state = makeState({
    leaRepo,
    jobs: { a: editedJob({ declarationName: "compactness_criterion" }), b: dependentJob() },
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
      // same signature shape, different name -- classifyEdit's "renamed" case
      content: "theorem compactness_thm : True := by\n  sorry\n"
    },
    state
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ownResult.classification.kind, "renamed");
  assert.equal(res.body.ownResult.classification.from, "compactness_criterion");
  assert.equal(res.body.ownResult.classification.to, "compactness_thm");

  // the actual fix: the job's cached identity now matches the file's real,
  // current declaration -- not what it was when first formalized
  assert.equal(state.jobs.a.declarationName, "compactness_thm");

  // unaffected by the fix: the pane's own identity for this item stays pinned
  // to the LaTeX label, so the cascade impact on the dependent is still
  // reported by that stable name, not the new Lean symbol
  assert.deepEqual(res.body.dependentsImpact[0].brokenByUpstream, { targetLabel: "compactness_criterion", renamed: true });
});

test("edit save: a proof-only edit never triggers a rebuild (no dependents to verify)", async () => {
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
      content: "theorem compactness_criterion : True := by\n  trivial\n"
    },
    state
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ownResult.classification.kind, "proof-only");
  assert.ok(!calls.some((c) => c.url.endsWith("/rebuild")));
});

test("edit save: fixing a previously-broken file re-verifies dependents even though the fix itself is proof-only", async () => {
  // Regression test for a real bug: classifyEdit/cascadeRequired only reason
  // about whether THIS edit could newly break a dependent -- a proof-only fix
  // is correctly exempt from that (proof irrelevance). But if the file was
  // previously broken and a dependent got left holding a stale "unconfirmed"
  // verdict (via the rebuild-failure fail-closed path), fixing the proof back
  // up must still re-verify that dependent, or its chip is stuck forever.
  const leaRepo = await makeLeaRepo();
  await writeProof(
    leaRepo,
    "Lea/Project1/compactness_corollary.lean",
    "import Lea.Project1.compactness_criterion\ntheorem compactness_corollary : True := by\n  sorry\n"
  );
  const calls = [];
  const state = makeState({
    leaRepo,
    jobs: {
      // Both previously left broken/unconfirmed by an earlier bad edit.
      a: editedJob({ lastEditCheckStatus: "error", lastEditCheckDetail: "unsolved goals" }),
      b: dependentJob({ lastEditCheckStatus: "error", lastEditCheckDetail: "Not re-verified: rebuilding compactness_criterion failed, so this dependent's status is unconfirmed." })
    },
    fetchImpl: makeEditFetch(calls, {
      sessionDetails: { "sess-a": EDITED_SESSION_DETAIL },
      writeResponses: { "sess-a": { unchanged: false, code_step: { id: "step-3" }, note: null } },
      checkResponses: {
        "sess-a": { path: "compactness_criterion.lean", status: "ok", detail: null },
        "sess-b": { path: "compactness_corollary.lean", status: "ok", detail: null }
      }
    })
  });

  const res = await handleLeanPaneEditSave(
    {
      overleafProjectId: "project-1",
      targetKind: "theorem",
      targetLabel: "compactness_criterion",
      // same header as EDITED_SESSION_DETAIL's -- proof-only fix
      content: "theorem compactness_criterion : True := by\n  trivial\n"
    },
    state
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ownResult.classification.kind, "proof-only");

  // A proof-only classification alone would normally skip the cascade -- but
  // this file just recovered from a failing state, so it must run anyway.
  const rebuildCalls = calls.filter((c) => c.url.endsWith("/sess-a/rebuild"));
  assert.equal(rebuildCalls.length, 1);
  const cascadeCall = calls.find((c) => c.url.endsWith("/sess-b/lean-check"));
  assert.ok(cascadeCall);

  assert.equal(res.body.dependentsImpact.length, 1);
  assert.equal(res.body.dependentsImpact[0].status, "reverified");

  // the dependent's stale "unconfirmed" chip is cleared back to ok, not left
  // stuck on the old verdict forever
  assert.equal(state.jobs.b.lastEditCheckStatus, "ok");
});

test("edit save: a proof-only edit to an already-healthy file still skips the cascade", async () => {
  // Companion regression guard: the recovery trigger must not turn EVERY
  // proof-only edit into a cascade -- only ones that actually recover from a
  // prior failure. Same content shape as the always-skip test above, but
  // explicit about why: lastEditCheckStatus was never "error" to begin with.
  const leaRepo = await makeLeaRepo();
  await writeProof(
    leaRepo,
    "Lea/Project1/compactness_corollary.lean",
    "import Lea.Project1.compactness_criterion\ntheorem compactness_corollary : True := by\n  sorry\n"
  );
  const calls = [];
  const state = makeState({
    leaRepo,
    jobs: { a: editedJob(), b: dependentJob() }, // no lastEditCheckStatus at all
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
      content: "theorem compactness_criterion : True := by\n  trivial\n"
    },
    state
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ownResult.classification.kind, "proof-only");
  assert.deepEqual(res.body.dependentsImpact, []);
  assert.ok(!calls.some((c) => c.url.includes("/sess-b/")));
});

test("edit save: a rebuild failure marks dependents unknown instead of trusting a stale recheck", async () => {
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
      checkResponses: { "sess-a": { path: "compactness_criterion.lean", status: "ok", detail: null } },
      // The fast own-check can pass (e.g. via sorry-recovery) even when a real
      // build of the same module fails outright.
      rebuildResponses: { "sess-a": { path: "compactness_criterion.lean", status: "error", detail: "compactness_criterion.lean:1:0: error: unexpected token" } }
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
  const impact = res.body.dependentsImpact[0];
  assert.equal(impact.targetLabel, "compactness_corollary");
  assert.equal(impact.status, "unknown");
  assert.match(impact.checkDetail, /unexpected token/);

  // never trusted a lean-check against the dependent once its own rebuild
  // failed -- no stale-olean-backed "still valid" gets reported
  assert.ok(!calls.some((c) => c.url.endsWith("/sess-b/lean-check")));

  // The dependent's own status CHIP (not just this impact message) must also
  // stop reading "valid" -- fail closed, same as a confirmed break, since
  // there's no separate "unconfirmed" chip state today. Regression guard: a
  // wrong chip is a different bug from a wrong message and needs its own check.
  assert.equal(state.jobs.b.lastEditCheckStatus, "error");
  assert.match(state.jobs.b.lastEditCheckDetail, /unconfirmed/);

  // End-to-end regression guard for the real bug: the data shape alone isn't
  // enough -- confirm what the pane actually RENDERS for this outcome is not
  // the same text as a genuine successful recheck. formatDependentOutcome had
  // no branch for status "unknown" and silently fell through to "re-checked,
  // still valid", which is exactly what was observed live even though the
  // rebuild correctly failed and the cascade correctly skipped the check.
  const rendered = formatDependentOutcome(impact);
  assert.doesNotMatch(rendered, /still valid/);
  assert.match(rendered, /could not be verified/);
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
