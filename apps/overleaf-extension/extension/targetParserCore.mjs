const THEOREM_ENVIRONMENTS = new Set(["theorem", "lemma", "proposition", "corollary"]);
const DEFINITION_ENVIRONMENTS = new Set(["definition"]);
const SUPPORTED_ENVIRONMENTS = new Set([...THEOREM_ENVIRONMENTS, ...DEFINITION_ENVIRONMENTS]);

// Inline tag commands from lea-tags.sty (docs/FEATURE-overleaf-inline-lea-tags.md).
// Each maps to the targetKind it implies; `lea` is the generic form, whose kind
// comes from a kind=... argument instead (mirroring `% lea: formalize kind=...`).
const TAG_COMMAND_KINDS = {
  leatheorem: "theorem",
  lealemma: "theorem",
  leaproposition: "theorem",
  leacorollary: "theorem",
  leadefinition: "definition",
  lea: null
};

// Longest-name-first so the alternation's backtracking (forced by \b below) has
// the least work to do; correctness doesn't depend on this ordering.
const TAG_COMMAND_NAMES = Object.keys(TAG_COMMAND_KINDS).sort((a, b) => b.length - a.length);
const TAG_COMMAND_PATTERN_SOURCE = `\\\\(${TAG_COMMAND_NAMES.join("|")})\\b`;

// Environments where a Lea tag is almost certainly a mistake (a stray tag left
// in a figure/list/math environment rather than a theorem-like statement).
// Non-blocking: the target is still produced, just flagged. Tags are
// environment-name-agnostic by design, so this is the one safety net against
// the obvious accidental cases, not an exhaustive list.
const SUSPICIOUS_TAG_ENVIRONMENTS = new Set([
  "figure", "figure*", "table", "table*", "itemize", "enumerate",
  "equation", "equation*", "align", "align*", "tabular", "tabular*"
]);

export function parseTargetDocument(source) {
  const text = String(source || "");
  const markerResult = parseMarkedTargets(text);
  return {
    targets: markerResult.targets.sort((a, b) => a.from - b.from),
    diagnostics: markerResult.diagnostics.sort((a, b) => a.from - b.from)
  };
}

export function parseTargets(source) {
  return parseTargetDocument(source).targets;
}

