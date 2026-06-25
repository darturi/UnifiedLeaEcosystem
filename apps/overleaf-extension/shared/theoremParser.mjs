import { createHash } from "node:crypto";

const THEOREM_PREFIX = "\\theorem";

export function normalizeTheoremText(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

export function hashTheoremText(text) {
  return createHash("sha256").update(normalizeTheoremText(text)).digest("hex");
}

export function isValidLeanIdentifier(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export function inferLeanDeclarationName(text) {
  const source = String(text || "");
  const declaration = source.match(/(?:^|\n)\s*(?:theorem|lemma)\s+([A-Za-z_][A-Za-z0-9_]*)(?=\s|$|[:{(])/);
  if (declaration && isValidLeanIdentifier(declaration[1])) {
    return declaration[1];
  }

  const named = source.match(/(?:^|\n)\s*Theorem\s+name\s*:\s*([^\n]+)/i);
  if (named) {
    const value = named[1].trim();
    return isValidLeanIdentifier(value) ? value : "";
  }

  return "";
}

export function parseTheoremDocument(source) {
  const text = String(source || "");
  const legacyTheorems = parseLegacyTheorems(text);
  const markerResult = parseCommentMarkedTheorems(text);
  return {
    theorems: [...markerResult.theorems, ...legacyTheorems].sort((a, b) => a.from - b.from),
    diagnostics: markerResult.diagnostics.sort((a, b) => a.from - b.from)
  };
}

export function parseTheorems(source) {
  return parseTheoremDocument(source).theorems;
}

function parseLegacyTheorems(source) {
  const theorems = [];
  let index = 0;

  while (index < source.length) {
    const start = source.indexOf(THEOREM_PREFIX, index);
    if (start === -1) break;

    const parsed = parseTheoremAt(source, start);
    if (parsed.ok) {
      theorems.push(parsed.theorem);
      index = parsed.theorem.to;
      continue;
    }

    index = start + THEOREM_PREFIX.length;
  }

  return theorems;
}

export function parseTheoremAt(source, start) {
  if (!source.startsWith(THEOREM_PREFIX, start)) {
    return { ok: false, reason: "missing theorem prefix" };
  }

  let cursor = start + THEOREM_PREFIX.length;
  cursor = skipWhitespace(source, cursor);

  if (source[cursor] !== "[") {
    return { ok: false, reason: "missing theorem metadata" };
  }

  const metadataResult = parseOptionalMetadata(source, cursor);
  if (!metadataResult.ok) {
    return metadataResult;
  }
  cursor = skipWhitespace(source, metadataResult.end);

  if (!isValidLeanIdentifier(metadataResult.metadata.label || "")) {
    return { ok: false, reason: "invalid label" };
  }

  if (source[cursor] !== "{") {
    return { ok: false, reason: "missing theorem body" };
  }

  const bodyStart = cursor + 1;
  let depth = 1;
  cursor = bodyStart;

  while (cursor < source.length) {
    const char = source[cursor];
    const previous = source[cursor - 1];

    if (char === "{" && previous !== "\\") {
      depth += 1;
    } else if (char === "}" && previous !== "\\") {
      depth -= 1;
      if (depth === 0) {
        const bodyEnd = cursor;
        const theoremText = source.slice(bodyStart, bodyEnd).trim();

        return {
          ok: true,
          theorem: {
            label: metadataResult.metadata.label,
            text: theoremText,
            uses: metadataResult.metadata.uses,
            context: metadataResult.metadata.context,
            kind: "theorem",
            latexLabel: "",
            syntax: "legacy",
            deprecated: true,
            from: start,
            to: cursor + 1,
            bodyFrom: bodyStart,
            bodyTo: bodyEnd,
            sourceHash: hashTheoremText(theoremText)
          }
        };
      }
    }

    cursor += 1;
  }

  return { ok: false, reason: "unterminated theorem body" };
}

function parseCommentMarkedTheorems(source) {
  const diagnostics = [];
  const theoremEnvironments = findTheoremEnvironments(source);
  const groups = findLeaCommentGroups(source).filter((group) => group.hasFormalize);
  const groupsByEnvironment = new Map();

  for (const group of groups) {
    const environment = findSmallestEnclosingEnvironment(theoremEnvironments, group.from, group.to);
    if (!environment) {
      diagnostics.push(buildDiagnostic({
        code: "missing_environment",
        message: "Lea marker must be inside a theorem, lemma, proposition, or corollary environment.",
        from: group.from,
        to: group.to
      }));
      continue;
    }
    const key = environment.from;
    const existing = groupsByEnvironment.get(key) || { environment, groups: [] };
    existing.groups.push(group);
    groupsByEnvironment.set(key, existing);
  }

  const theorems = [];
  for (const { environment, groups: environmentGroups } of groupsByEnvironment.values()) {
    if (environmentGroups.length > 1) {
      diagnostics.push(buildDiagnostic({
        code: "duplicate_marker",
        message: `Only one Lea formalize marker is supported inside this ${environment.kind} environment.`,
        from: environmentGroups[1].from,
        to: environmentGroups[1].to
      }));
      continue;
    }

    const group = environmentGroups[0];
    const metadata = group.metadata;
    if (!metadata.label) {
      diagnostics.push(buildDiagnostic({
        code: "missing_label",
        message: "Lea marker is missing an explicit label=... value.",
        from: group.from,
        to: group.to
      }));
      continue;
    }
    if (!isValidLeanIdentifier(metadata.label)) {
      diagnostics.push(buildDiagnostic({
        code: "invalid_label",
        message: "Lea marker label must be a valid Lean identifier.",
        from: group.from,
        to: group.to
      }));
      continue;
    }

    const { text, latexLabel } = extractEnvironmentText(source, environment);
    if (!text.trim()) {
      diagnostics.push(buildDiagnostic({
        code: "missing_theorem_text",
        message: "Marked theorem block has no theorem text after Lea comments are removed.",
        from: group.from,
        to: group.to
      }));
      continue;
    }

    theorems.push({
      label: metadata.label,
      text,
      uses: metadata.uses,
      context: metadata.context,
      kind: environment.kind,
      latexLabel,
      syntax: "comment",
      deprecated: false,
      from: environment.from,
      to: environment.to,
      bodyFrom: environment.bodyFrom,
      bodyTo: environment.bodyTo,
      sourceHash: hashTheoremText(text)
    });
  }

  return { theorems, diagnostics };
}

function findTheoremEnvironments(source) {
  const environments = [];
  const stack = [];
  const pattern = /\\(begin|end)\s*\{\s*(theorem|lemma|proposition|corollary)\s*\}/g;
  let match;

  while ((match = pattern.exec(source))) {
    const [, command, kind] = match;
    if (command === "begin") {
      stack.push({
        kind,
        from: match.index,
        bodyFrom: pattern.lastIndex
      });
      continue;
    }

    for (let index = stack.length - 1; index >= 0; index -= 1) {
      if (stack[index].kind !== kind) continue;
      const [open] = stack.splice(index, 1);
      environments.push({
        ...open,
        bodyTo: match.index,
        to: pattern.lastIndex
      });
      break;
    }
  }

  return environments;
}

function findSmallestEnclosingEnvironment(environments, from, to) {
  return environments
    .filter((environment) => environment.from <= from && to <= environment.to)
    .sort((a, b) => (a.to - a.from) - (b.to - b.from))[0] || null;
}

function findLeaCommentGroups(source) {
  const lines = splitLinesWithRanges(source);
  const groups = [];
  let index = 0;

  while (index < lines.length) {
    const first = parseLeaCommentLine(lines[index]);
    if (!first) {
      index += 1;
      continue;
    }

    const groupLines = [{ ...lines[index], content: first.content }];
    index += 1;
    while (index < lines.length) {
      const parsed = parseLeaCommentLine(lines[index]);
      if (!parsed) break;
      groupLines.push({ ...lines[index], content: parsed.content });
      index += 1;
    }

    const metadataSource = groupLines
      .map((line) => line.content.replace(/^\s*formalize\b\s*/i, ""))
      .join("\n");
    groups.push({
      from: groupLines[0].from,
      to: groupLines[groupLines.length - 1].to,
      hasFormalize: groupLines.some((line) => /^\s*formalize\b/i.test(line.content)),
      metadata: parseMetadata(metadataSource)
    });
  }

  return groups;
}

function splitLinesWithRanges(source) {
  const lines = [];
  const pattern = /.*(?:\r?\n|$)/g;
  let match;
  while ((match = pattern.exec(source))) {
    if (match[0] === "" && match.index === source.length) break;
    lines.push({
      text: match[0],
      from: match.index,
      to: match.index + match[0].length
    });
  }
  return lines;
}

function parseLeaCommentLine(line) {
  const match = line.text.match(/^[ \t]*%\s*lea:\s*(.*?)(?:\r?\n)?$/i);
  return match ? { content: match[1] || "" } : null;
}

function extractEnvironmentText(source, environment) {
  const body = source.slice(environment.bodyFrom, environment.bodyTo);
  const labelMatch = body.match(/\\label\s*\{([^}]*)\}/);
  const latexLabel = labelMatch ? labelMatch[1].trim() : "";
  const text = body
    .replace(/^[ \t]*%\s*lea:.*(?:\r?\n|$)/gmi, "")
    .replace(/\\label\s*\{[^}]*\}/g, "")
    .trim();
  return { text, latexLabel };
}

function buildDiagnostic({ code, message, from, to }) {
  return {
    code,
    message,
    label: code,
    text: "",
    uses: [],
    context: "",
    kind: "diagnostic",
    syntax: "diagnostic",
    from,
    to,
    bodyFrom: from,
    bodyTo: to
  };
}

function parseOptionalMetadata(source, cursor) {
  const metadataStart = cursor + 1;
  let depth = 0;
  let bracketDepth = 0;
  cursor = metadataStart;

  while (cursor < source.length) {
    const char = source[cursor];
    const previous = source[cursor - 1];

    if (char === "{" && previous !== "\\") {
      depth += 1;
    } else if (char === "}" && previous !== "\\") {
      depth = Math.max(0, depth - 1);
    } else if (char === "[" && previous !== "\\" && depth === 0) {
      bracketDepth += 1;
    } else if (char === "]" && previous !== "\\" && depth === 0 && bracketDepth > 0) {
      bracketDepth -= 1;
    } else if (char === "]" && previous !== "\\" && depth === 0) {
      return {
        ok: true,
        metadata: parseMetadata(source.slice(metadataStart, cursor)),
        end: cursor + 1
      };
    }

    cursor += 1;
  }

  return { ok: false, reason: "unterminated theorem metadata" };
}

function parseMetadata(source) {
  const metadata = { label: "", uses: [], context: "" };
  for (const entry of splitMetadataEntries(source)) {
    const separator = entry.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = entry.slice(0, separator).trim();
    const value = unbrace(entry.slice(separator + 1).trim());
    if (key === "label") {
      metadata.label = value.trim();
    } else if (key === "uses") {
      metadata.uses = splitTopLevel(value, ",")
        .map((item) => unbrace(item.trim()).trim())
        .filter(Boolean);
    } else if (key === "context") {
      metadata.context = value.trim();
    }
  }
  return metadata;
}

function splitMetadataEntries(source) {
  const parts = [];
  let depth = 0;
  let bracketDepth = 0;
  let partStart = 0;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const previous = source[index - 1];
    if (char === "{" && previous !== "\\") {
      depth += 1;
    } else if (char === "}" && previous !== "\\") {
      depth = Math.max(0, depth - 1);
    } else if (char === "[" && previous !== "\\" && depth === 0) {
      bracketDepth += 1;
    } else if (char === "]" && previous !== "\\" && depth === 0 && bracketDepth > 0) {
      bracketDepth -= 1;
    } else if (isMetadataSeparator(source, index, depth, bracketDepth)) {
      parts.push(source.slice(partStart, index));
      partStart = index + 1;
    }
  }

  parts.push(source.slice(partStart));
  return parts;
}

function isMetadataSeparator(source, index, depth, bracketDepth) {
  if (depth !== 0 || bracketDepth !== 0) {
    return false;
  }
  if (source[index] === ",") {
    return true;
  }
  if (/\s/.test(source[index]) && /^(?:\s+)(?:label|uses|context)\s*=/.test(source.slice(index))) {
    return true;
  }
  if (source[index] !== "\n") {
    return false;
  }
  return /^(?:\s*)(?:label|uses|context)\s*=/.test(source.slice(index + 1));
}

function splitTopLevel(source, separator) {
  const parts = [];
  let depth = 0;
  let bracketDepth = 0;
  let partStart = 0;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const previous = source[index - 1];
    if (char === "{" && previous !== "\\") {
      depth += 1;
    } else if (char === "}" && previous !== "\\") {
      depth = Math.max(0, depth - 1);
    } else if (char === "[" && previous !== "\\" && depth === 0) {
      bracketDepth += 1;
    } else if (char === "]" && previous !== "\\" && depth === 0 && bracketDepth > 0) {
      bracketDepth -= 1;
    } else if (char === separator && depth === 0 && bracketDepth === 0) {
      parts.push(source.slice(partStart, index));
      partStart = index + 1;
    }
  }

  parts.push(source.slice(partStart));
  return parts;
}

function unbrace(value) {
  if (value.startsWith("{") && value.endsWith("}")) {
    return value.slice(1, -1);
  }
  return value;
}

function skipWhitespace(source, cursor) {
  while (cursor < source.length && /\s/.test(source[cursor])) {
    cursor += 1;
  }
  return cursor;
}
