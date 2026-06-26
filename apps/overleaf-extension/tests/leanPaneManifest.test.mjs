import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLeanPaneManifest,
  hashLeanPaneSource
} from "../shared/leanPaneManifest.mjs";

test("builds document-order inventory through input and include", () => {
  const manifest = buildLeanPaneManifest({
    overleafProjectId: "project-1",
    activePath: "main.tex",
    files: [
      {
        path: "sections/defs.tex",
        content: [
          "\\begin{definition}[Locally finite family]\\label{def:locally-finite}",
          "% lea: define label=locally_finite_family",
          "A family $F$ is locally finite.",
          "\\end{definition}"
        ].join("\n")
      },
      {
        path: "main.tex",
        content: [
          "\\documentclass{article}",
          "\\begin{theorem}[Compactness criterion]\\label{thm:compactness}",
          "% lea: formalize label=compactness_criterion",
          "Every open cover has a finite subcover.",
          "\\end{theorem}",
          "\\input{sections/defs}"
        ].join("\n")
      },
      {
        path: "unused.tex",
        content: "\\begin{lemma}\\label{lem:unused}Unused.\\end{lemma}"
      }
    ]
  });

  assert.equal(manifest.rootFile, "main.tex");
  assert.equal(manifest.items.length, 2);
  assert.deepEqual(manifest.items.map((item) => item.label), ["compactness_criterion", "locally_finite_family"]);
  assert.deepEqual(manifest.items.map((item) => item.latexLabel), ["thm:compactness", "def:locally-finite"]);
  assert.deepEqual(manifest.items.map((item) => item.documentOrder), [0, 1]);
  assert.equal(manifest.items[0].leanDeclarationName, "compactness_criterion");
  assert.equal(manifest.items[1].leanKind, "def");
});

test("omits environments without Lea comment labels and preserves source metadata", () => {
  const source = [
    "\\begin{lemma}",
    "No label.",
    "\\end{lemma}",
    "\\begin{corollary}\\label{cor:main}",
    "% lea: formalize label=main_corollary",
    "A consequence of \\emph{the theorem}.",
    "\\end{corollary}"
  ].join("\n");
  const manifest = buildLeanPaneManifest({
    files: [{ path: "main.tex", content: source }]
  });

  assert.equal(manifest.items.length, 1);
  const [item] = manifest.items;
  assert.equal(item.kind, "corollary");
  assert.equal(item.label, "main_corollary");
  assert.equal(item.latexLabel, "cor:main");
  assert.equal(item.sourceFile, "main.tex");
  assert.equal(item.sourceStartLine, 4);
  assert.equal(item.sourceEndLine, 7);
  assert.equal(item.sourceStartOffset, source.indexOf("\\begin{corollary}"));
  assert.equal(item.sourceHash, hashLeanPaneSource("A consequence of \\emph{the theorem}."));
  assert.equal(item.naturalLanguageLatex, "A consequence of \\emph{the theorem}.");
  assert.equal(item.naturalLanguageRendered, "A consequence of the theorem.");
});

test("does not inventory LaTeX-labeled environments without Lea markers", () => {
  const manifest = buildLeanPaneManifest({
    files: [{
      path: "main.tex",
      content: [
        "\\begin{theorem}\\label{thm:plain}Plain theorem.\\end{theorem}",
        "\\begin{definition}\\label{def:plain}Plain definition.\\end{definition}"
      ].join("\n")
    }]
  });

  assert.equal(manifest.items.length, 0);
});

test("reports duplicate labels without dropping items", () => {
  const manifest = buildLeanPaneManifest({
    files: [
      {
        path: "main.tex",
        content: [
          "\\begin{theorem}\\label{thm:a}\n% lea: formalize label=dup\nA.\\end{theorem}",
          "\\begin{lemma}\\label{lem:b}\n% lea: formalize label=dup\nB.\\end{lemma}"
        ].join("\n")
      }
    ]
  });

  assert.equal(manifest.items.length, 2);
  assert.equal(manifest.diagnostics[0].code, "duplicate_label");
  assert.equal(manifest.diagnostics[0].label, "dup");
});
