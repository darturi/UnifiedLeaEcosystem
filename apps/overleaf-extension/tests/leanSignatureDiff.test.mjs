import assert from "node:assert/strict";
import test from "node:test";
import { cascadeRequired, classifyEdit, parseDeclarationHeader } from "../companion/leanSignatureDiff.mjs";

test("parseDeclarationHeader extracts keyword/name/header for a theorem", () => {
  const content = "theorem compactness_criterion (n : Nat) (h : n > 0) : n ≥ 1 := by\n  sorry\n";
  const header = parseDeclarationHeader(content, "compactness_criterion");
  assert.equal(header.keyword, "theorem");
  assert.equal(header.name, "compactness_criterion");
  assert.equal(header.header, "theorem compactness_criterion (n : Nat) (h : n > 0) : n ≥ 1");
});

test("parseDeclarationHeader is not fooled by := inside a binder default value", () => {
  const content = "theorem foo (n : Nat := 0) : n ≥ 0 := by\n  positivity\n";
  const header = parseDeclarationHeader(content, "foo");
  assert.equal(header.header, "theorem foo (n : Nat := 0) : n ≥ 0");
});

test("parseDeclarationHeader normalizes whitespace/reformatting", () => {
  const a = parseDeclarationHeader("theorem foo\n  (n : Nat)\n  : n ≥ 0 := by\n  positivity\n", "foo");
  const b = parseDeclarationHeader("theorem   foo (n : Nat) :   n ≥ 0 := by positivity\n", "foo");
  assert.equal(a.header, b.header);
});

test("parseDeclarationHeader falls back to the first declaration when the named one isn't found", () => {
  const content = "theorem compactness_criterion' (n : Nat) : n ≥ 0 := by\n  sorry\n";
  const header = parseDeclarationHeader(content, "compactness_criterion");
  assert.equal(header.name, "compactness_criterion'");
});

test("parseDeclarationHeader returns null when nothing matches at all", () => {
  assert.equal(parseDeclarationHeader("-- just a comment, no declaration\n", "foo"), null);
});

test("classifyEdit: proof-body-only edit to a theorem is proof-only (never cascades)", () => {
  const before = parseDeclarationHeader("theorem foo (n : Nat) : n ≥ 0 := by\n  sorry\n", "foo");
  const after = parseDeclarationHeader("theorem foo (n : Nat) : n ≥ 0 := by\n  exact Nat.zero_le n\n", "foo");
  const classification = classifyEdit({ before, after, expectedName: "foo" });
  assert.deepEqual(classification, { kind: "proof-only" });
  assert.equal(cascadeRequired(classification), false);
});

test("classifyEdit: hypothesis/conclusion change to a theorem is a signature change", () => {
  const before = parseDeclarationHeader("theorem foo (n : Nat) : n ≥ 0 := by\n  sorry\n", "foo");
  const after = parseDeclarationHeader("theorem foo (n : Nat) (h : n > 0) : n ≥ 1 := by\n  sorry\n", "foo");
  const classification = classifyEdit({ before, after, expectedName: "foo" });
  assert.deepEqual(classification, { kind: "signature" });
  assert.equal(cascadeRequired(classification), true);
});

test("classifyEdit: renaming the declaration is reported distinctly from a same-name signature change", () => {
  const before = parseDeclarationHeader("theorem foo (n : Nat) : n ≥ 0 := by\n  sorry\n", "foo");
  const afterContent = "theorem foo2 (n : Nat) : n ≥ 0 := by\n  sorry\n";
  const after = parseDeclarationHeader(afterContent, "foo") || parseDeclarationHeader(afterContent);
  const classification = classifyEdit({ before, after, expectedName: "foo" });
  assert.deepEqual(classification, { kind: "renamed", from: "foo", to: "foo2" });
  assert.equal(cascadeRequired(classification), true);
});

test("classifyEdit: any edit to a def's body cascades even with an unchanged signature (definitional unfolding)", () => {
  const before = parseDeclarationHeader("def locally_finite_family : Prop := True\n", "locally_finite_family");
  const after = parseDeclarationHeader("def locally_finite_family : Prop := False\n", "locally_finite_family");
  const classification = classifyEdit({ before, after, expectedName: "locally_finite_family" });
  assert.deepEqual(classification, { kind: "definition-body" });
  assert.equal(cascadeRequired(classification), true);
});

test("classifyEdit: an abbrev is treated the same as a def", () => {
  const before = parseDeclarationHeader("abbrev alias : Prop := True\n", "alias");
  const after = parseDeclarationHeader("abbrev alias : Prop := False\n", "alias");
  assert.deepEqual(classifyEdit({ before, after, expectedName: "alias" }), { kind: "definition-body" });
});

test("classifyEdit: own check failing after the edit always cascades, taking priority", () => {
  const before = parseDeclarationHeader("theorem foo (n : Nat) : n ≥ 0 := by\n  sorry\n", "foo");
  const after = parseDeclarationHeader("theorem foo (n : Nat) : n ≥ 0 := by\n  sorry\n", "foo");
  const classification = classifyEdit({ before, after, expectedName: "foo", ownCheckFailed: true });
  assert.deepEqual(classification, { kind: "own-check-failed" });
  assert.equal(cascadeRequired(classification), true);
});

test("classifyEdit: an unparseable header on either side fails toward over-cascading", () => {
  const before = parseDeclarationHeader("theorem foo (n : Nat) : n ≥ 0 := by\n  sorry\n", "foo");
  const classification = classifyEdit({ before, after: null, expectedName: "foo" });
  assert.deepEqual(classification, { kind: "signature" });
  assert.equal(cascadeRequired(classification), true);
});
