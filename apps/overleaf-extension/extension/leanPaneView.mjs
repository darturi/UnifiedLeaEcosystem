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
  invalid: "invalid",
  stale: "stale",
  error: "error",
  unknown: "unknown"
};

export function formatPaneStatus(status) {
  return PANE_STATUS_LABELS[status] || "unknown";
}

export function capitalize(value) {
  const text = String(value || "");
  return text ? `${text.slice(0, 1).toUpperCase()}${text.slice(1)}` : "";
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