export function isValidLeanIdentifier(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function parseMarkedTargets(source) {
  const diagnostics = [];
  const commentEnvironments = findSupportedEnvironments(source);
  let genericEnvironments = null; // computed lazily; only needed if a tag is present
  const getGenericEnvironments = () => {
    if (!genericEnvironments) {
      genericEnvironments = findEnvironments(source, { names: null });
    }
    return genericEnvironments;
  };

  const commentGroups = findLeaCommentGroups(source)
    .filter((group) => group.hasTargetMarker)
    .map((group) => ({ ...group, syntax: "comment" }));
  const tagDetection = findLeaTagGroups(source);
  diagnostics.push(...tagDetection.diagnostics);

  if (tagDetection.groups.length > 0 && !hasLeaTagPackageLoaded(source)) {
    const firstTag = tagDetection.groups[0];
    diagnostics.push(buildDiagnostic({
      code: "tag_package_not_loaded",
      message: "A Lea tag command (e.g. \\leatheorem{...}) is used, but nothing in the preamble defines it. "
        + "Add \\usepackage{lea-tags} (or the inline fallback definitions) before \\begin{document}, "
        + "or this document will fail to compile.",
      from: firstTag.from,
      to: firstTag.to
    }));
  }

  const groupsByEnvironment = new Map();
  for (const group of [...commentGroups, ...tagDetection.groups]) {
    const lookupEnvironments = group.syntax === "tag" ? getGenericEnvironments() : commentEnvironments;
    const environment = findSmallestEnclosingEnvironment(lookupEnvironments, group.from, group.to);
    if (!environment) {
      diagnostics.push(buildDiagnostic({
        code: "missing_environment",
        message: group.syntax === "tag"
          ? "A Lea tag must be inside a LaTeX environment, e.g. \\begin{theorem}...\\end{theorem}."
          : "Lea marker must be inside a supported theorem or definition environment.",
        from: group.from,
        to: group.to
      }));
      continue;
    }
    const key = environment.from;
    const existing = groupsByEnvironment.get(key) || { groups: [] };
    existing.groups.push({ ...group, environment });
    groupsByEnvironment.set(key, existing);
  }

  const targets = [];
  for (const { groups: environmentGroups } of groupsByEnvironment.values()) {
    const environment = environmentGroups[0].environment;
    if (environmentGroups.length > 1) {
      diagnostics.push(buildDiagnostic({
        code: "duplicate_marker",
        message: `Only one Lea marker is supported inside this ${environment.name} environment.`,
        from: environmentGroups[1].from,
        to: environmentGroups[1].to
      }));
      continue;
    }

    const group = environmentGroups[0];
    const markerKind = inferMarkerTargetKind(group);
    if (!markerKind.ok) {
      diagnostics.push(buildDiagnostic({
        code: markerKind.code,
        message: markerKind.message,
        from: group.from,
        to: group.to
      }));
      continue;
    }
    // The environment-name/kind allowlist check only applies to comment
    // markers, which depend on the environment name to infer their kind. A
    // tag states its own kind explicitly, so a custom (non-allowlisted)
    // environment is exactly the case tags are meant to support.
    if (group.syntax === "comment" && markerKind.targetKind !== environment.targetKind) {
      diagnostics.push(buildDiagnostic({
        code: "environment_mismatch",
        message: mismatchMessage(markerKind.targetKind, environment),
        from: group.from,
        to: group.to
      }));
      continue;
    }

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
    const invalidUse = metadata.uses.find((value) => !isValidLeanIdentifier(value));
    if (invalidUse) {
      diagnostics.push(buildDiagnostic({
        code: "invalid_uses",
        message: `Lea dependency label must be a valid Lean identifier: ${invalidUse}.`,
        from: group.from,
        to: group.to
      }));
      continue;
    }

    const { targetText, latexLabel } = extractEnvironmentText(source, environment);
    if (!targetText.trim()) {
      diagnostics.push(buildDiagnostic({
        code: "missing_target_text",
        message: `Marked ${markerKind.targetKind} block has no text after Lea comments are removed.`,
        from: group.from,
        to: group.to
      }));
      continue;
    }

    if (group.syntax === "tag" && SUSPICIOUS_TAG_ENVIRONMENTS.has(environment.name)) {
      diagnostics.push(buildDiagnostic({
        code: "suspicious_environment",
        message: `Lea tag is inside a ${environment.name} environment, which is unusual for a theorem or `
          + "definition statement. Double-check this is the intended block.",
        from: group.from,
        to: group.to
      }));
    }

    targets.push({
      targetKind: markerKind.targetKind,
      targetLabel: metadata.label,
      targetText,
      targetUses: metadata.uses,
      targetContext: metadata.context,
      latexEnvironment: environment.name,
      latexLabel,
      sourceHash: "",
      syntax: group.syntax,
      from: environment.from,
      to: environment.to,
      badgeFrom: environment.badgeFrom,
      bodyFrom: environment.bodyFrom,
      bodyTo: environment.bodyTo
    });
  }

  return { targets, diagnostics };
}

// Tag usage is only meaningful in the document body. Restricting detection to
// after \begin{document} (when present) avoids false-positive matches against
// the package's own \NewDocumentCommand{\lea}{m}{} *definition* in the
// preamble (or a user's pasted inline-fallback snippet), which contains the
// literal substring "\lea}" but is not a tag invocation.
function documentBodyOffset(source) {
  const marker = "\\begin{document}";
  const index = source.indexOf(marker);
  return index === -1 ? 0 : index + marker.length;
}

function findLeaTagGroups(source) {
  const groups = [];
  const diagnostics = [];
  const offset = documentBodyOffset(source);
  const body = source.slice(offset);
  const pattern = new RegExp(TAG_COMMAND_PATTERN_SOURCE, "g");
  let match;

  while ((match = pattern.exec(body))) {
    const commandStart = match.index;
    const commandName = match[1];
    const afterCommand = pattern.lastIndex;
    const argumentStart = skipInlineWhitespace(body, afterCommand);
    const argument = body[argumentStart] === "{" ? parseBalancedSuffix(body, argumentStart) : { ok: false };
    if (!argument.ok) {
      diagnostics.push(buildDiagnostic({
        code: "malformed_tag",
        message: `\\${commandName}{...} must be followed by a single balanced { } argument on the same line.`,
        from: offset + commandStart,
        to: offset + afterCommand
      }));
      continue;
    }

    const argumentInner = body.slice(argumentStart + 1, argument.end - 1);
    const metadata = parseMetadata(argumentInner);
    const impliedKind = TAG_COMMAND_KINDS[commandName];
    if (impliedKind) {
      // The command name is authoritative over any kind=... the argument
      // also happens to contain: \leatheorem{...} is always a theorem.
      metadata.kind = impliedKind;
    }

    groups.push({
      from: offset + commandStart,
      to: offset + argument.end,
      syntax: "tag",
      command: commandName,
      hasFormalize: impliedKind !== "definition",
      hasDefine: impliedKind === "definition",
      hasTargetMarker: true,
      metadata
    });
    pattern.lastIndex = argument.end;
  }

  return { groups, diagnostics };
}

function hasLeaTagPackageLoaded(source) {
  const documentStart = source.indexOf("\\begin{document}");
  const preamble = documentStart === -1 ? source : source.slice(0, documentStart);
  return (
    /\\usepackage(?:\[[^\]]*\])?\{[^}]*\blea-tags\b[^}]*\}/.test(preamble)
    || /\\input\s*\{\s*lea-tags\s*\}/.test(preamble)
    || /\\(?:New|Renew|Provide)DocumentCommand\s*\{\s*\\lea\s*\}/.test(preamble)
    || /\\(?:new|renew|provide)command\*?\s*\{\s*\\lea\s*\}/.test(preamble)
  );
}

