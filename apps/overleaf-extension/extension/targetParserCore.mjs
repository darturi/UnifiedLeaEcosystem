const THEOREM_ENVIRONMENTS = new Set(["theorem", "lemma", "proposition", "corollary"]);
const DEFINITION_ENVIRONMENTS = new Set(["definition"]);
const SUPPORTED_ENVIRONMENTS = new Set([...THEOREM_ENVIRONMENTS, ...DEFINITION_ENVIRONMENTS]);

export function parseTargetDocument(source) {
  const text = String(source || "");
  const markerResult = parseCommentMarkedTargets(text);
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

function parseCommentMarkedTargets(source) {
  const diagnostics = [];
  const environments = findSupportedEnvironments(source);
  const groups = findLeaCommentGroups(source).filter((group) => group.hasTargetMarker);
  const groupsByEnvironment = new Map();

  for (const group of groups) {
    const environment = findSmallestEnclosingEnvironment(environments, group.from, group.to);
    if (!environment) {
      diagnostics.push(buildDiagnostic({
        code: "missing_environment",
        message: "Lea marker must be inside a supported theorem or definition environment.",
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

  const targets = [];
  for (const { environment, groups: environmentGroups } of groupsByEnvironment.values()) {
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
    if (markerKind.targetKind !== environment.targetKind) {
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

    targets.push({
      targetKind: markerKind.targetKind,
      targetLabel: metadata.label,
      targetText,
      targetUses: metadata.uses,
      targetContext: metadata.context,
      latexEnvironment: environment.name,
      latexLabel,
      sourceHash: "",
      syntax: "comment",
      from: environment.from,
      to: environment.to,
      badgeFrom: environment.badgeFrom,
      bodyFrom: environment.bodyFrom,
      bodyTo: environment.bodyTo
    });
  }

  return { targets, diagnostics };
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
  const environments = [];
  const stack = [];
  const names = [...SUPPORTED_ENVIRONMENTS].join("|");
  const pattern = new RegExp(`\\\\(begin|end)\\s*\\{\\s*(${names})\\s*\\}`, "g");
  let match;

  while ((match = pattern.exec(source))) {
    const [, command, name] = match;
    if (command === "begin") {
      const bodyFrom = findEnvironmentBadgeAnchor(source, pattern.lastIndex);
      stack.push({
        name,
        targetKind: DEFINITION_ENVIRONMENTS.has(name) ? "definition" : "theorem",
        from: match.index,
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
  const targetText = body
    .replace(/^[ \t]*%\s*lea:.*(?:\r?\n|$)/gmi, "")
    .replace(/\\label\s*\{[^}]*\}/g, "")
    .trim();
  return { targetText, latexLabel: labelMatch ? labelMatch[1].trim() : "" };
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

function parseBalancedSuffix(source, cursor) {
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

function skipInlineWhitespace(source, cursor) {
  while (cursor < source.length && /[ \t]/.test(source[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function isLineBreak(char) {
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
