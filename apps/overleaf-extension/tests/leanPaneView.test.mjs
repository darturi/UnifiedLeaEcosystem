import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregatePaneStatus,
  buildLeanPaneTree,
  canFormalizePaneItem,
  capitalize,
  formatLiteMath,
  formatPaneStatus,
  hasInProgressItems,
  highlightLeanLine,
  overlayActiveTex,
  paneItemToFormalizeTarget,
  parsePaneLatex,
  shouldRefetchLeanPaneFiles,
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

test("highlightLeanLine marks Lean keywords, comments, strings, numbers, and types", () => {
  const spans = highlightLeanLine('theorem foo : Nat := 2 -- "note"');
  assert.equal(spans.find((span) => span.text === "theorem")?.cls, "kw");
  assert.equal(spans.find((span) => span.text === "Nat")?.cls, "ty");
  assert.equal(spans.find((span) => span.text === "2")?.cls, "num");
  assert.equal(spans.find((span) => span.text.startsWith("--"))?.cls, "com");

  const stringSpans = highlightLeanLine('open "Mathlib"');
  assert.equal(stringSpans.find((span) => span.text === '"Mathlib"')?.cls, "str");
});
