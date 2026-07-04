// buildRepairPrompt (self-repair Phase 3 prompt contract) + a guard that the
// preamble factor-out left buildChatPrompt's first-message output unchanged.
import assert from "node:assert/strict";
import test from "node:test";

import { buildChatPrompt, buildRepairPrompt } from "../companion/chatPrompt.mjs";

const TARGET = {
  projectSlug: "project-1",
  targetKind: "theorem",
  targetLabel: "compactness_corollary",
  latexLabel: "thm:corollary",
  sourceFile: "main.tex",
  sourceStartLine: 10,
  sourceEndLine: 14,
  naturalLanguageLatex: "Every compact subset is closed.",
  leanDeclarationName: "compactness_corollary",
  recordedProofPath: "workspace/proofs/Lea.Project1/compactness_corollary.lean",
  status: "invalid"
};

const RENAME_BREAKAGE = {
  upstreamLabel: "compactness_criterion",
  upstreamDeclarationName: "compactness_thm",
  classificationKind: "renamed",
  renamedFrom: "compactness_criterion",
  renamedTo: "compactness_thm",
  via: "chat",
  editedAt: "2026-07-04T12:00:00.000Z",
  beforeHeader: "theorem compactness_criterion : True",
  afterHeader: "theorem compactness_thm : True"
};

test("repair prompt: rename variant carries the mapping, headers, diagnostic, and stop condition", () => {
  const prompt = buildRepairPrompt(TARGET, {
    breakage: RENAME_BREAKAGE,
    diagnostic: "unknown identifier 'compactness_criterion'"
  });

  // identity preamble (shared with chat first messages)
  assert.match(prompt, /Project: project-1/);
  assert.match(prompt, /Label: compactness_corollary/);
  assert.match(prompt, /Natural-language statement:\nEvery compact subset is closed\./);
  // what changed: rename, explicitly "renamed, not removed", with the mapping
  assert.match(prompt, /RENAMED to `compactness_thm`/);
  assert.match(prompt, /renamed, not removed/);
  assert.match(prompt, /came from a chat request/);
  // old/new headers
  assert.match(prompt, /Previous declaration header: theorem compactness_criterion : True/);
  assert.match(prompt, /Current declaration header: theorem compactness_thm : True/);
  // what broke: the real compiler diagnostic
  assert.match(prompt, /unknown identifier 'compactness_criterion'/);
  // rules: mechanical rename update allowed, statement immutable, no sorry, stop condition
  assert.match(prompt, /Update references and imports from `compactness_criterion` to `compactness_thm`/);
  assert.match(prompt, /Do NOT weaken, strengthen, or otherwise alter this item's own theorem statement/);
  assert.match(prompt, /Do NOT introduce sorry, admit, or new axioms/);
  assert.match(prompt, /STOP and report that conclusion/);
});

test("repair prompt: signature variant has no rename rule and names the upstream declaration", () => {
  const prompt = buildRepairPrompt(TARGET, {
    breakage: {
      upstreamLabel: "compactness_criterion",
      upstreamDeclarationName: "compactness_criterion",
      classificationKind: "signature",
      via: "edit",
      editedAt: "2026-07-04T12:00:00.000Z"
    },
    diagnostic: "type mismatch"
  });
  assert.match(prompt, /statement \(signature\) of the upstream declaration `compactness_criterion` changed/);
  assert.match(prompt, /came from a manual edit/);
  assert.doesNotMatch(prompt, /Update references and imports/);
  assert.doesNotMatch(prompt, /Previous declaration header/); // no headers recorded
});

test("repair prompt: self-repair variant (own edit broke the item) says so instead of citing an upstream import", () => {
  const prompt = buildRepairPrompt(TARGET, {
    breakage: {
      upstreamLabel: "compactness_corollary", // === the item's own label
      classificationKind: "own-check-failed",
      via: "edit",
      editedAt: "2026-07-04T12:00:00.000Z"
    },
    diagnostic: "unexpected token"
  });
  assert.match(prompt, /This item's own recorded Lean file was changed by a manual edit and no longer compiles/);
  assert.doesNotMatch(prompt, /imports\/uses that declaration/);
  assert.match(prompt, /unexpected token/);
});

test("repair prompt: def-body variant explains definitional unfolding risk", () => {
  const prompt = buildRepairPrompt(TARGET, {
    breakage: {
      upstreamLabel: "measure_kernel",
      upstreamDeclarationName: "measure_kernel",
      classificationKind: "definition-body",
      via: "formalize",
      editedAt: "2026-07-04T12:00:00.000Z"
    }
  });
  assert.match(prompt, /upstream definition `measure_kernel` changed/);
  assert.match(prompt, /unfolded downstream/);
  assert.match(prompt, /came from a re-formalization run/);
});

test("preamble factor-out: buildChatPrompt first-message output is byte-identical to the pre-refactor shape", () => {
  const prompt = buildChatPrompt(TARGET, { stale: true, firstMessage: true, userText: "please fix" });
  assert.equal(prompt, [
    "You are helping with this Overleaf item.",
    "",
    "Project: project-1",
    "Kind: theorem",
    "Label: compactness_corollary",
    "LaTeX label: thm:corollary",
    "Source file: main.tex:10-14",
    "Natural-language statement:",
    "Every compact subset is closed.",
    "",
    "Known Lean declaration: compactness_corollary",
    "Known Lean artifact: workspace/proofs/Lea.Project1/compactness_corollary.lean",
    "Known status: invalid",
    "Note: the Overleaf source changed after the known Lean artifact was generated.",
    "User request:",
    "please fix"
  ].join("\n"));
});
