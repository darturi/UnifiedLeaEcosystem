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
  // A checked, sorry-free proof the prover flagged for human review -- not
  // "invalid" (it compiles), not "valid" (not fully confident either); see
  // server.mjs's mapLeanPaneStatus / resolveProofOutcome needs_review branch.
  "needs-review": "needs review",
  "in-progress": "in progress",
  invalid: "invalid",
  stale: "stale",
  error: "error",
  mixed: "mixed",
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

const SUCCESS_PANE_STATUSES = new Set(["valid", "defined", "disproved"]);

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

export function buildLeanPaneTree(items) {
  const root = { type: "root", children: [], childMap: new Map(), order: Number.POSITIVE_INFINITY };
  const files = new Map();
  const sortedItems = [...(Array.isArray(items) ? items : [])]
    .filter((item) => normalizePanePath(item?.sourceFile))
    .sort((a, b) => paneItemOrder(a) - paneItemOrder(b));

  for (const item of sortedItems) {
    const sourceFile = normalizePanePath(item.sourceFile);
    const parts = sourceFile.split("/").filter(Boolean);
    if (parts.length === 0) continue;

    let parent = root;
    let currentPath = "";
    for (let index = 0; index < parts.length - 1; index += 1) {
      currentPath = currentPath ? `${currentPath}/${parts[index]}` : parts[index];
      const id = paneTreeFolderId(currentPath);
      let folder = parent.childMap.get(id);
      if (!folder) {
        folder = {
          type: "folder",
          id,
          name: parts[index],
          path: currentPath,
          children: [],
          childMap: new Map(),
          itemCount: 0,
          status: "unknown",
          order: paneItemOrder(item)
        };
        parent.childMap.set(id, folder);
        parent.children.push(folder);
      }
      folder.order = Math.min(folder.order, paneItemOrder(item));
      parent = folder;
    }

    const fileName = parts[parts.length - 1];
    const fileId = paneTreeFileId(sourceFile);
    let file = parent.childMap.get(fileId);
    if (!file) {
      file = {
        type: "file",
        id: fileId,
        name: fileName,
        path: sourceFile,
        items: [],
        itemCount: 0,
        status: "unknown",
        order: paneItemOrder(item)
      };
      parent.childMap.set(fileId, file);
      parent.children.push(file);
      files.set(sourceFile, file);
    }
    file.items.push(item);
    file.itemCount = file.items.length;
    file.order = Math.min(file.order, paneItemOrder(item));
  }

  finalizePaneTreeNodes(root.children);
  return { children: root.children, files: [...files.values()] };
}

export function aggregatePaneStatus(items) {
  const statuses = (Array.isArray(items) ? items : [])
    .map((item) => String(item?.status || "unknown"))
    .filter(Boolean);
  if (statuses.length === 0) return "unknown";
  if (statuses.includes("in-progress")) return "in-progress";
  if (statuses.includes("error")) return "error";
  if (statuses.includes("invalid")) return "invalid";
  if (statuses.includes("stale")) return "stale";
  if (statuses.includes("missing-stub")) return "missing-stub";
  if (statuses.includes("stub-generated")) return "stub-generated";
  if (statuses.every((status) => SUCCESS_PANE_STATUSES.has(status))) {
    const unique = new Set(statuses);
    return unique.size === 1 ? statuses[0] : "mixed";
  }
  const unique = new Set(statuses);
  return unique.size === 1 ? statuses[0] : "mixed";
}

