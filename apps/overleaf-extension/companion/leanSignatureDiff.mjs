// Classify a manual edit to a recorded Lean declaration: did only the proof
// body change (never downstream-risky for a theorem/lemma, by Lean's proof
// irrelevance), or did the declaration's signature/name/definition-body
// change (downstream-risky, needs cascade verification)?
//
// See docs/FEATURE-overleaf-lean-pane-manual-edit.md ("Signature-change
// detection") and docs/PLAN-overleaf-lean-pane-manual-edit.md (Phase 3).

import { normalizeTargetText } from "../shared/theoremParser.mjs";

// Mirrors server.mjs's DECLARATION_KEYWORDS (AUDIT L3): an item modelled as an
// `inductive` or `instance` must parse a header too, or every proof-only edit
// to it classifies as a blanket "signature" change and triggers a needless
// cascade. All of these except theorem/lemma are def-like (see isDefLike), so
// a body change to them cascades as a definition-body change.
const DECLARATION_KEYWORD_PATTERN = "theorem|lemma|def|abbrev|structure|class|inductive|instance";

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Locate a declaration's `keyword name` opener. When `declarationName` is
// given, search for that specific name (the common case: we already know
// which declaration this recorded file holds). When omitted, fall back to
// "the first top-level declaration in the file" -- recorded proof files are
// one-declaration-per-file (see proofPathFromProjectStep in
// leanDependencyGraph.mjs / PLAN Phase 3's open risk note), so "first
// declaration" and "the declaration we're editing" should normally coincide;
// the fallback exists specifically for the rename case, where searching by
// the *old* name would fail on the *edited* content.
function findDeclarationOpener(content, declarationName) {
  const namePattern = declarationName ? escapeRegExp(declarationName) : "[A-Za-z_][A-Za-z0-9_']*";
  // Lean identifiers may end in `'` (compactness_criterion'), which `\b`
  // alone does not guard against: `'` is a non-word character, so `\b` after
  // a fixed literal name would happily match as a prefix of a longer,
  // different identifier. The explicit negative lookahead closes that gap.
  const pattern = new RegExp(
    `(^|\\n)(\\s*(?:@\\[[^\\n]*\\]\\s*)*(?:(?:private|protected|noncomputable|unsafe|partial)\\s+)*)` +
    `(${DECLARATION_KEYWORD_PATTERN})\\s+(${namePattern})(?![A-Za-z0-9_'])`
  );
  const match = content.match(pattern);
  if (!match) return null;
  const keyword = match[3];
  const name = match[4];
  const headerStart = match.index + match[1].length + match[2].length;
  return { keyword, name, headerStart };
}

// Scan forward from a declaration's opener for the top-level `:=` (or
// `where`, for the rarer structure/class-shaped case) that ends its header --
// i.e. everything before the proof/value begins. Bracket-depth aware so a
// binder default value like `(n : Nat := 0)` doesn't end the header early.
// Does not attempt to skip `:=`/`where` inside string literals or comments --
// a known, accepted v1 approximation (PLAN Phase 3, "Open risks").
function findHeaderEnd(content, start) {
  let depth = 0;
  for (let i = start; i < content.length; i += 1) {
    const ch = content[i];
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && ch === ":" && content[i + 1] === "=") {
      return i;
    } else if (depth === 0 && isWhereKeywordAt(content, i)) {
      return i;
    }
  }
  return content.length;
}

function isWhereKeywordAt(content, index) {
  if (!content.startsWith("where", index)) return false;
  const before = index > 0 ? content[index - 1] : " ";
  const after = content[index + 5] || " ";
  return /\s/.test(before) && (after === "" || /\s/.test(after));
}

// Parse a declaration's header: everything from its keyword through (but not
// including) the `:=`/`where` that opens its proof or value, whitespace-
// normalized so reformatting alone never registers as a change. Returns
// `null` when no matching declaration is found at all (e.g. a rename, when
// searched by the old name with no fallback).
export function parseDeclarationHeader(content, declarationName) {
  const text = String(content || "");
  const opener = findDeclarationOpener(text, declarationName)
    || (declarationName ? findDeclarationOpener(text) : null);
  if (!opener) return null;
  const headerEnd = findHeaderEnd(text, opener.headerStart);
  const header = normalizeTargetText(text.slice(opener.headerStart, headerEnd));
  return { keyword: opener.keyword, name: opener.name, header };
}

/**
 * @typedef {
 *   | { kind: "proof-only" }
 *   | { kind: "signature" }
 *   | { kind: "renamed", from: string, to: string }
 *   | { kind: "definition-body" }
 *   | { kind: "own-check-failed" }
 * } EditClassification
 */

// Classify an edit to a declaration previously known as `expectedName`.
// `before`/`after` are `parseDeclarationHeader` results (or null) for the
// pre-edit and post-edit content. `ownCheckFailed` is the edited file's own
// fresh `lean_check` result -- when it fails to even compile, every importer
// is at risk regardless of what the header diff says, so that check takes
// priority.
export function classifyEdit({ before, after, expectedName, ownCheckFailed = false } = {}) {
  if (ownCheckFailed) return { kind: "own-check-failed" };

  // A header that failed to parse on either side is treated as a signature
  // change: "a missed real signature change is worse than one unnecessary
  // cascade check" (feature spec, Signature-change detection).
  if (!before || !after) return { kind: "signature" };

  if (expectedName && before.name === expectedName && after.name !== expectedName) {
    return { kind: "renamed", from: before.name, to: after.name };
  }

  if (isDefLike(before) || isDefLike(after)) {
    return { kind: "definition-body" };
  }

  if (before.header !== after.header) {
    return { kind: "signature" };
  }

  return { kind: "proof-only" };
}

// "Def-like" = a declaration whose BODY/value can be relied on downstream, so
// a body change (not just a header change) is cascade-worthy. That's
// everything except theorem/lemma, which are proof-irrelevant (their proof
// body can't affect any importer). structure/class/inductive/instance
// (AUDIT L3) all expose fields/constructors/resolution downstream, so a change
// to their body must re-verify dependents just like a def would.
const PROOF_IRRELEVANT_KEYWORDS = new Set(["theorem", "lemma"]);

function isDefLike(header) {
  return Boolean(header) && !PROOF_IRRELEVANT_KEYWORDS.has(header.keyword);
}

// The single predicate edit-save handlers call: does this classification
// require re-verifying the project's dependents? Everything except a pure
// proof-body edit to a theorem/lemma does, by Lean's proof-irrelevance
// guarantee (see the feature spec's "A Lean fact this feature leans on").
export function cascadeRequired(classification) {
  return Boolean(classification) && classification.kind !== "proof-only";
}
