import { createHash } from "node:crypto";

const THEOREM_KINDS = new Set(["theorem", "lemma", "proposition", "corollary"]);
const DEFINITION_KINDS = new Set(["definition"]);
const SUPPORTED_KINDS = new Set([...THEOREM_KINDS, ...DEFINITION_KINDS]);

export function normalizeLeanPaneText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

export function hashLeanPaneSource(text) {
  return createHash("sha256").update(normalizeLeanPaneText(text)).digest("hex");
}

export function buildLeanPaneManifest({
  overleafProjectId = "unknown",
  files = [],
  activePath = ""
} = {}) {
  const normalizedFiles = normalizeFiles(files);
  const rootFile = selectRootFile(normalizedFiles, activePath);
  const diagnostics = [];
  if (!rootFile && normalizedFiles.length > 0) {
    diagnostics.push({
      code: "missing_root",
      message: "Could not determine a root .tex file for the Lean pane."
    });
  }

  const orderedPaths = rootFile
    ? expandDocumentOrder(normalizedFiles, rootFile, diagnostics)
    : normalizedFiles.map((file) => file.path).sort((a, b) => a.localeCompare(b));

  const items = [];
  const labels = new Map();
  for (const sourceFile of orderedPaths) {
    const file = normalizedFiles.find((candidate) => candidate.path === sourceFile);
    if (!file) continue;
    for (const item of parseLeanPaneItemsFromFile(file, items.length)) {
      items.push({
        id: `${item.kind}:${item.label}`,
        overleafProjectId,
        ...item,
        documentOrder: items.length
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
    rootFile,
    items,
    diagnostics
  };
}

export function parseLeanPaneItemsFromFile(file, initialOrder = 0) {
  const content = String(file?.content ?? "");
  const sourceFile = normalizePath(file?.path || "");
  const environments = findSupportedEnvironments(content);
  const items = [];
  for (const environment of environments) {
    const extracted = extractEnvironmentContent(content, environment);
    const leanName = extractLeaMarkerLabel(extracted.rawLatex);
    if (!leanName) continue;
    const sourceStart = offsetToLineColumn(content, environment.from);
    const sourceEnd = offsetToLineColumn(content, environment.to);
    const naturalLanguageLatex = cleanNaturalLanguageLatex(extracted.rawLatex);
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
      sourceHash: hashLeanPaneSource(naturalLanguageLatex),
      naturalLanguageLatex,
      naturalLanguageRendered: renderLightLatex(naturalLanguageLatex),
      leanKind: DEFINITION_KINDS.has(environment.name) ? "def" : "theorem",
      leanDeclarationName: leanName || undefined,
      status: "missing-stub"
    });
  }
  return items;
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

function selectRootFile(files, activePath) {
  if (files.length === 0) return "";
  const byPath = new Map(files.map((file) => [file.path, file]));
  const active = normalizePath(activePath || "");
  if (active && byPath.has(active) && looksLikeRootDocument(byPath.get(active).content)) {
    return active;
  }
  if (byPath.has("main.tex")) {
    return "main.tex";
  }
  const declared = files.find((file) => looksLikeRootDocument(file.content));
  return declared?.path || files[0].path;
}

function looksLikeRootDocument(content) {
  return /\\documentclass(?:\s*\[[^\]]*\])?\s*\{[^}]+\}/.test(String(content || ""));
}

function expandDocumentOrder(files, rootFile, diagnostics) {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const visited = new Set();
  const ordered = [];

  function visit(filePath, fromFile = "") {
    const normalized = normalizePath(filePath);
    if (!normalized || visited.has(normalized)) return;
    const file = byPath.get(normalized);
    if (!file) {
      diagnostics.push({
        code: "missing_include",
        message: `Could not find included .tex file ${normalized}.`,
        sourceFile: fromFile || rootFile
      });
      return;
    }
    visited.add(normalized);
    ordered.push(normalized);
    for (const includePath of findTexIncludes(file.content, normalized)) {
      visit(includePath, normalized);
    }
  }

  visit(rootFile);
  return ordered;
}

function findTexIncludes(content, currentPath) {
  const includes = [];
  const stripped = stripLatexComments(String(content || ""));
  const pattern = /\\(?:input|include)\s*\{([^}]+)\}/g;
  for (const match of stripped.matchAll(pattern)) {
    const value = String(match[1] || "").trim();
    if (!value) continue;
    includes.push(resolveTexPath(currentPath, value));
  }
  return includes;
}

