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

export function parseTheorems(source) {
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

        return {
          ok: true,
          theorem: {
            label: metadataResult.metadata.label,
            text: source.slice(bodyStart, bodyEnd).trim(),
            uses: metadataResult.metadata.uses,
            context: metadataResult.metadata.context,
            from: start,
            to: cursor + 1,
            bodyFrom: bodyStart,
            bodyTo: bodyEnd,
            sourceHash: hashTheoremText(source.slice(bodyStart, bodyEnd))
          }
        };
      }
    }

    cursor += 1;
  }

  return { ok: false, reason: "unterminated theorem body" };
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
