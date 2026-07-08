import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregatePaneStatus,
  buildLeanPaneTree,
  canEditPaneItem,
  canFormalizePaneItem,
  canStubPaneItem,
  canViewPaneItemInLeaUi,
  canRepairPaneItem,
  capitalize,
  formatBreakageAttribution,
  formatDependentOutcome,
  formatDependentsImpact,
  formatRepairOutcome,
  formatLiteMath,
  formatPaneStatus,
  hasInProgressItems,
  highlightLeanLine,
  overlayActiveTex,
  paneItemActions,
  paneItemToEditTarget,
  paneItemToFormalizeTarget,
  deriveShareControls,
  filenameFromContentDisposition,
  parsePaneLatex,
  reconcileDependentsImpact,
  shouldRefetchLeanPaneFiles,
  stillBrokenDependents,
  treeAncestorIdsForFile
} from "../extension/leanPaneView.mjs";

test("formatPaneStatus maps known statuses and falls back to unknown", () => {
  assert.equal(formatPaneStatus("missing-stub"), "missing stub");
  assert.equal(formatPaneStatus("stub-generated"), "stub generated");
  assert.equal(formatPaneStatus("valid"), "valid");
  assert.equal(formatPaneStatus("defined"), "defined");
  assert.equal(formatPaneStatus("disproved"), "counterexample");
  assert.equal(formatPaneStatus("in-progress"), "in progress");
  assert.equal(formatPaneStatus("stale"), "stale");
  assert.equal(formatPaneStatus("mixed"), "mixed");
  assert.equal(formatPaneStatus("nonsense"), "unknown");
  assert.equal(formatPaneStatus(undefined), "unknown");
});

test("capitalize uppercases the first character only", () => {
  assert.equal(capitalize("theorem"), "Theorem");
  assert.equal(capitalize(""), "");
  assert.equal(capitalize(undefined), "");
});

test("shouldRefetchLeanPaneFiles forces a fetch on explicit request, empty cache, or project switch", () => {
  const lastFiles = [{ path: "main.tex", content: "x" }];
  assert.equal(shouldRefetchLeanPaneFiles({ forceFetch: true, lastFiles, lastProjectId: "p", projectId: "p" }), true);
  assert.equal(shouldRefetchLeanPaneFiles({ forceFetch: false, lastFiles: null, lastProjectId: "p", projectId: "p" }), true);
  assert.equal(shouldRefetchLeanPaneFiles({ forceFetch: false, lastFiles: [], lastProjectId: "p", projectId: "p" }), true);
  assert.equal(shouldRefetchLeanPaneFiles({ forceFetch: false, lastFiles, lastProjectId: "p", projectId: "q" }), true);
});

test("shouldRefetchLeanPaneFiles reuses the cache for same-project edits", () => {
  const lastFiles = [{ path: "main.tex", content: "x" }];
  assert.equal(shouldRefetchLeanPaneFiles({ forceFetch: false, lastFiles, lastProjectId: "p", projectId: "p" }), false);
});

test("overlayActiveTex overrides existing files only and never invents paths", () => {
  const files = [{ path: "main.tex", content: "old" }, { path: "intro.tex", content: "keep" }];
  overlayActiveTex(files, "/main.tex", "new");
  assert.equal(files.find((f) => f.path === "main.tex").content, "new");
  assert.equal(files.find((f) => f.path === "intro.tex").content, "keep");

  overlayActiveTex(files, "missing.tex", "ghost");
  assert.equal(files.length, 2);

  overlayActiveTex(files, "", "noop");
  assert.equal(files.find((f) => f.path === "main.tex").content, "new");
});

test("hasInProgressItems detects any in-progress item", () => {
  assert.equal(hasInProgressItems([{ inProgress: false }, { inProgress: true }]), true);
  assert.equal(hasInProgressItems([{ inProgress: false }]), false);
  assert.equal(hasInProgressItems([]), false);
  assert.equal(hasInProgressItems(undefined), false);
});

