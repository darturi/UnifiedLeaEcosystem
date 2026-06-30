import { hashTargetText, normalizeTargetText } from "./theoremParser.mjs";
import {
  findEnvironments,
  isLineBreak,
  parseBalancedSuffix,
  parseTargets,
  skipInlineWhitespace,
  stripLeaTargetText
} from "../extension/targetParserCore.mjs";

// Used only as a display-kind fallback (leanKindFor) when an environment has
// no validated target -- e.g. a malformed or mismatched marker. Custom
// (non-allowlisted) environments aren't classifiable this way and default to
// "theorem"; see leanKindFor.
const DEFINITION_KINDS = new Set(["definition"]);

// The pane hashes the exact same canonical text the formalize path hashes
// (`hashTargetText` over `stripLeaTargetText`), so an item's `sourceHash` and a
// finished job's `targetTextHash` are directly comparable for staleness. These
// aliases keep the original export names while delegating to the single source of
// truth in theoremParser/targetParserCore (PLAN-overleaf-lean-pane-improvements item 1).
export const normalizeLeanPaneText = normalizeTargetText;
export const hashLeanPaneSource = hashTargetText;

export function buildLeanPaneManifest({
  overleafProjectId = "unknown",
  files = []
} = {}) {
  const normalizedFiles = normalizeFiles(files);
  const diagnostics = [];
  const orderedPaths = normalizedFiles.map((file) => file.path).sort((a, b) => a.localeCompare(b));

  const items = [];
  const labels = new Map();
  for (const sourceFile of orderedPaths) {
    const file = normalizedFiles.find((candidate) => candidate.path === sourceFile);
    if (!file) continue;
    // Reuse the formalize-path parser to recover full marker metadata (uses/context)
    // and confirm the marker is a valid formalize target. Keyed by environment
    // offset, which both parsers compute identically for the same source.
    const targetByOffset = new Map(parseTargets(file.content).map((target) => [target.from, target]));
    for (const item of parseLeanPaneItemsFromFile(file, items.length)) {
      const documentOrder = items.length;
      const matchedTarget = targetByOffset.get(item.sourceStartOffset);
      items.push({
        // documentOrder keeps the id unique even when two environments share the
        // same kind+label (a duplicate_label case), so expansion state and DOM
        // dataset ids never collide in the pane.
        id: `${item.kind}:${item.label}:${documentOrder}`,
        overleafProjectId,
        ...item,
        // formalize-from-pane (item 12): only a valid marker is a runnable target.
        formalizable: Boolean(matchedTarget),
        targetUses: matchedTarget?.targetUses || [],
        targetContext: matchedTarget?.targetContext || "",
        documentOrder
      });
      const seen = labels.get(item.label) || [];
      seen.push(item.sourceFile);
      labels.set(item.label, seen);
    }
  }

  for (const [label, sourceFiles] of labels.entries()) {
    if (sourceFiles.length <= 1) continue;
    diagnostics.push({
      code: "duplicate_label",
      label,
      message: `Label ${label} appears in multiple Lean-pane items.`,
      sourceFiles
    });
  }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    rootFile: "",
    items,
    diagnostics
  };
}

export function parseLeanPaneItemsFromFile(file, initialOrder = 0) {
  const content = String(file?.content ?? "");
  const sourceFile = normalizePath(file?.path || "");
  // Generic (no name allowlist): a custom environment tagged with
  // \leatheorem{...}/\leadefinition{...}/etc. is inventoried exactly like
  // theorem/definition. The allowlist was only ever a proxy for "this might
  // be a Lea target" -- a tag states that directly, so custom environments
  // (e.g. \begin{claim}) are exactly the case tags exist to support.
  //
  // Sort by start offset: findEnvironments pushes an environment when its
  // \end{} is matched, so a nested pair (rare for theorem-like environments,
  // but not impossible) would otherwise appear before its enclosing one.
  const environments = findEnvironments(content, { names: null }).sort((a, b) => a.from - b.from);
  // The strict, validated parser (same one the formalize path and
  // buildLeanPaneManifest's own formalizable-matching use), keyed by
  // environment start offset. A malformed/mismatched marker won't appear
  // here, but should still surface as a (non-formalizable) pane item -- see
  // extractLeaMarkerLabel below -- so this is consulted only for the
  // validated kind, not for whether to list the item at all.
  const targetsByOffset = new Map(parseTargets(content).map((target) => [target.from, target]));
  const items = [];
  for (const environment of environments) {
    const extracted = extractEnvironmentContent(content, environment);
    const leanName = extractLeaMarkerLabel(extracted.rawLatex);
    if (!leanName) continue;
    const target = targetsByOffset.get(environment.from);
    const sourceStart = offsetToLineColumn(content, environment.from);
    const sourceEnd = offsetToLineColumn(content, environment.to);
    const naturalLanguageLatex = stripLeaTargetText(extracted.rawLatex);
    items.push({
      label: leanName,
      kind: environment.name,
      title: extracted.title || undefined,
      latexLabel: extracted.latexLabel || undefined,
      documentOrder: initialOrder + items.length,
      sourceFile,
      sourceStartLine: sourceStart.line,
      sourceEndLine: sourceEnd.line,
      sourceStartOffset: environment.from,
      sourceEndOffset: environment.to,
      sourceHash: hashTargetText(naturalLanguageLatex),
      naturalLanguageLatex,
      naturalLanguageRendered: renderLightLatex(naturalLanguageLatex),
      leanKind: leanKindFor(target, environment),
      leanDeclarationName: leanName || undefined,
      status: "missing-stub"
    });
  }
  return items;
}

