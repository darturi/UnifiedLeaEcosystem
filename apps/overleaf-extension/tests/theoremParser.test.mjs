import assert from "node:assert/strict";
import test from "node:test";
import {
  hashTargetText,
  inferLeanDeclarationName,
  isValidLeanIdentifier,
  normalizeTargetText,
  parseTargetDocument,
  parseTargets
} from "../shared/theoremParser.mjs";

test("detects a comment-marked theorem target", () => {
  const source = [
    "\\begin{theorem}\\label{thm:even-square}",
    "% lea: formalize label=even_square uses={even_def} context={Use the parity definition first.}",
    "If $n$ is even, then $n^2$ is even.",
    "\\end{theorem}"
  ].join("\n");
  const result = parseTargetDocument(source);
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.targets.length, 1);
  assert.deepEqual(result.targets[0], {
    targetKind: "theorem",
    targetLabel: "even_square",
    targetText: "If $n$ is even, then $n^2$ is even.",
    targetUses: ["even_def"],
    targetContext: "Use the parity definition first.",
    latexEnvironment: "theorem",
    latexLabel: "thm:even-square",
    sourceHash: hashTargetText("If $n$ is even, then $n^2$ is even."),
    syntax: "comment",
    from: 0,
    to: source.length,
    badgeFrom: source.indexOf("\n"),
    bodyFrom: source.indexOf("\n"),
    bodyTo: source.lastIndexOf("\\end{theorem}")
  });
});

test("detects a definition target using lea define", () => {
  const source = [
    "\\begin{definition}\\label{def:subadditive}",
    "% lea: define label=Subadditive context={Use a predicate over Nat -> Real.}",
    "A sequence $a_n$ is subadditive if $a_{m+n} \\le a_m + a_n$ for all $m,n$.",
    "\\end{definition}"
  ].join("\n");
  const [target] = parseTargets(source);
  assert.equal(target.targetKind, "definition");
  assert.equal(target.targetLabel, "Subadditive");
  assert.equal(target.latexEnvironment, "definition");
  assert.equal(target.latexLabel, "def:subadditive");
  assert.equal(target.targetContext, "Use a predicate over Nat -> Real.");
  assert.equal(target.targetText, "A sequence $a_n$ is subadditive if $a_{m+n} \\le a_m + a_n$ for all $m,n$.");
  assert.equal(target.badgeFrom, source.indexOf("\n"));
  assert.equal(target.bodyFrom, source.indexOf("\n"));
});

test("anchors status badges after complete environment openers", () => {
  const plain = [
    "\\begin{theorem}",
    "% lea: formalize label=plain_theorem",
    "A plain theorem.",
    "\\end{theorem}"
  ].join("\n");
  const [plainTarget] = parseTargets(plain);
  assert.equal(plainTarget.badgeFrom, "\\begin{theorem}".length);
  assert.equal(plainTarget.bodyFrom, "\\begin{theorem}".length);

  const titled = [
    "\\begin{definition}{even-nat}",
    "% lea: define label=EvenNat",
    "A natural number is even if it is twice another natural number.",
    "\\end{definition}"
  ].join("\n");
  const [titledTarget] = parseTargets(titled);
  assert.equal(titledTarget.badgeFrom, titled.indexOf("\n"));
  assert.equal(titledTarget.bodyFrom, titled.indexOf("\n"));
  assert.equal(titledTarget.targetText, "A natural number is even if it is twice another natural number.");

  const labelled = [
    "\\begin{definition}\\label{def:monotone-nat}",
    "% lea: define label=MonotoneNat",
    "A function is monotone if it preserves order.",
    "\\end{definition}"
  ].join("\n");
  const [labelledTarget] = parseTargets(labelled);
  assert.equal(labelledTarget.badgeFrom, labelled.indexOf("\n"));
  assert.equal(labelledTarget.bodyFrom, labelled.indexOf("\n"));
  assert.equal(labelledTarget.latexLabel, "def:monotone-nat");
  assert.equal(labelledTarget.targetText, "A function is monotone if it preserves order.");
});