test("canFormalizePaneItem requires a valid marker, an actionable state, and no active run", () => {
  const base = { formalizable: true, inProgress: false, status: "missing-stub" };
  assert.equal(canFormalizePaneItem(base), true);
  assert.equal(canFormalizePaneItem({ ...base, status: "stale" }), true);
  assert.equal(canFormalizePaneItem({ ...base, status: "invalid" }), true);
  // Terminal-good states and running jobs are not re-formalizable from the pane.
  assert.equal(canFormalizePaneItem({ ...base, status: "valid" }), false);
  assert.equal(canFormalizePaneItem({ ...base, status: "defined" }), false);
  assert.equal(canFormalizePaneItem({ ...base, status: "disproved" }), false);
  assert.equal(canFormalizePaneItem({ ...base, inProgress: true }), false);
  // A malformed marker (no valid target) is not formalizable.
  assert.equal(canFormalizePaneItem({ ...base, formalizable: false }), false);
  assert.equal(canFormalizePaneItem(undefined), false);
});

test("canStubPaneItem offers sorry-stubbing only for an unformalized theorem", () => {
  const base = { formalizable: true, inProgress: false, status: "missing-stub", leanKind: "theorem" };
  assert.equal(canStubPaneItem(base), true);
  // Definitions always get a full body from Formalize; there is no stub form.
  assert.equal(canStubPaneItem({ ...base, leanKind: "def" }), false);
  // Once any artifact exists (stub or proof), Formalize is the right action.
  assert.equal(canStubPaneItem({ ...base, status: "stub-generated" }), false);
  assert.equal(canStubPaneItem({ ...base, status: "valid" }), false);
  assert.equal(canStubPaneItem({ ...base, status: "stale" }), false);
  assert.equal(canStubPaneItem({ ...base, inProgress: true }), false);
  assert.equal(canStubPaneItem({ ...base, formalizable: false }), false);
  assert.equal(canStubPaneItem(undefined), false);
});

test("canViewPaneItemInLeaUi requires a target identity and a real run or artifact", () => {
  const base = { label: "thm:main", status: "valid" };
  assert.equal(canViewPaneItemInLeaUi(base), true);
  assert.equal(canViewPaneItemInLeaUi({ ...base, status: "defined" }), true);
  assert.equal(canViewPaneItemInLeaUi({ ...base, status: "disproved" }), true);
  assert.equal(canViewPaneItemInLeaUi({ ...base, status: "needs-review" }), false);
  assert.equal(canViewPaneItemInLeaUi({ ...base, status: "in-progress" }), true);
  assert.equal(canViewPaneItemInLeaUi({ ...base, status: "stub-generated" }), true);
  assert.equal(canViewPaneItemInLeaUi({ ...base, status: "stale" }), true);
  assert.equal(canViewPaneItemInLeaUi({ ...base, status: "invalid" }), true);
  // Never-formalized or indeterminate items must not appear viewable.
  assert.equal(canViewPaneItemInLeaUi({ ...base, status: "missing-stub" }), false);
  assert.equal(canViewPaneItemInLeaUi({ ...base, status: "unknown" }), false);
  assert.equal(canViewPaneItemInLeaUi({ ...base, status: "error" }), false);
  // Without a declaration name or label the session can't be resolved.
  assert.equal(canViewPaneItemInLeaUi({ status: "valid" }), false);
  assert.equal(canViewPaneItemInLeaUi(undefined), false);
});

test("paneItemActions puts Formalize primary with Stub in the overflow for an unformalized theorem", () => {
  const item = { formalizable: true, inProgress: false, status: "missing-stub", leanKind: "theorem", label: "thm:main" };
  const actions = paneItemActions(item);
  assert.deepEqual(actions.primary, { id: "formalize", label: "Formalize" });
  assert.deepEqual(actions.rail.map((action) => action.id), ["go-to-source", "chat"]);
  assert.deepEqual(actions.overflow.map((action) => action.id), ["stub"]);
});