function inferMarkerTargetKind(group) {
  if (group.hasDefine && group.hasFormalize) {
    return {
      ok: false,
      code: "mixed_marker",
      message: "Use either lea: define or lea: formalize for one target, not both."
    };
  }
  if (group.hasDefine) {
    return { ok: true, targetKind: "definition" };
  }
  if (!group.hasFormalize) {
    return {
      ok: false,
      code: "missing_marker",
      message: "Lea metadata comments must start with define or formalize."
    };
  }

  const kind = String(group.metadata.kind || "").trim();
  if (!kind) {
    return { ok: true, targetKind: "theorem" };
  }
  if (kind === "definition" || kind === "theorem") {
    return { ok: true, targetKind: kind };
  }
  return {
    ok: false,
    code: "unsupported_kind",
    message: `Unsupported Lea target kind: ${kind}.`
  };
}

function mismatchMessage(markerKind, environment) {
  if (markerKind === "definition" && environment.targetKind === "theorem") {
    return "lea: define markers must be inside a definition environment.";
  }
  if (markerKind === "theorem" && environment.targetKind === "definition") {
    return "Definition environments must use lea: define or lea: formalize kind=definition.";
  }
  return `Lea ${markerKind} marker does not match the ${environment.name} environment.`;
}

function findSupportedEnvironments(source) {
  return findEnvironments(source, { names: SUPPORTED_ENVIRONMENTS }).map((environment) => ({
    ...environment,
    targetKind: DEFINITION_ENVIRONMENTS.has(environment.name) ? "definition" : "theorem"
  }));
}

// Structural environments that are never themselves a theorem/definition
// target, even though they're syntactically just another \begin{X}...\end{X}
// pair. Excluded only from *generic* matching (names: null) -- the
// allowlisted comment-marker path never matches these anyway. Without this,
// a tag with no real enclosing statement environment would resolve to
// \begin{document}...\end{document} itself (present in essentially every
// real Overleaf project) instead of producing a missing_environment
// diagnostic, silently treating the entire paper as the target's body.
const NON_TARGET_ENVIRONMENTS = new Set(["document"]);