test("detects formalize kind=definition as a definition alias", () => {
  const source = [
    "\\begin{definition}",
    "% lea: formalize kind=definition label=EvenNat",
    "A natural number $n$ is even if there exists $k$ with $n = 2k$.",
    "\\end{definition}"
  ].join("\n");
  const [target] = parseTargets(source);
  assert.equal(target.targetKind, "definition");
  assert.equal(target.targetLabel, "EvenNat");
});

test("detects multiline adjacent Lea marker metadata", () => {
  const source = [
    "\\begin{definition}",
    "% lea: define",
    "% lea: label=Subadditive",
    "% lea: uses={real_sequence, le_order}",
    "% lea: context={Represent this as a predicate on functions Nat -> Real.}",
    "A sequence is subadditive if the usual inequality holds.",
    "\\end{definition}"
  ].join("\n");
  const [target] = parseTargets(source);
  assert.equal(target.targetLabel, "Subadditive");
  assert.deepEqual(target.targetUses, ["real_sequence", "le_order"]);
  assert.equal(target.targetContext, "Represent this as a predicate on functions Nat -> Real.");
});

test("ignores unmarked environments and legacy custom theorem commands", () => {
  assert.deepEqual(parseTargets("\\begin{definition}\nUnmarked.\n\\end{definition}"), []);
  assert.deepEqual(parseTargets("\\theorem[label=legacy]{A}"), []);
});

test("reports missing, invalid, and duplicate marker labels", () => {
  const missing = parseTargetDocument("\\begin{theorem}\n% lea: formalize\nA.\n\\end{theorem}");
  assert.equal(missing.targets.length, 0);
  assert.equal(missing.diagnostics[0].code, "missing_label");

  const invalid = parseTargetDocument("\\begin{definition}\n% lea: define label=bad-label\nA.\n\\end{definition}");
  assert.equal(invalid.targets.length, 0);
  assert.equal(invalid.diagnostics[0].code, "invalid_label");

  const duplicate = parseTargetDocument([
    "\\begin{theorem}",
    "% lea: formalize label=first_marker",
    "A.",
    "% lea: formalize label=second_marker",
    "\\end{theorem}"
  ].join("\n"));
  assert.equal(duplicate.targets.length, 0);
  assert.equal(duplicate.diagnostics[0].code, "duplicate_marker");
});

test("reports target/environment mismatches clearly", () => {
  const defineInTheorem = parseTargetDocument("\\begin{theorem}\n% lea: define label=bad\nA.\n\\end{theorem}");
  assert.equal(defineInTheorem.targets.length, 0);
  assert.equal(defineInTheorem.diagnostics[0].code, "environment_mismatch");
  assert.match(defineInTheorem.diagnostics[0].message, /definition environment/);

  const formalizeInDefinition = parseTargetDocument("\\begin{definition}\n% lea: formalize label=bad\nA.\n\\end{definition}");
  assert.equal(formalizeInDefinition.targets.length, 0);
  assert.equal(formalizeInDefinition.diagnostics[0].code, "environment_mismatch");
  assert.match(formalizeInDefinition.diagnostics[0].message, /kind=definition/);
});

test("removes Lea marker comments and LaTeX labels from target text", () => {
  const source = [
    "\\begin{definition}",
    "\\label{def:clean}",
    "% lea: define label=CleanDefinition",
    "A definition with $x_{n}$.",
    "\\end{definition}"
  ].join("\n");
  const [target] = parseTargets(source);
  assert.equal(target.latexLabel, "def:clean");
  assert.equal(target.targetText, "A definition with $x_{n}$.");
});

test("normalizes and hashes target text", () => {
  assert.equal(normalizeTargetText(" A\n  B "), "A B");
  assert.equal(hashTargetText(" A\n  B "), hashTargetText("A B"));
});

test("validates Lean identifiers and infers declaration names", () => {
  assert.equal(isValidLeanIdentifier("main_theorem"), true);
  assert.equal(isValidLeanIdentifier("main-theorem"), false);
  assert.equal(inferLeanDeclarationName("def even_nat (n : Nat) : Prop := True"), "even_nat");
  assert.equal(inferLeanDeclarationName("structure Foo where\n  x : Nat"), "Foo");
  assert.equal(inferLeanDeclarationName("Definition name: invalid-name"), "");
});