test("paneItemActions promotes Repair over Re-formalize on a broken item and keeps both reachable", () => {
  const item = {
    formalizable: true,
    inProgress: false,
    status: "invalid",
    leanKind: "theorem",
    label: "thm:dep",
    leanDeclarationName: "dep_theorem",
    leanArtifactContent: "theorem dep_theorem : True := by trivial",
    breakage: { upstreamLabel: "upstream", via: "edit" }
  };
  const actions = paneItemActions(item);
  assert.equal(actions.primary.id, "repair");
  // Repair takes the primary slot, but Re-formalize and Edit stay reachable.
  assert.deepEqual(actions.overflow.map((action) => action.label), ["Re-formalize", "Edit"]);
  assert.deepEqual(actions.rail.map((action) => action.id), ["go-to-source", "chat", "view-in-lea"]);
});

test("paneItemActions leaves a settled valid item with no primary action", () => {
  const item = {
    formalizable: true,
    inProgress: false,
    status: "valid",
    leanKind: "theorem",
    label: "thm:main",
    leanDeclarationName: "main_theorem",
    leanArtifactContent: "theorem main_theorem : True := by trivial"
  };
  const actions = paneItemActions(item);
  assert.equal(actions.primary, null);
  assert.deepEqual(actions.rail.map((action) => action.id), ["go-to-source", "chat", "view-in-lea"]);
  assert.deepEqual(actions.overflow.map((action) => action.id), ["edit"]);
});

test("paneItemActions suppresses state-changing actions while the item is being edited or running", () => {
  const broken = {
    formalizable: true,
    inProgress: false,
    status: "invalid",
    label: "thm:x",
    leanArtifactContent: "theorem x : True := by trivial",
    breakage: { upstreamLabel: "up", via: "edit" }
  };
  const whileEditing = paneItemActions(broken, { editing: true });
  assert.equal(whileEditing.primary, null);
  assert.deepEqual(whileEditing.overflow, []);

  const running = paneItemActions({ formalizable: true, inProgress: true, status: "in-progress", label: "thm:x" });
  assert.equal(running.primary, null);
  assert.deepEqual(running.overflow, []);
  assert.deepEqual(running.rail.map((action) => action.id), ["go-to-source", "chat", "view-in-lea"]);
});

test("paneItemToFormalizeTarget shapes the /formalize payload from a pane item", () => {
  const target = paneItemToFormalizeTarget({
    leanKind: "def",
    leanDeclarationName: "even_nat",
    label: "even_nat",
    naturalLanguageLatex: "A natural number is even...",
    targetUses: ["parity"],
    targetContext: "Use Nat parity."
  });
  assert.deepEqual(target, {
    targetKind: "definition",
    targetLabel: "even_nat",
    targetText: "A natural number is even...",
    targetUses: ["parity"],
    targetContext: "Use Nat parity."
  });

  const theorem = paneItemToFormalizeTarget({ leanKind: "theorem", label: "thm", naturalLanguageLatex: "X" });
  assert.equal(theorem.targetKind, "theorem");
  assert.deepEqual(theorem.targetUses, []);
  assert.equal(theorem.targetContext, "");
});

test("buildLeanPaneTree groups files into a compact source tree", () => {
  const tree = buildLeanPaneTree([
    { id: "defs", sourceFile: "sections/defs.tex", documentOrder: 2, status: "missing-stub" },
    { id: "main", sourceFile: "main.tex", documentOrder: 0, status: "valid" },
    { id: "intro", sourceFile: "sections/intro.tex", documentOrder: 1, status: "stale" }
  ]);

  assert.deepEqual(tree.children.map((node) => node.name), ["main.tex", "sections"]);
  assert.equal(tree.children[0].type, "file");
  assert.equal(tree.children[0].itemCount, 1);
  assert.equal(tree.children[1].type, "folder");
  assert.deepEqual(tree.children[1].children.map((node) => node.path), ["sections/intro.tex", "sections/defs.tex"]);
  assert.deepEqual(tree.files.map((node) => node.path), ["main.tex", "sections/intro.tex", "sections/defs.tex"]);
});

