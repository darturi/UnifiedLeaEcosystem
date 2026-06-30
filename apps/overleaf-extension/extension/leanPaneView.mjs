// Pure, DOM-free helpers for the Overleaf Lean project pane.
//
// These live in their own module so they can be unit-tested directly: the content
// script that consumes them (content.js) is a classic IIFE that the test runner
// can't import, so any logic worth testing is pulled out here. content.js loads
// this module lazily via `import(chrome.runtime.getURL("leanPaneView.mjs"))` (the
// same web-accessible-resource pattern as zipTex.mjs / targetParserCore.mjs).

const PANE_STATUS_LABELS = {
  "missing-stub": "missing stub",
  "stub-generated": "stub generated",
  valid: "valid",
  defined: "defined",
  // A verified disproof is surfaced as a counterexample: a successful result, but
  // not a proof of the stated theorem (FEATURE-counterexample-workflows.md).
  disproved: "counterexample",
  "in-progress": "in progress",
  invalid: "invalid",
  stale: "stale",
  error: "error",
  unknown: "unknown"
};

const LEAN_KEYWORDS = new Set([
  "theorem", "lemma", "def", "example", "instance", "structure", "class", "inductive",
  "abbrev", "import", "open", "namespace", "end", "section", "variable", "variables",
  "by", "fun", "let", "have", "show", "from", "with", "do", "return", "match",
  "if", "then", "else", "calc", "where", "deriving", "attribute", "set_option",
  "exact", "apply", "intro", "intros", "refine", "rw", "rewrite", "simp", "simpa",
  "ring", "linarith", "nlinarith", "omega", "norm_num", "constructor", "cases",
  "rcases", "rintro", "obtain", "use", "exists", "induction", "sorry", "admit",
  "unfold", "dsimp", "subst", "contradiction", "assumption", "trivial", "decide"
]);

const LEAN_TOKEN_RE = /(--[^\n]*)|("(?:[^"\\]|\\.)*")|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_']*)|(\s+)|([^\sA-Za-z0-9_]+)/g;

const MATH_COMMANDS = new Map([
  ["alpha", "α"], ["beta", "β"], ["gamma", "γ"], ["delta", "δ"],
  ["epsilon", "ε"], ["varepsilon", "ε"], ["zeta", "ζ"], ["eta", "η"],
  ["theta", "θ"], ["vartheta", "ϑ"], ["iota", "ι"], ["kappa", "κ"],
  ["lambda", "λ"], ["mu", "μ"], ["nu", "ν"], ["xi", "ξ"],
  ["pi", "π"], ["rho", "ρ"], ["sigma", "σ"], ["tau", "τ"],
  ["upsilon", "υ"], ["phi", "φ"], ["varphi", "φ"], ["chi", "χ"],
  ["psi", "ψ"], ["omega", "ω"], ["Gamma", "Γ"], ["Delta", "Δ"],
  ["Theta", "Θ"], ["Lambda", "Λ"], ["Xi", "Ξ"], ["Pi", "Π"],
  ["Sigma", "Σ"], ["Phi", "Φ"], ["Psi", "Ψ"], ["Omega", "Ω"],
  ["forall", "∀"], ["exists", "∃"], ["in", "∈"], ["notin", "∉"],
  ["subset", "⊂"], ["subseteq", "⊆"], ["supset", "⊃"], ["supseteq", "⊇"],
  ["cup", "∪"], ["cap", "∩"], ["emptyset", "∅"], ["varnothing", "∅"],
  ["to", "→"], ["rightarrow", "→"], ["mapsto", "↦"], ["leftarrow", "←"],
  ["Rightarrow", "⇒"], ["implies", "⇒"], ["iff", "⇔"], ["leftrightarrow", "↔"],
  ["le", "≤"], ["leq", "≤"], ["ge", "≥"], ["geq", "≥"], ["neq", "≠"],
  ["ne", "≠"], ["approx", "≈"], ["equiv", "≡"], ["sim", "∼"],
  ["cdot", "·"], ["times", "×"], ["pm", "±"], ["setminus", "∖"],
  ["partial", "∂"], ["nabla", "∇"], ["infty", "∞"], ["infinity", "∞"],
  ["land", "∧"], ["lor", "∨"], ["neg", "¬"], ["bot", "⊥"], ["top", "⊤"],
  ["mid", "∣"], ["vert", "∣"], ["parallel", "∥"], ["ldots", "…"], ["cdots", "⋯"]
]);

