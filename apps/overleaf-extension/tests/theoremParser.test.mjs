import assert from "node:assert/strict";
import test from "node:test";
import {
  inferLeanDeclarationName,
  isValidLeanIdentifier,
  parseTheoremDocument,
  parseTheorems
} from "../shared/theoremParser.mjs";

test("detects a labeled theorem", () => {
  const [theorem] = parseTheorems("\\theorem[label=foo]{A}");
  assert.equal(theorem.label, "foo");
  assert.equal(theorem.text, "A");
  assert.deepEqual(theorem.uses, []);
  assert.equal(theorem.context, "");
  assert.equal(theorem.syntax, "legacy");
  assert.equal(theorem.deprecated, true);
});

test("detects a comment-marked theorem environment", () => {
  const source = [
    "\\begin{theorem}\\label{thm:even-square}",
    "% lea: formalize label=even_square uses={even_def} context={Use the parity definition first.}",
    "If $n$ is even, then $n^2$ is even.",
    "\\end{theorem}"
  ].join("\n");
  const result = parseTheoremDocument(source);
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.theorems.length, 1);
  assert.equal(result.theorems[0].label, "even_square");
  assert.equal(result.theorems[0].kind, "theorem");
  assert.equal(result.theorems[0].latexLabel, "thm:even-square");
  assert.equal(result.theorems[0].syntax, "comment");
  assert.equal(result.theorems[0].deprecated, false);
  assert.deepEqual(result.theorems[0].uses, ["even_def"]);
  assert.equal(result.theorems[0].context, "Use the parity definition first.");
  assert.equal(result.theorems[0].text, "If $n$ is even, then $n^2$ is even.");
});

test("detects multiline adjacent Lea marker metadata", () => {
  const source = [
    "\\begin{lemma}",
    "% lea: formalize",
    "% lea: label=main_bound",
    "% lea: uses={aux_bound, mono_lemma}",
    "% lea: context={Apply aux_bound, then use [simp, omega].}",
    "The desired main bound holds.",
    "\\end{lemma}"
  ].join("\n");
  const [theorem] = parseTheorems(source);
  assert.equal(theorem.label, "main_bound");
  assert.deepEqual(theorem.uses, ["aux_bound", "mono_lemma"]);
  assert.equal(theorem.context, "Apply aux_bound, then use [simp, omega].");
  assert.equal(theorem.kind, "lemma");
  assert.equal(theorem.text, "The desired main bound holds.");
});

test("detects multiple marked theorem blocks independently", () => {
  const source = [
    "\\begin{lemma}",
    "% lea: formalize label=first_result",
    "First.",
    "\\end{lemma}",
    "\\begin{corollary}",
    "% lea: formalize label=second_result",
    "Second.",
    "\\end{corollary}"
  ].join("\n");
  assert.deepEqual(parseTheorems(source).map((theorem) => theorem.label), ["first_result", "second_result"]);
});

test("ignores unmarked theorem environments", () => {
  assert.deepEqual(parseTheorems("\\begin{theorem}\nUnmarked.\n\\end{theorem}"), []);
});

test("reports missing and invalid marker labels", () => {
  const missing = parseTheoremDocument("\\begin{theorem}\n% lea: formalize\nA.\n\\end{theorem}");
  assert.equal(missing.theorems.length, 0);
  assert.equal(missing.diagnostics[0].code, "missing_label");

  const invalid = parseTheoremDocument("\\begin{theorem}\n% lea: formalize label=bad-label\nA.\n\\end{theorem}");
  assert.equal(invalid.theorems.length, 0);
  assert.equal(invalid.diagnostics[0].code, "invalid_label");
});

test("reports marker outside a supported theorem environment", () => {
  const result = parseTheoremDocument("% lea: formalize label=outside\nPlain text.");
  assert.equal(result.theorems.length, 0);
  assert.equal(result.diagnostics[0].code, "missing_environment");
});

test("removes Lea marker comments and LaTeX labels from theorem text", () => {
  const source = [
    "\\begin{proposition}",
    "\\label{prop:clean}",
    "% lea: formalize label=clean_text",
    "A statement with $x_{n}$.",
    "\\end{proposition}"
  ].join("\n");
  const [theorem] = parseTheorems(source);
  assert.equal(theorem.latexLabel, "prop:clean");
  assert.equal(theorem.text, "A statement with $x_{n}$.");
});

test("reports duplicate formalize markers in one environment", () => {
  const source = [
    "\\begin{theorem}",
    "% lea: formalize label=first_marker",
    "A.",
    "% lea: formalize label=second_marker",
    "\\end{theorem}"
  ].join("\n");
  const result = parseTheoremDocument(source);
  assert.equal(result.theorems.length, 0);
  assert.equal(result.diagnostics[0].code, "duplicate_marker");
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