function leanKindFor(target, environment) {
  if (target) return target.targetKind === "definition" ? "def" : "theorem";
  // No validated target (missing/invalid/mismatched marker): fall back to a
  // best-effort guess from the environment name, same as the original
  // comment-only behavior, for the allowlisted names it can classify. Custom
  // environments with no resolvable target default to "theorem" -- display
  // only, since the item is already marked not formalizable.
  return DEFINITION_KINDS.has(environment.name) ? "def" : "theorem";
}

function normalizeFiles(files) {
  const byPath = new Map();
  for (const file of Array.isArray(files) ? files : []) {
    const filePath = normalizePath(file?.path || "");
    if (!filePath || !filePath.toLowerCase().endsWith(".tex")) continue;
    byPath.set(filePath, { path: filePath, content: String(file?.content ?? "") });
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

// Title-only helper: an environment may open with an optional bracketed or
// braced title immediately after \begin{name} (e.g.
// \begin{definition}[Locally finite family]), before any \label{...}. Body
// extraction itself (bodyFrom/bodyTo) comes from the shared findEnvironments
// above; this only recovers the display title, which is pane-specific and
// not needed by the comment/tag marker parsers.
function extractEnvironmentTitle(source, openerEnd) {
  const index = skipInlineWhitespace(source, openerEnd);
  if (isLineBreak(source[index])) return "";
  const group = parseBalancedSuffix(source, index);
  if (!group.ok) return "";
  return renderLightLatex(source.slice(index + 1, group.end - 1).trim());
}

function extractEnvironmentContent(source, environment) {
  const rawLatex = source.slice(environment.bodyFrom, environment.bodyTo).trim();
  const heading = source.slice(environment.from, environment.bodyTo);
  const labelMatch = heading.match(/\\label\s*\{([^}]*)\}/);
  return {
    rawLatex,
    latexLabel: labelMatch ? labelMatch[1].trim() : "",
    title: extractEnvironmentTitle(source, environment.openerEnd)
  };
}

function renderLightLatex(source) {
  return String(source || "")
    .replace(/^[ \t]*%.*(?:\r?\n|$)/gm, "")
    .replace(/\\label\s*\{[^}]*\}/g, "")
    .replace(/\\(?:emph|textbf|textit|mathrm|operatorname)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\(?:ref|eqref|cite|autoref)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\(?:left|right)\b/g, "")
    .replace(/\\[,;:!]/g, " ")
    .replace(/~+/g, " ")
    .replace(/[ \t]*\r?\n[ \t]*/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// Loose, best-effort label extraction -- not full validation. Deliberately
// permissive (unlike targetParserCore's strict parser) so that a malformed or
// mismatched marker still surfaces as a pane item (just not formalizable),
// rather than silently disappearing from the inventory. Tries the comment
// marker syntax first, then the tag syntax.
function extractLeaMarkerLabel(source) {
  const text = String(source || "");
  const commentMatch = text.match(/^[ \t]*%\s*lea:\s*(?:formalize|define)?[\s\S]*?\blabel\s*=\s*(?:\{([^}]*)\}|([A-Za-z_][A-Za-z0-9_]*))/im);
  const commentValue = (commentMatch?.[1] || commentMatch?.[2] || "").trim();
  if (isValidLeanIdentifier(commentValue)) return commentValue;

  const tagMatch = text.match(/\\(?:lea|leatheorem|lealemma|leaproposition|leacorollary|leadefinition)\b[\s\S]*?\blabel\s*=\s*(?:\{([^}]*)\}|([A-Za-z_][A-Za-z0-9_]*))/);
  const tagValue = (tagMatch?.[1] || tagMatch?.[2] || "").trim();
  return isValidLeanIdentifier(tagValue) ? tagValue : "";
}

function isValidLeanIdentifier(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(value || ""));
}

function offsetToLineColumn(source, offset) {
  const prefix = String(source || "").slice(0, Math.max(0, offset));
  const lines = prefix.split(/\r?\n/);
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1
  };
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/").trim();
}