const DOUBLE_STRUCK = {
  A: "𝔸", B: "𝔹", C: "ℂ", D: "𝔻", E: "𝔼", F: "𝔽", G: "𝔾", H: "ℍ",
  I: "𝕀", J: "𝕁", K: "𝕂", L: "𝕃", M: "𝕄", N: "ℕ", O: "𝕆", P: "ℙ",
  Q: "ℚ", R: "ℝ", S: "𝕊", T: "𝕋", U: "𝕌", V: "𝕍", W: "𝕎", X: "𝕏",
  Y: "𝕐", Z: "ℤ"
};

export function formatPaneStatus(status) {
  return PANE_STATUS_LABELS[status] || "unknown";
}

export function capitalize(value) {
  const text = String(value || "");
  return text ? `${text.slice(0, 1).toUpperCase()}${text.slice(1)}` : "";
}

export function parsePaneLatex(source) {
  const text = String(source || "");
  const segments = [];
  let cursor = 0;

  while (cursor < text.length) {
    const next = findNextMathDelimiter(text, cursor);
    if (!next) {
      appendPaneLatexSegment(segments, { type: "text", text: text.slice(cursor) });
      break;
    }
    if (next.index > cursor) {
      appendPaneLatexSegment(segments, { type: "text", text: text.slice(cursor, next.index) });
    }

    const contentStart = next.index + next.open.length;
    const closeIndex = findClosingMathDelimiter(text, contentStart, next);
    if (closeIndex === -1) {
      appendPaneLatexSegment(segments, { type: "text", text: text.slice(next.index) });
      break;
    }

    appendPaneLatexSegment(segments, {
      type: "math",
      text: text.slice(contentStart, closeIndex),
      display: next.display
    });
    cursor = closeIndex + next.close.length;
  }

  return segments;
}

export function formatLiteMath(source) {
  const text = normalizeLiteMath(String(source || ""));
  const segments = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== "^" && char !== "_") {
      appendMathPart(segments, { type: "text", text: cleanMathText(char) });
      continue;
    }

    const parsed = parseMathScriptArgument(text, index + 1);
    if (!parsed) {
      appendMathPart(segments, { type: "text", text: char });
      continue;
    }
    appendMathPart(segments, {
      type: char === "^" ? "sup" : "sub",
      text: cleanMathText(parsed.text)
    });
    index = parsed.end - 1;
  }

  return segments.filter((segment) => segment.text);
}

export function highlightLeanLine(line) {
  const text = String(line || "");
  if (!text) return [];
  const spans = [];
  let match;
  LEAN_TOKEN_RE.lastIndex = 0;
  while ((match = LEAN_TOKEN_RE.exec(text)) !== null) {
    const [, comment, str, num, word, space, sym] = match;
    if (comment !== undefined) spans.push({ cls: "com", text: comment });
    else if (str !== undefined) spans.push({ cls: "str", text: str });
    else if (num !== undefined) spans.push({ cls: "num", text: num });
    else if (word !== undefined) spans.push({ cls: classifyLeanWord(word), text: word });
    else if (space !== undefined) spans.push({ cls: "", text: space });
    else if (sym !== undefined) spans.push({ cls: "", text: sym });
  }
  return spans;
}

// Decide whether the pane must re-download the whole project archive, or can reuse
// the cached file set and just overlay the live active-editor buffer. A full fetch
// is only needed on an explicit request (manual refresh / first open) or when the
// project changed — ordinary edits to the active file are handled by the overlay, so
// typing no longer triggers a project download on every keystroke.
export function shouldRefetchLeanPaneFiles({ forceFetch, lastFiles, lastProjectId, projectId } = {}) {
  if (forceFetch) return true;
  if (!Array.isArray(lastFiles) || lastFiles.length === 0) return true;
  return lastProjectId !== projectId;
}

// Replace the cached content of the active file with the live editor buffer. Only
// overrides a path that already exists in the set — never invents a file — so a
// misread active path can't inject a spurious entry. Mutates and returns `files`.
export function overlayActiveTex(files, activePath, activeContent) {
  if (!Array.isArray(files)) return files;
  if (!activePath || typeof activeContent !== "string") return files;
  const wanted = String(activePath).replace(/^\/+/, "");
  const existing = files.find((file) => file && file.path === wanted);
  if (existing) existing.content = activeContent;
  return files;
}

// True when any manifest item is still being formalized — the signal the pane uses
// to keep polling and then stop once everything settles.
export function hasInProgressItems(items) {
  return Array.isArray(items) && items.some((item) => item && item.inProgress);
}