function resolveTexPath(currentPath, includePath) {
  const baseParts = normalizePath(currentPath).split("/");
  baseParts.pop();
  const includeParts = normalizePath(includePath).split("/").filter(Boolean);
  const parts = [...baseParts, ...includeParts];
  const resolved = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  const joined = resolved.join("/");
  return joined.toLowerCase().endsWith(".tex") ? joined : `${joined}.tex`;
}

function findSupportedEnvironments(source) {
  const environments = [];
  const stack = [];
  const names = [...SUPPORTED_KINDS].join("|");
  const pattern = new RegExp(`\\\\(begin|end)\\s*\\{\\s*(${names})\\s*\\}`, "g");
  let match;

  while ((match = pattern.exec(source))) {
    const [, command, name] = match;
    if (command === "begin") {
      const openerEnd = findEnvironmentOpenerEnd(source, pattern.lastIndex);
      stack.push({
        name,
        from: match.index,
        bodyFrom: openerEnd.bodyFrom,
        title: openerEnd.title
      });
      continue;
    }

    for (let index = stack.length - 1; index >= 0; index -= 1) {
      if (stack[index].name !== name) continue;
      const [open] = stack.splice(index, 1);
      environments.push({
        ...open,
        bodyTo: match.index,
        to: pattern.lastIndex
      });
      break;
    }
  }

  return environments.sort((a, b) => a.from - b.from);
}

function findEnvironmentOpenerEnd(source, cursor) {
  let index = cursor;
  let bodyFrom = cursor;
  let title = "";
  while (index < source.length) {
    index = skipInlineWhitespace(source, index);
    if (isLineBreak(source[index])) break;
    const group = parseBalancedSuffix(source, index);
    if (!group.ok) break;
    const groupText = source.slice(index + 1, group.end - 1).trim();
    if (!title) {
      title = groupText;
    }
    index = group.end;
    bodyFrom = index;
  }
  return { bodyFrom, title: renderLightLatex(title) };
}

function extractEnvironmentContent(source, environment) {
  const rawLatex = source.slice(environment.bodyFrom, environment.bodyTo).trim();
  const heading = source.slice(environment.from, environment.bodyTo);
  const labelMatch = heading.match(/\\label\s*\{([^}]*)\}/);
  return {
    rawLatex,
    latexLabel: labelMatch ? labelMatch[1].trim() : "",
    title: environment.title
  };
}

function cleanNaturalLanguageLatex(source) {
  return String(source || "")
    .replace(/^[ \t]*%\s*lea:.*(?:\r?\n|$)/gmi, "")
    .replace(/\\label\s*\{[^}]*\}/g, "")
    .trim();
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

function extractLeaMarkerLabel(source) {
  const labelMatch = String(source || "").match(/^[ \t]*%\s*lea:\s*(?:formalize|define)?[\s\S]*?\blabel\s*=\s*(?:\{([^}]*)\}|([A-Za-z_][A-Za-z0-9_]*))/im);
  const value = (labelMatch?.[1] || labelMatch?.[2] || "").trim();
  return isValidLeanIdentifier(value) ? value : "";
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

function stripLatexComments(source) {
  return String(source || "")
    .split(/\r?\n/)
    .map((line) => {
      let escaped = false;
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (char === "\\" && !escaped) {
          escaped = true;
          continue;
        }
        if (char === "%" && !escaped) {
          return line.slice(0, index);
        }
        escaped = false;
      }
      return line;
    })
    .join("\n");
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/").trim();
}

function parseBalancedSuffix(source, cursor) {
  const opener = source[cursor];
  const closer = opener === "{" ? "}" : opener === "[" ? "]" : "";
  if (!closer) return { ok: false };

  let depth = 1;
  for (let index = cursor + 1; index < source.length; index += 1) {
    const char = source[index];
    const previous = source[index - 1];
    if (isLineBreak(char)) return { ok: false };
    if (char === opener && previous !== "\\") {
      depth += 1;
    } else if (char === closer && previous !== "\\") {
      depth -= 1;
      if (depth === 0) return { ok: true, end: index + 1 };
    }
  }
  return { ok: false };
}

function skipInlineWhitespace(source, cursor) {
  while (cursor < source.length && /[ \t]/.test(source[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function isLineBreak(char) {
  return char === "\n" || char === "\r";
}