test("buildLeanPaneTree omits files with no manifest items and preserves item order", () => {
  const tree = buildLeanPaneTree([
    { id: "b", sourceFile: "main.tex", documentOrder: 2, status: "valid" },
    { id: "a", sourceFile: "main.tex", documentOrder: 1, status: "valid" }
  ]);

  assert.equal(tree.files.length, 1);
  assert.deepEqual(tree.files[0].items.map((item) => item.id), ["a", "b"]);
});

test("aggregatePaneStatus applies file status precedence", () => {
  assert.equal(aggregatePaneStatus([{ status: "valid" }, { status: "in-progress" }]), "in-progress");
  assert.equal(aggregatePaneStatus([{ status: "valid" }, { status: "error" }, { status: "invalid" }]), "error");
  assert.equal(aggregatePaneStatus([{ status: "valid" }, { status: "invalid" }]), "invalid");
  assert.equal(aggregatePaneStatus([{ status: "valid" }, { status: "stale" }]), "stale");
  assert.equal(aggregatePaneStatus([{ status: "stub-generated" }, { status: "missing-stub" }]), "missing-stub");
  assert.equal(aggregatePaneStatus([{ status: "stub-generated" }]), "stub-generated");
  assert.equal(aggregatePaneStatus([{ status: "valid" }, { status: "valid" }]), "valid");
  assert.equal(aggregatePaneStatus([{ status: "defined" }, { status: "defined" }]), "defined");
  assert.equal(aggregatePaneStatus([{ status: "valid" }, { status: "defined" }, { status: "disproved" }]), "mixed");
});

test("treeAncestorIdsForFile returns expandable folder and file ids", () => {
  assert.deepEqual(treeAncestorIdsForFile("sections/defs.tex"), ["folder:sections", "file:sections/defs.tex"]);
  assert.deepEqual(treeAncestorIdsForFile("/main.tex"), ["file:main.tex"]);
});

test("parsePaneLatex splits inline and display math delimiters", () => {
  assert.deepEqual(parsePaneLatex("Let $x \\in \\mathbb{R}$ and \\[x^2 \\ge 0\\]."), [
    { type: "text", text: "Let " },
    { type: "math", text: "x \\in \\mathbb{R}", display: false },
    { type: "text", text: " and " },
    { type: "math", text: "x^2 \\ge 0", display: true },
    { type: "text", text: "." }
  ]);

  assert.deepEqual(parsePaneLatex("Use $$a_n\\to 0$$ now."), [
    { type: "text", text: "Use " },
    { type: "math", text: "a_n\\to 0", display: true },
    { type: "text", text: " now." }
  ]);
});

test("parsePaneLatex leaves unmatched delimiters as readable text", () => {
  assert.deepEqual(parsePaneLatex("Cost is \\$5 and $unfinished."), [
    { type: "text", text: "Cost is \\$5 and $unfinished." }
  ]);
});

test("formatLiteMath prettifies common theorem math without dependencies", () => {
  assert.deepEqual(formatLiteMath("\\forall x \\in \\mathbb{R}, x^2 \\ge 0"), [
    { type: "text", text: "∀ x ∈ ℝ, x" },
    { type: "sup", text: "2" },
    { type: "text", text: " ≥ 0" }
  ]);

  assert.deepEqual(formatLiteMath("a_{n+1} \\to \\alpha"), [
    { type: "text", text: "a" },
    { type: "sub", text: "n+1" },
    { type: "text", text: " → α" }
  ]);
});

test("formatLiteMath keeps unknown commands visible as fallback text", () => {
  assert.deepEqual(formatLiteMath("\\Spec R \\subseteq X"), [
    { type: "text", text: "Spec R ⊆ X" }
  ]);
});

test("canEditPaneItem requires a recorded artifact", () => {
  assert.equal(canEditPaneItem({ leanArtifactContent: "theorem foo : True := by trivial" }), true);
  assert.equal(canEditPaneItem({ leanArtifactContent: "" }), false);
  assert.equal(canEditPaneItem({}), false);
  assert.equal(canEditPaneItem(null), false);
});