// Pane statuses where starting (or restarting) a formalization run is meaningful.
// Terminal-good states (valid / defined / disproved) and a running job are excluded.
const FORMALIZABLE_PANE_STATUSES = new Set([
  "missing-stub", "stub-generated", "stale", "invalid", "unknown", "error"
]);

// Whether the pane should offer a Formalize action for an item: it must be a valid
// marker target, not already running, and in an actionable state.
export function canFormalizePaneItem(item) {
  if (!item || !item.formalizable || item.inProgress) return false;
  return FORMALIZABLE_PANE_STATUSES.has(item.status);
}

// Shape a manifest item into the target payload the existing /formalize flow expects.
export function paneItemToFormalizeTarget(item) {
  return {
    targetKind: item?.leanKind === "def" ? "definition" : "theorem",
    targetLabel: item?.leanDeclarationName || item?.label || "",
    targetText: item?.naturalLanguageLatex || "",
    targetUses: Array.isArray(item?.targetUses) ? item.targetUses : [],
    targetContext: item?.targetContext || ""
  };
}

function findNextMathDelimiter(text, cursor) {
  const delimiters = [
    { open: "$$", close: "$$", display: true },
    { open: "\\[", close: "\\]", display: true },
    { open: "\\(", close: "\\)", display: false },
    { open: "$", close: "$", display: false }
  ];
  let best = null;
  for (const delimiter of delimiters) {
    let index = cursor;
    while (index < text.length) {
      index = text.indexOf(delimiter.open, index);
      if (index === -1) break;
      if (delimiter.open === "$" && text[index + 1] === "$") {
        index += 2;
        continue;
      }
      if (!isEscaped(text, index)) {
        if (!best || index < best.index || (index === best.index && delimiter.open.length > best.open.length)) {
          best = { ...delimiter, index };
        }
        break;
      }
      index += delimiter.open.length;
    }
  }
  return best;
}

function findClosingMathDelimiter(text, cursor, delimiter) {
  let index = cursor;
  while (index < text.length) {
    index = text.indexOf(delimiter.close, index);
    if (index === -1) return -1;
    if (!isEscaped(text, index)) return index;
    index += delimiter.close.length;
  }
  return -1;
}

function isEscaped(text, index) {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function appendPaneLatexSegment(segments, segment) {
  if (!segment.text) return;
  const previous = segments[segments.length - 1];
  if (previous && previous.type === "text" && segment.type === "text") {
    previous.text += segment.text;
  } else {
    segments.push(segment);
  }
}

function normalizeLiteMath(source) {
  let text = source
    .replace(/\r?\n/g, " ")
    .replace(/\\(?:left|right)\b/g, "")
    .replace(/\\(?:quad|qquad|,|;|:|!)/g, " ");

  for (let i = 0; i < 3; i += 1) {
    text = text
      .replace(/\\mathbb\s*\{([A-Za-z])\}/g, (_match, letter) => DOUBLE_STRUCK[letter] || letter)
      .replace(/\\(?:mathrm|operatorname|text|textit|textbf)\s*\{([^{}]*)\}/g, "$1")
      .replace(/\\sqrt\s*\{([^{}]*)\}/g, "√($1)")
      .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "($1)/($2)");
  }

  return text
    .replace(/\\([{}])/g, "$1")
    .replace(/\\([A-Za-z]+)\b/g, (_match, command) => MATH_COMMANDS.get(command) || command)
    .replace(/\s+/g, " ")
    .trim();
}

function parseMathScriptArgument(text, cursor) {
  if (cursor >= text.length) return null;
  if (text[cursor] === "{") {
    let depth = 1;
    for (let index = cursor + 1; index < text.length; index += 1) {
      if (text[index] === "{" && !isEscaped(text, index)) {
        depth += 1;
      } else if (text[index] === "}" && !isEscaped(text, index)) {
        depth -= 1;
        if (depth === 0) {
          return { text: text.slice(cursor + 1, index), end: index + 1 };
        }
      }
    }
    return null;
  }
  return { text: text[cursor], end: cursor + 1 };
}

function cleanMathText(text) {
  return String(text || "").replace(/[{}]/g, "");
}

function appendMathPart(segments, segment) {
  if (!segment.text) return;
  const previous = segments[segments.length - 1];
  if (previous && previous.type === segment.type) {
    previous.text += segment.text;
  } else {
    segments.push(segment);
  }
}

function classifyLeanWord(word) {
  if (LEAN_KEYWORDS.has(word)) return "kw";
  if (/^[A-Z]/.test(word)) return "ty";
  return "";
}