// Generic environment finder, shared by the comment-marker path above (via
// findSupportedEnvironments, restricted to the theorem/definition allowlist)
// and by tag-based detection and the Lean pane (shared/leanPaneManifest.mjs),
// which both need to locate *any* \begin{X}...\end{X} pair, not just an
// allowlisted name. Returns environment objects with no targetKind — callers
// that need a theorem/definition classification derive it themselves (from
// the environment name, for the allowlisted case, or from marker metadata,
// for the tag/generic case).
export function findEnvironments(source, { names } = {}) {
  const environments = [];
  const stack = [];
  const pattern = buildEnvironmentPattern(names);
  let match;

  while ((match = pattern.exec(source))) {
    const [, command, name] = match;
    if (command === "begin") {
      const openerEnd = pattern.lastIndex;
      const bodyFrom = findEnvironmentBadgeAnchor(source, openerEnd);
      stack.push({
        name,
        from: match.index,
        openerEnd,
        badgeFrom: bodyFrom,
        bodyFrom
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

  return names ? environments : environments.filter((environment) => !NON_TARGET_ENVIRONMENTS.has(environment.name));
}

function buildEnvironmentPattern(names) {
  const namePattern = names ? [...names].join("|") : "[A-Za-z]+\\*?";
  return new RegExp(`\\\\(begin|end)\\s*\\{\\s*(${namePattern})\\s*\\}`, "g");
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
      .map((line) => line.content.replace(/^\s*(?:formalize|define)\b\s*/i, ""))
      .join("\n");
    groups.push({
      from: groupLines[0].from,
      to: groupLines[groupLines.length - 1].to,
      hasFormalize: groupLines.some((line) => /^\s*formalize\b/i.test(line.content)),
      hasDefine: groupLines.some((line) => /^\s*define\b/i.test(line.content)),
      hasTargetMarker: groupLines.some((line) => /^\s*(?:formalize|define)\b/i.test(line.content)),
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
  const labelMatch = source.slice(environment.from, environment.bodyTo).match(/\\label\s*\{([^}]*)\}/);
  return { targetText: stripLeaTargetText(body), latexLabel: labelMatch ? labelMatch[1].trim() : "" };
}

// Canonical natural-language text of a marked environment body: the same text the
// staleness hash is computed over. Shared with the Lean-pane manifest so both
// surfaces hash byte-identical input and can never drift (see
// shared/leanPaneManifest.mjs and PLAN-overleaf-lean-pane-improvements.md item 1).
export function stripLeaTargetText(body) {
  return stripLeaTagCalls(String(body || ""))
    .replace(/^[ \t]*%\s*lea:.*(?:\r?\n|$)/gmi, "")
    .replace(/\\label\s*\{[^}]*\}/g, "")
    .trim();
}

// Removes \lea{...}/\leatheorem{...}/etc calls from a body of text. Brace-aware
// (not a fixed-width regex) because context={...} can itself contain braces.
function stripLeaTagCalls(body) {
  const pattern = new RegExp(TAG_COMMAND_PATTERN_SOURCE, "g");
  let result = "";
  let cursor = 0;
  let match;

  while ((match = pattern.exec(body))) {
    if (match.index < cursor) continue;
    const afterCommand = pattern.lastIndex;
    const argumentStart = skipInlineWhitespace(body, afterCommand);
    const argument = body[argumentStart] === "{" ? parseBalancedSuffix(body, argumentStart) : { ok: false };
    const spanEnd = argument.ok ? argument.end : afterCommand;
    result += body.slice(cursor, match.index);
    cursor = spanEnd;
    pattern.lastIndex = spanEnd;
  }
  result += body.slice(cursor);
  return result;
}

function buildDiagnostic({ code, message, from, to }) {
  return {
    code,
    message,
    targetKind: "diagnostic",
    targetLabel: code,
    targetText: "",
    targetUses: [],
    targetContext: "",
    latexEnvironment: "",
    latexLabel: "",
    sourceHash: "",
    syntax: "diagnostic",
    from,
    to,
    badgeFrom: from,
    bodyFrom: from,
    bodyTo: to
  };
}

function findEnvironmentBadgeAnchor(source, bodyFrom) {
  let cursor = bodyFrom;
  let anchor = bodyFrom;

  while (cursor < source.length) {
    cursor = skipInlineWhitespace(source, cursor);
    if (isLineBreak(source[cursor])) break;

    const group = parseBalancedSuffix(source, cursor);
    if (group.ok) {
      cursor = group.end;
      anchor = cursor;
      continue;
    }

    const label = parseSameLineLabel(source, cursor);
    if (label.ok) {
      cursor = label.end;
      anchor = cursor;
      continue;
    }

    break;
  }

  return anchor;
}

function parseSameLineLabel(source, cursor) {
  if (!source.startsWith("\\label", cursor)) {
    return { ok: false };
  }
  const afterCommand = cursor + "\\label".length;
  if (/[A-Za-z]/.test(source[afterCommand] || "")) {
    return { ok: false };
  }
  const argumentStart = skipInlineWhitespace(source, afterCommand);
  const argument = parseBalancedSuffix(source, argumentStart);
  return argument.ok && source[argumentStart] === "{" ? argument : { ok: false };
}

export function parseBalancedSuffix(source, cursor) {
  const opener = source[cursor];
  const closer = opener === "{" ? "}" : opener === "[" ? "]" : "";
  if (!closer) {
    return { ok: false };
  }

  let depth = 1;
  for (let index = cursor + 1; index < source.length; index += 1) {
    const char = source[index];
    const previous = source[index - 1];
    if (isLineBreak(char)) {
      return { ok: false };
    }
    if (char === opener && previous !== "\\") {
      depth += 1;
    } else if (char === closer && previous !== "\\") {
      depth -= 1;
      if (depth === 0) {
        return { ok: true, end: index + 1 };
      }
    }
  }

  return { ok: false };
}

export function skipInlineWhitespace(source, cursor) {
  while (cursor < source.length && /[ \t]/.test(source[cursor])) {
    cursor += 1;
  }
  return cursor;
}

export function isLineBreak(char) {
  return char === "\n" || char === "\r";
}

function parseMetadata(source) {
  const metadata = { label: "", uses: [], context: "", kind: "" };
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
    } else if (key === "kind") {
      metadata.kind = value.trim();
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
  if (/\s/.test(source[index]) && /^(?:\s+)(?:label|uses|context|kind)\s*=/.test(source.slice(index))) {
    return true;
  }
  if (source[index] !== "\n") {
    return false;
  }
  return /^(?:\s*)(?:label|uses|context|kind)\s*=/.test(source.slice(index + 1));
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