test("paneItemToEditTarget shapes a theorem/definition target from a pane item", () => {
  assert.deepEqual(
    paneItemToEditTarget({ leanKind: "theorem", leanDeclarationName: "compactness_criterion" }, "project-1"),
    { overleafProjectId: "project-1", targetKind: "theorem", targetLabel: "compactness_criterion" }
  );
  assert.deepEqual(
    paneItemToEditTarget({ leanKind: "def", label: "locally_finite_family" }, "project-1"),
    { overleafProjectId: "project-1", targetKind: "definition", targetLabel: "locally_finite_family" }
  );
});

test("formatDependentsImpact summarizes an empty or non-empty dependents list", () => {
  assert.equal(formatDependentsImpact([]), "");
  assert.equal(formatDependentsImpact(null), "");
  assert.equal(
    formatDependentsImpact([{ targetLabel: "corollary_a" }]),
    "Editing this may affect 1 downstream item: corollary_a."
  );
  assert.equal(
    formatDependentsImpact([{ targetLabel: "corollary_a" }, { targetLabel: "corollary_b" }]),
    "Editing this may affect 2 downstream items: corollary_a, corollary_b."
  );
});

test("formatDependentOutcome distinguishes broken/renamed/busy/unattributed/still-valid outcomes", () => {
  assert.equal(
    formatDependentOutcome({ targetLabel: "a", busy: true }),
    "a: not re-checked yet (a Lea run is already in progress for it)."
  );
  assert.equal(
    formatDependentOutcome({ targetLabel: "a", brokenByUpstream: { renamed: true } }),
    "a: broken -- the declaration it referred to was renamed."
  );
  assert.equal(
    formatDependentOutcome({ targetLabel: "a", brokenByUpstream: { renamed: false } }),
    "a: broken by this edit."
  );
  assert.equal(
    formatDependentOutcome({ targetLabel: "a", attributed: false }),
    "a: may be affected, but no recorded session was found to re-check it."
  );
  assert.equal(
    formatDependentOutcome({ targetLabel: "a", attributed: true, brokenByUpstream: null }),
    "a: re-checked, still valid."
  );
  assert.equal(formatDependentOutcome(null), "");
});

// Regression test for a real bug caught live: a dependent that was never
// actually re-checked (its upstream module's rebuild failed, or the
// per-dependent check call itself errored) must not render the same text as
// a genuinely successful recheck -- `status: "unknown"` has to take priority
// over the "attributed, not busy, not broken -> still valid" default.
test("formatDependentOutcome distinguishes 'could not verify' from a genuine still-valid recheck", () => {
  assert.equal(
    formatDependentOutcome({
      targetLabel: "epsilon_two",
      status: "unknown",
      attributed: true,
      busy: false,
      brokenByUpstream: null,
      checkDetail: "error: lake build failed for Lea.Proj.epsilon_one (exit 1): ..."
    }),
    "epsilon_two: could not be verified (error: lake build failed for Lea.Proj.epsilon_one (exit 1): ...) -- treat as unconfirmed, not as valid."
  );
  // Same outcome without a detail message still reads as "unconfirmed", not "valid".
  assert.equal(
    formatDependentOutcome({ targetLabel: "epsilon_two", status: "unknown", attributed: true, busy: false, brokenByUpstream: null }),
    "epsilon_two: could not be verified -- treat as unconfirmed, not as valid."
  );
  // A genuine successful recheck (status "reverified", not "unknown") is unaffected.
  assert.equal(
    formatDependentOutcome({ targetLabel: "a", status: "reverified", attributed: true, busy: false, brokenByUpstream: null }),
    "a: re-checked, still valid."
  );
});

test("highlightLeanLine marks Lean keywords, comments, strings, numbers, and types", () => {
  const spans = highlightLeanLine('theorem foo : Nat := 2 -- "note"');
  assert.equal(spans.find((span) => span.text === "theorem")?.cls, "kw");
  assert.equal(spans.find((span) => span.text === "Nat")?.cls, "ty");
  assert.equal(spans.find((span) => span.text === "2")?.cls, "num");
  assert.equal(spans.find((span) => span.text.startsWith("--"))?.cls, "com");

  const stringSpans = highlightLeanLine('open "Mathlib"');
  assert.equal(stringSpans.find((span) => span.text === '"Mathlib"')?.cls, "str");
});

