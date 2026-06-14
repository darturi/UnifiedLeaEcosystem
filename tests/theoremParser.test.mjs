import assert from "node:assert/strict";
import test from "node:test";
import {
  inferLeanDeclarationName,
  isValidLeanIdentifier,
  parseTheorems
} from "../shared/theoremParser.mjs";

test("detects a labeled theorem", () => {
  const [theorem] = parseTheorems("\\theorem[label=foo]{A}");
  assert.equal(theorem.label, "foo");
  assert.equal(theorem.text, "A");
  assert.deepEqual(theorem.uses, []);
  assert.equal(theorem.context, "");
});

test("accepts braced scalar metadata values", () => {
  const [theorem] = parseTheorems("\\theorem[label={foo}]{A}");
  assert.equal(theorem.label, "foo");
  assert.equal(theorem.text, "A");
  assert.deepEqual(theorem.uses, []);
});

test("parses a single theorem use from metadata", () => {
  const [theorem] = parseTheorems("\\theorem[label=foo, uses={bar}]{A}");
  assert.equal(theorem.label, "foo");
  assert.deepEqual(theorem.uses, ["bar"]);
  assert.equal(theorem.to, "\\theorem[label=foo, uses={bar}]{A}".length);
});

test("parses multiple theorem uses from metadata", () => {
  const [theorem] = parseTheorems("\\theorem[label=foo, uses={bar, baz, qux}]{A}");
  assert.equal(theorem.label, "foo");
  assert.deepEqual(theorem.uses, ["bar", "baz", "qux"]);
});

test("handles whitespace and newlines in metadata", () => {
  const [theorem] = parseTheorems("\\theorem[\n  label = {foo},\n  uses = { bar,\n baz, qux }\n]{A}");
  assert.equal(theorem.label, "foo");
  assert.deepEqual(theorem.uses, ["bar", "baz", "qux"]);
});

test("accepts newline-separated theorem metadata entries", () => {
  const [theorem] = parseTheorems("\\theorem[\n  label=foo\n  context={Use the hypothesis to rewrite n as 2 * k, then simplify the square.}\n]{A}");
  assert.equal(theorem.label, "foo");
  assert.equal(theorem.context, "Use the hypothesis to rewrite n as 2 * k, then simplify the square.");
});

test("splits metadata only on top-level commas", () => {
  const [theorem] = parseTheorems("\\theorem[uses={bar, baz}, label=foo]{A}");
  assert.equal(theorem.label, "foo");
  assert.deepEqual(theorem.uses, ["bar", "baz"]);
});

test("parses theorem context from metadata", () => {
  const [theorem] = parseTheorems("\\theorem[label=foo, context={Use induction on n.}]{A}");
  assert.equal(theorem.context, "Use induction on n.");
});

test("parses unbraced theorem context from metadata", () => {
  const [theorem] = parseTheorems("\\theorem[label=foo, context=Use simp first]{A}");
  assert.equal(theorem.context, "Use simp first");
});

test("preserves commas inside braced theorem context", () => {
  const [theorem] = parseTheorems("\\theorem[label=foo, context={Use simp, then omega.}, uses={bar}]{A}");
  assert.equal(theorem.context, "Use simp, then omega.");
  assert.deepEqual(theorem.uses, ["bar"]);
});

test("parses theorem context containing square-bracket Lean attributes", () => {
  const [theorem] = parseTheorems("\\theorem[label=foo, context=try [simp]]{A}");
  assert.equal(theorem.label, "foo");
  assert.equal(theorem.context, "try [simp]");
});

test("keeps commas inside square-bracket theorem context", () => {
  const [theorem] = parseTheorems("\\theorem[label=foo, context=try [simp, omega], uses={bar}]{A}");
  assert.equal(theorem.context, "try [simp, omega]");
  assert.deepEqual(theorem.uses, ["bar"]);
});

test("normalizes empty theorem context", () => {
  const [theorem] = parseTheorems("\\theorem[label=foo, context={   }]{A}");
  assert.equal(theorem.context, "");
});

test("handles multiline theorem bodies", () => {
  const [theorem] = parseTheorems("\\theorem[label=foo]{\nA\nB\n}");
  assert.equal(theorem.text, "A\nB");
});

test("handles nested braces", () => {
  const [theorem] = parseTheorems("\\theorem[label=foo]{A_{n} and {nested {text}}}");
  assert.equal(theorem.text, "A_{n} and {nested {text}}");
});

test("ignores theorems without metadata", () => {
  assert.deepEqual(parseTheorems("\\theorem{A}"), []);
});

test("ignores theorems without valid metadata labels", () => {
  assert.deepEqual(parseTheorems("\\theorem[uses={bar}]{A}"), []);
  assert.deepEqual(parseTheorems("\\theorem[label=invalid-label]{A}"), []);
});

test("ignores malformed theorem blocks", () => {
  assert.deepEqual(parseTheorems("\\theorem[label=foo]{A"), []);
  assert.deepEqual(parseTheorems("\\theorem[label=foo{A}"), []);
});

test("validates Lean identifiers", () => {
  assert.equal(isValidLeanIdentifier("main_theorem"), true);
  assert.equal(isValidLeanIdentifier("Theorem1"), true);
  assert.equal(isValidLeanIdentifier("main theorem"), false);
  assert.equal(isValidLeanIdentifier("main-theorem"), false);
  assert.equal(isValidLeanIdentifier("1theorem"), false);
});

test("infers Lean declaration names from theorem text", () => {
  assert.equal(
    inferLeanDeclarationName("Lean signature:\ntheorem even_square_of_even {n : Nat} : True := by"),
    "even_square_of_even"
  );
  assert.equal(
    inferLeanDeclarationName("```lean\nlemma foo_bar : True := by\n  trivial\n```"),
    "foo_bar"
  );
  assert.equal(inferLeanDeclarationName("Theorem name: named_result"), "named_result");
  assert.equal(inferLeanDeclarationName("Theorem name: invalid-name"), "");
});
