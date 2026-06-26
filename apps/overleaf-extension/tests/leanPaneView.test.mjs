import assert from "node:assert/strict";
import test from "node:test";
import {
  canFormalizePaneItem,
  capitalize,
  formatPaneStatus,
  hasInProgressItems,
  overlayActiveTex,
  paneItemToFormalizeTarget,
  shouldRefetchLeanPaneFiles
} from "../extension/leanPaneView.mjs";

test("formatPaneStatus maps known statuses and falls back to unknown", () => {
  assert.equal(formatPaneStatus("missing-stub"), "missing stub");
  assert.equal(formatPaneStatus("stub-generated"), "stub generated");
  assert.equal(formatPaneStatus("valid"), "valid");
  assert.equal(formatPaneStatus("defined"), "defined");
  assert.equal(formatPaneStatus("disproved"), "counterexample");
  assert.equal(formatPaneStatus("in-progress"), "in progress");
  assert.equal(formatPaneStatus("stale"), "stale");
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