test("deriveShareControls gates Save on a changed draft and Push on remote+token", () => {
  // No Lea project yet: everything off, with the formalize-first hint.
  const missing = deriveShareControls({ exists: false, remoteUrl: null, tokenConfigured: true });
  assert.equal(missing.canSave, false);
  assert.equal(missing.canPush, false);
  assert.match(missing.hint, /formalize a theorem first/i);

  // Project, no remote: Save enables once a draft is typed; Push stays off.
  const untouched = deriveShareControls({ exists: true, remoteUrl: null, tokenConfigured: true });
  assert.equal(untouched.canSave, false);
  assert.match(untouched.hint, /Save a GitHub remote/);
  const drafted = deriveShareControls({
    exists: true, remoteUrl: null, draftRemote: "https://github.com/me/doc", tokenConfigured: true
  });
  assert.equal(drafted.canSave, true);
  assert.equal(drafted.canPush, false);

  // Saved remote + token: Push on; Save off until the draft diverges from saved.
  const ready = deriveShareControls({
    exists: true, remoteUrl: "https://github.com/me/doc", tokenConfigured: true
  });
  assert.equal(ready.canSave, false);
  assert.equal(ready.canPush, true);
  assert.equal(ready.hint, "");

  // Saved remote, no token: Push off with the settings hint.
  const tokenless = deriveShareControls({
    exists: true, remoteUrl: "https://github.com/me/doc", tokenConfigured: false
  });
  assert.equal(tokenless.canPush, false);
  assert.match(tokenless.hint, /GitHub token in Settings/);

  // A request in flight disables both.
  const busy = deriveShareControls({
    exists: true, remoteUrl: "https://github.com/me/doc",
    draftRemote: "https://github.com/me/other", tokenConfigured: true, busy: true
  });
  assert.equal(busy.canSave, false);
  assert.equal(busy.canPush, false);
});

test("filenameFromContentDisposition extracts the quoted filename or falls back", () => {
  assert.equal(
    filenameFromContentDisposition('attachment; filename="doc-1.zip"'),
    "doc-1.zip"
  );
  assert.equal(filenameFromContentDisposition(null, "lean-project.zip"), "lean-project.zip");
  assert.equal(filenameFromContentDisposition("attachment", "x.zip"), "x.zip");
});

// --- Self-repair helpers (docs/FEATURE-overleaf-self-repair.md, Phase 5) ---

test("canRepairPaneItem gates on breakage, suppression, in-progress, and a running repair", () => {
  const breakage = { upstreamLabel: "a", repair: { state: "offered" } };
  assert.equal(canRepairPaneItem({ status: "invalid", breakage }), true);
  assert.equal(canRepairPaneItem({ status: "invalid" }), false);
  assert.equal(canRepairPaneItem({ status: "invalid", breakage: { ...breakage, repairSuppressed: "upstream_broken" } }), false);
  assert.equal(canRepairPaneItem({ status: "in-progress", breakage }), false);
  assert.equal(canRepairPaneItem({ status: "invalid", breakage: { ...breakage, repair: { state: "running" } } }), false);
  // a previously failed repair can be retried
  assert.equal(canRepairPaneItem({ status: "invalid", breakage: { ...breakage, repair: { state: "failed" } } }), true);
});

test("formatBreakageAttribution distinguishes self-break, rename, suppression, and generic upstream breaks", () => {
  assert.equal(
    formatBreakageAttribution({ selfBroken: true, via: "edit" }),
    "Broken by a manual edit to this item."
  );
  assert.match(
    formatBreakageAttribution({ classificationKind: "renamed", renamedFrom: "a", renamedTo: "b", via: "chat" }),
    /`a` was renamed to `b` \(via a chat request\)\. This item still refers to the old name\./
  );
  assert.match(
    formatBreakageAttribution({ upstreamLabel: "a", repairSuppressed: "upstream_broken", via: "formalize" }),
    /repair a first/i
  );
  assert.equal(
    formatBreakageAttribution({ upstreamLabel: "a", classificationKind: "signature", via: "formalize" }),
    "Broken by a re-formalization to a."
  );
});

