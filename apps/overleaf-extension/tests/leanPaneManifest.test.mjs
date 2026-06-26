import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLeanPaneManifest,
  hashLeanPaneSource
} from "../shared/leanPaneManifest.mjs";
import { parseTargets } from "../shared/theoremParser.mjs";

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

test("source hashes match the formalize target parser for the same block", () => {
  // Guards the staleness mechanism: the pane's item.sourceHash and the formalize
  // path's target.sourceHash must hash byte-identical text, or every formalized
  // item would render permanently stale (or never stale).
  const source = [
    "\\documentclass{article}",
    "\\begin{theorem}[Compactness criterion]\\label{thm:c}",
    "% lea: formalize label=compactness_criterion uses={finite_subcover}",
    "Every open cover of a compact space has a finite subcover.",
    "\\end{theorem}",
    "\\begin{definition}\\label{def:lf}",
    "% lea: define label=locally_finite",
    "A family is \\emph{locally finite} if every point has a neighborhood",
    "meeting finitely many members.",
    "\\end{definition}"
  ].join("\n");

  const manifest = buildLeanPaneManifest({ files: [{ path: "main.tex", content: source }] });
  const targets = parseTargets(source);

  assert.equal(manifest.items.length, 2);
  for (const item of manifest.items) {
    const target = targets.find((candidate) => candidate.targetLabel === item.label);
    assert.ok(target, `expected a formalize target for ${item.label}`);
    assert.equal(item.sourceHash, target.sourceHash);
  }
});

test("makes ids unique for duplicate kind+label items", () => {
  const manifest = buildLeanPaneManifest({
    files: [{
      path: "main.tex",
      content: [
        "\\begin{theorem}\\label{thm:a}\n% lea: formalize label=dup\nA.\\end{theorem}",
        "\\begin{theorem}\\label{thm:b}\n% lea: formalize label=dup\nB.\\end{theorem}"
      ].join("\n")
    }]
  });

  assert.equal(manifest.items.length, 2);
  assert.notEqual(manifest.items[0].id, manifest.items[1].id);
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