export function treeAncestorIdsForFile(sourceFile) {
  const parts = normalizePanePath(sourceFile).split("/").filter(Boolean);
  if (parts.length === 0) return [];
  const ids = [];
  let currentPath = "";
  for (let index = 0; index < parts.length - 1; index += 1) {
    currentPath = currentPath ? `${currentPath}/${parts[index]}` : parts[index];
    ids.push(paneTreeFolderId(currentPath));
  }
  ids.push(paneTreeFileId(parts.join("/")));
  return ids;
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

// --- Lean-pane chat mirror -------------------------------------------------

// Whether the pane should offer a Chat action for an item. The mirror needs a
// stable target identity (a Lean declaration name, falling back to the marker
// label) to resolve or create the associated Lea session.
export function canChatPaneItem(item) {
  return Boolean(item && (item.leanDeclarationName || item.label));
}

// Shape a manifest item into the LeanPaneChatTarget payload the companion's
// /lean-pane/chat/* endpoints expect.
export function paneItemToChatTarget(item, overleafProjectId) {
  return {
    overleafProjectId: String(overleafProjectId || ""),
    targetKind: item?.leanKind === "def" ? "definition" : "theorem",
    targetLabel: item?.leanDeclarationName || item?.label || "",
    latexLabel: item?.latexLabel || "",
    sourceFile: item?.sourceFile || "",
    sourceStartLine: item?.sourceStartLine,
    sourceEndLine: item?.sourceEndLine,
    sourceHash: item?.sourceHash || "",
    naturalLanguageLatex: item?.naturalLanguageLatex || "",
    leanDeclarationName: item?.leanDeclarationName || "",
    recordedProofPath: item?.leanArtifactPath || "",
    status: item?.status || ""
  };
}

// Resolve the chat panel's visual state from the current fetch/run flags and the
// latest companion response. Drives which controls are enabled and what the
// panel renders (spec: "UI Specification" / states).
export function nextChatState({ loading = false, sending = false, response = null, error = null } = {}) {
  if (error) return "error";
  if (response && response.ok === false) {
    return response.error === "adapter_unavailable" ? "adapter-unavailable" : "error";
  }
  if (loading) return "loading-session";
  if (sending) return "running";
  if (response && response.activeRun) return "running";
  if (response && response.status === "no-session") return "no-session";
  if (response && response.ok) return "ready";
  return "loading-session";
}

// The composer accepts input only when the session is loaded and idle. A new
// session (no-session) accepts the first message; an in-flight run does not.
export function chatComposerEnabled(state) {
  return state === "ready" || state === "no-session";
}

// True while a run is in flight — the panel shows Stop instead of Send and keeps
// polling the companion until the run settles.
export function chatRunActive(state) {
  return state === "running";
}

// CSS modifier class for a transcript bubble by author role.
export function chatBubbleClass(role) {
  return String(role).toLowerCase() === "user"
    ? "ol-lean-chat-bubble-user"
    : "ol-lean-chat-bubble-assistant";
}

// --- Lean-pane manual edit --------------------------------------------------
// docs/FEATURE-overleaf-lean-pane-manual-edit.md.

// Editing is only offered for an item that already has a recorded artifact --
// a missing-stub item has nothing to edit; "Formalize" is the right action
// there.
export function canEditPaneItem(item) {
  return Boolean(item && item.leanArtifactContent);
}

// Shape a manifest item into the LeanPaneEditTarget payload the companion's
// /lean-pane/edit/* endpoints expect. Mirrors paneItemToChatTarget's shape.
export function paneItemToEditTarget(item, overleafProjectId) {
  return {
    overleafProjectId: String(overleafProjectId || ""),
    targetKind: item?.leanKind === "def" ? "definition" : "theorem",
    targetLabel: item?.leanDeclarationName || item?.label || ""
  };
}

// The pre-save impact preview: "editing this may affect N downstream
// item(s)". Accepts either /edit/start's `dependents` or /edit/save's
// `dependentsImpact` -- both carry `targetLabel`.
export function formatDependentsImpact(dependents) {
  const list = Array.isArray(dependents) ? dependents : [];
  if (list.length === 0) return "";
  const names = list.map((d) => d?.targetLabel).filter(Boolean).join(", ");
  const count = list.length;
  return `Editing this may affect ${count} downstream item${count === 1 ? "" : "s"}: ${names}.`;
}

// The post-save outcome line for a single cascade-checked dependent --
// distinguishes a verified break (renamed vs. same-name signature change,
// feature spec acceptance criterion 8) from busy/unattributed/still-fine.
//
// `status: "unknown"` with `attributed: true` is a DIFFERENT outcome from the
// "still valid" default below, and must come before it: it means the cascade
// never actually got a trustworthy verdict for this dependent -- either the
// upstream module's rebuild itself failed (server.mjs's dependents.length>0
// branch, before any dependent is even reached) or the per-dependent
// lean-check call itself errored out (adapter unreachable, etc.). Either way
// this dependent was NOT re-checked against current source, so saying "still
// valid" here would be exactly the stale-verdict bug this whole cascade
// exists to prevent -- falling through to the same text as a genuine,
// successful recheck was a real regression caught live (a rebuild failure
// correctly skipped the per-dependent check, but still rendered as "re-
// checked, still valid").
export function formatDependentOutcome(dependent) {
  if (!dependent) return "";
  const label = dependent.targetLabel || "";
  if (dependent.busy) return `${label}: not re-checked yet (a Lea run is already in progress for it).`;
  if (dependent.brokenByUpstream?.renamed) {
    return `${label}: broken -- the declaration it referred to was renamed.`;
  }
  if (dependent.brokenByUpstream) return `${label}: broken by this edit.`;
  if (dependent.attributed === false) {
    return `${label}: may be affected, but no recorded session was found to re-check it.`;
  }
  if (dependent.status === "unknown") {
    const reason = dependent.checkDetail ? ` (${dependent.checkDetail})` : "";
    return `${label}: could not be verified${reason} -- treat as unconfirmed, not as valid.`;
  }
  return `${label}: re-checked, still valid.`;
}

function finalizePaneTreeNodes(nodes) {
  nodes.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  for (const node of nodes) {
    if (node.type === "folder") {
      finalizePaneTreeNodes(node.children);
      const descendantItems = node.children.flatMap((child) => child.type === "file" ? child.items : collectPaneTreeItems(child));
      node.itemCount = descendantItems.length;
      node.status = aggregatePaneStatus(descendantItems);
      delete node.childMap;
    } else if (node.type === "file") {
      node.items.sort((a, b) => paneItemOrder(a) - paneItemOrder(b));
      node.itemCount = node.items.length;
      node.status = aggregatePaneStatus(node.items);
    }
  }
}

function collectPaneTreeItems(node) {
  if (node.type === "file") return node.items;
  return node.children.flatMap((child) => collectPaneTreeItems(child));
}

function paneItemOrder(item) {
  const order = Number(item?.documentOrder);
  return Number.isFinite(order) ? order : Number.POSITIVE_INFINITY;
}

function paneTreeFolderId(path) {
  return `folder:${normalizePanePath(path)}`;
}

function paneTreeFileId(path) {
  return `file:${normalizePanePath(path)}`;
}

function normalizePanePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/").trim();
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

// --- Export & GitHub sharing (D34) -------------------------------------------
// Pure state derivation for the pane's Share panel, kept here (like the rest of
// this module) so the enable/disable/hint logic is unit-testable without a DOM.

/**
 * Derive the Share panel's control state.
 * @param {object} s
 * @param {boolean} s.exists - a Lea project exists for this document
 * @param {string|null} s.remoteUrl - the saved remote (from the adapter project row)
 * @param {string|undefined} s.draftRemote - the input's current value (defaults to saved)
 * @param {boolean} s.tokenConfigured - a GitHub token is set in shared settings
 * @param {boolean} [s.busy] - a save/push request is in flight
 * @returns {{canSave: boolean, canPush: boolean, hint: string}}
 */
export function deriveShareControls({ exists, remoteUrl, draftRemote, tokenConfigured, busy = false }) {
  const saved = String(remoteUrl || "").trim();
  const draft = String(draftRemote ?? saved).trim();
  if (!exists) {
    return {
      canSave: false,
      canPush: false,
      hint: "This document has no Lea project yet — formalize a theorem first."
    };
  }
  const canSave = !busy && Boolean(draft) && draft !== saved;
  const canPush = !busy && Boolean(saved) && Boolean(tokenConfigured);
  let hint = "";
  if (!saved) {
    hint = "Save a GitHub remote (https://github.com/you/repo) to enable Push.";
  } else if (!tokenConfigured) {
    hint = "Add a GitHub token in Settings to enable Push.";
  }
  return { canSave, canPush, hint };
}

// Pull `filename="…"` out of a Content-Disposition header for the zip download.
export function filenameFromContentDisposition(header, fallback = "project.zip") {
  const match = /filename="([^"]+)"/.exec(String(header || ""));
  return match ? match[1] : fallback;
}