test("formatRepairOutcome covers every batch item state", () => {
  assert.equal(formatRepairOutcome({ targetLabel: "b", state: "pending" }), "b: waiting.");
  assert.equal(formatRepairOutcome({ targetLabel: "b", state: "running" }), "b: repairing...");
  assert.equal(formatRepairOutcome({ targetLabel: "b", state: "repaired" }), "b: repaired and verified.");
  assert.match(formatRepairOutcome({ targetLabel: "b", state: "needs_review" }), /review required/);
  assert.match(formatRepairOutcome({ targetLabel: "b", state: "failed", reason: "unprovable" }), /repair failed -- unprovable/);
  assert.match(
    formatRepairOutcome({ targetLabel: "c", state: "skipped", reason: "depends_on_failed:b" }),
    /skipped -- depends on failed repair of b\./
  );
  assert.match(formatRepairOutcome({ targetLabel: "c", state: "skipped", reason: "already_fixed" }), /already compiles/);
});

// --- Stale-offer reconciliation (docs/PLAN-self-repair-stale-offers.md) ----

test("reconcileDependentsImpact: fixed, still-broken, repairing, and unmatched dependents", () => {
  const dependents = [
    { targetLabel: "fixed_one", brokenByUpstream: { targetLabel: "a" } },
    { targetLabel: "still_broken", brokenByUpstream: { targetLabel: "a" } },
    { targetLabel: "repairing_now", brokenByUpstream: { targetLabel: "a" } },
    { targetLabel: "not_in_manifest", brokenByUpstream: { targetLabel: "a" } }
  ];
  const items = [
    { leanDeclarationName: "fixed_one", status: "valid" },
    { leanDeclarationName: "still_broken", status: "invalid", breakage: { upstreamLabel: "a" } },
    { leanDeclarationName: "repairing_now", status: "invalid", breakage: { upstreamLabel: "a", repair: { state: "running" } } }
  ];
  const out = reconcileDependentsImpact(dependents, items);
  const byLabel = Object.fromEntries(out.map((d) => [d.targetLabel, d]));
  assert.deepEqual(
    [byLabel.fixed_one.sinceFixed, byLabel.fixed_one.nowRepairing, byLabel.fixed_one.matched],
    [true, false, true]
  );
  assert.deepEqual(
    [byLabel.still_broken.sinceFixed, byLabel.still_broken.nowRepairing],
    [false, false]
  );
  assert.deepEqual(
    [byLabel.repairing_now.sinceFixed, byLabel.repairing_now.nowRepairing],
    [false, true]
  );
  // unmatched: snapshot state kept, offer stays (fail toward offering)
  assert.deepEqual(
    [byLabel.not_in_manifest.sinceFixed, byLabel.not_in_manifest.matched],
    [false, false]
  );
});

test("reconcileDependentsImpact: an invalid item with no breakage is NOT counted as fixed, and label matching also works", () => {
  const out = reconcileDependentsImpact(
    [{ targetLabel: "broken_other_way", brokenByUpstream: { targetLabel: "a" } }],
    [{ label: "broken_other_way", status: "invalid" }] // matched by label, still invalid
  );
  assert.equal(out[0].matched, true);
  assert.equal(out[0].sinceFixed, false);
});

test("stillBrokenDependents keeps only currently-broken entries", () => {
  const out = stillBrokenDependents([
    { targetLabel: "a", brokenByUpstream: {}, sinceFixed: false, nowRepairing: false },
    { targetLabel: "b", brokenByUpstream: {}, sinceFixed: true, nowRepairing: false },
    { targetLabel: "c", brokenByUpstream: {}, sinceFixed: false, nowRepairing: true },
    { targetLabel: "d", brokenByUpstream: null, sinceFixed: false, nowRepairing: false }
  ]);
  assert.deepEqual(out.map((d) => d.targetLabel), ["a"]);
});

