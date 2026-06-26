import assert from "node:assert/strict";
import test from "node:test";
import {
  capitalize,
  formatPaneStatus,
  hasInProgressItems,
  overlayActiveTex,
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
