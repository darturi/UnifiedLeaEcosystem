import { createHash } from "node:crypto";

const THEOREM_PREFIX = "\\theorem";
const LABEL_PREFIX = "[label=";
const LATEX_LABEL_PREFIX = "\\label";

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

  let label = null;

  if (source.startsWith(LABEL_PREFIX, cursor)) {
    const labelStart = cursor + LABEL_PREFIX.length;
    const labelEnd = source.indexOf("]", labelStart);
    if (labelEnd === -1) {
      return { ok: false, reason: "unterminated label" };
    }
    label = source.slice(labelStart, labelEnd).trim();
    cursor = skipWhitespace(source, labelEnd + 1);
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
        let theoremEnd = cursor + 1;
        const labelResult = label
          ? { ok: true, label, end: theoremEnd }
          : parseTrailingLatexLabel(source, theoremEnd);
        if (!labelResult.ok) {
          return labelResult;
        }
        theoremEnd = labelResult.end;
        if (!isValidLeanIdentifier(labelResult.label)) {
          return { ok: false, reason: "invalid label" };
        }

        return {
          ok: true,
          theorem: {
            label: labelResult.label,
            text: source.slice(bodyStart, bodyEnd).trim(),
            from: start,
            to: theoremEnd,
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

function parseTrailingLatexLabel(source, cursor) {
  cursor = skipWhitespace(source, cursor);
  if (!source.startsWith(LATEX_LABEL_PREFIX, cursor)) {
    return { ok: false, reason: "missing label" };
  }

  cursor = skipWhitespace(source, cursor + LATEX_LABEL_PREFIX.length);
  if (source[cursor] !== "{") {
    return { ok: false, reason: "missing label body" };
  }

  const labelStart = cursor + 1;
  const labelEnd = source.indexOf("}", labelStart);
  if (labelEnd === -1) {
    return { ok: false, reason: "unterminated label body" };
  }

  return {
    ok: true,
    label: source.slice(labelStart, labelEnd).trim(),
    end: labelEnd + 1
  };
}

function skipWhitespace(source, cursor) {
  while (cursor < source.length && /\s/.test(source[cursor])) {
    cursor += 1;
  }
  return cursor;
}