test("formatDependentOutcome appends since-fixed / repair-in-progress only to lines that claimed a problem", () => {
  assert.equal(
    formatDependentOutcome({ targetLabel: "b", brokenByUpstream: { renamed: false }, sinceFixed: true }),
    "b: broken by this edit -- since fixed."
  );
  assert.equal(
    formatDependentOutcome({ targetLabel: "b", brokenByUpstream: { renamed: false }, nowRepairing: true }),
    "b: broken by this edit -- repair in progress."
  );
  assert.match(
    formatDependentOutcome({ targetLabel: "b", busy: true, sinceFixed: true }),
    /not re-checked yet.*-- since fixed\.$/
  );
  // history is never rewritten on lines that claimed no problem
  assert.equal(
    formatDependentOutcome({ targetLabel: "b", status: "reverified", attributed: true, sinceFixed: true }),
    "b: re-checked, still valid."
  );
});

// --- Round 2: bidirectional reconciliation (the busy-skipped dependent) ----

test("reconcileDependentsImpact upgrades a snapshot-busy entry to nowBroken when live truth says so", () => {
  const dependents = [
    { targetLabel: "busy_then_broken", busy: true, brokenByUpstream: null },
    { targetLabel: "busy_then_fixed", busy: true, brokenByUpstream: null },
    { targetLabel: "busy_still_running", busy: true, brokenByUpstream: null },
    { targetLabel: "busy_but_suppressed", busy: true, brokenByUpstream: null }
  ];
  const items = [
    { leanDeclarationName: "busy_then_broken", status: "invalid", breakage: { upstreamLabel: "a", repair: { state: "failed" } } },
    { leanDeclarationName: "busy_then_fixed", status: "valid" },
    { leanDeclarationName: "busy_still_running", status: "in-progress", breakage: { upstreamLabel: "a", repair: { state: "running" } } },
    { leanDeclarationName: "busy_but_suppressed", status: "invalid", breakage: { upstreamLabel: "a", repairSuppressed: "upstream_broken" } }
  ];
  const byLabel = Object.fromEntries(reconcileDependentsImpact(dependents, items).map((d) => [d.targetLabel, d]));
  assert.equal(byLabel.busy_then_broken.nowBroken, true);
  assert.equal(byLabel.busy_then_fixed.nowBroken, false);
  assert.equal(byLabel.busy_then_fixed.sinceFixed, true);
  assert.equal(byLabel.busy_still_running.nowBroken, false);
  assert.equal(byLabel.busy_still_running.nowRepairing, true);
  assert.equal(byLabel.busy_but_suppressed.nowBroken, false); // offering it would be a server 409
});

test("stillBrokenDependents decides from live truth for matched entries, in BOTH directions", () => {
  const out = stillBrokenDependents([
    // snapshot busy, live broken -> offered (the reported round-2 case)
    { targetLabel: "a", busy: true, brokenByUpstream: null, matched: true, nowBroken: true, sinceFixed: false, nowRepairing: false },
    // snapshot broken, live fixed -> not offered (round 1)
    { targetLabel: "b", brokenByUpstream: {}, matched: true, nowBroken: false, sinceFixed: true, nowRepairing: false },
    // snapshot broken, live still broken -> offered
    { targetLabel: "c", brokenByUpstream: {}, matched: true, nowBroken: true, sinceFixed: false, nowRepairing: false },
    // unmatched snapshot-broken -> offered (fail toward offering)
    { targetLabel: "d", brokenByUpstream: {}, matched: false, nowBroken: false, sinceFixed: false, nowRepairing: false }
  ]);
  assert.deepEqual(out.map((d) => d.targetLabel), ["a", "c", "d"]);
});

test("formatDependentOutcome corrects a stale busy line when the item is now broken", () => {
  assert.equal(
    formatDependentOutcome({ targetLabel: "b", busy: true, nowBroken: true }),
    "b: was busy during this edit's re-check -- now broken."
  );
  assert.equal(
    formatDependentOutcome({ targetLabel: "b", status: "reverified", attributed: true, nowBroken: true }),
    "b: re-checked, still valid -- now broken."
  );
});
