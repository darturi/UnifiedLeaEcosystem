// Pure, side-effect-free helpers for the Lean-pane chat mirror.
//
// The mirror is a thin Overleaf-native view of the same adapter-backed session
// the full Lea UI uses (see docs/FEATURE-overleaf-lean-pane-chat-mirror.md).
// These functions build the run prompt the companion sends to the adapter and
// reshape an adapter session detail into the compact transcript the extension
// renders. They live in their own module so server.mjs and the test suite can
// import them without the HTTP layer.

import { slugProjectId } from "../shared/leanStub.mjs";

// Shown to Lea when the Overleaf source changed after the recorded Lean artifact
// was generated (spec: "Behavior Details" / "Prompt Contract").
export const CHAT_STALE_NOTE =
  "Note: the Overleaf source changed after the known Lean artifact was generated.";

// Adapter message rows the mirror hides by default. Verbose tool narration is
// not rewritten or deleted — it stays in the canonical session — but the
// Overleaf surface only renders user/assistant prose (spec: "Streaming" /
// "Behavior Details": "may hide verbose tool narration by default").
const HIDDEN_MESSAGE_KINDS = new Set([
  "tool", "tool_call", "tool_result", "tool_narration", "narration"
]);
const VISIBLE_MESSAGE_ROLES = new Set(["user", "assistant"]);

// The association/job key for a target. Intentionally identical to the companion
// job store's `jobKey` (`buildLeaTarget`), so a chat resolves to the same session
// a formalization run recorded for the target — no duplicate identity scheme.
export function chatTargetKey({ overleafProjectId, targetKind, targetLabel }) {
  return `${slugProjectId(overleafProjectId)}:${targetKind}:${targetLabel}`;
}

// Build the adapter run message for a chat send.
//
// First message (creating the session) carries the full theorem context preamble
// so Lea knows which item it is discussing. Continuations rely on the session's
// own memory and send only the user's request, prefixed with a one-line stale
// note when the Overleaf source drifted from the recorded artifact.
export function buildChatPrompt(target = {}, { stale = false, firstMessage = true, userText = "" } = {}) {
  const request = String(userText || "").trim();

  if (!firstMessage) {
    return stale ? `${CHAT_STALE_NOTE}\n\n${request}` : request;
  }

  const lines = ["You are helping with this Overleaf item.", ""];
  if (target.projectSlug) lines.push(`Project: ${target.projectSlug}`);
  lines.push(`Kind: ${target.targetKind || ""}`);
  lines.push(`Label: ${target.targetLabel || ""}`);
  if (target.latexLabel) lines.push(`LaTeX label: ${target.latexLabel}`);
  const source = formatSourceLine(target);
  if (source) lines.push(`Source file: ${source}`);
  if (target.sourceHash) lines.push(`Source hash: ${target.sourceHash}`);
  if (target.naturalLanguageLatex) {
    lines.push("Natural-language statement:");
    lines.push(String(target.naturalLanguageLatex).trim());
  }
  lines.push("");
  if (target.leanDeclarationName) lines.push(`Known Lean declaration: ${target.leanDeclarationName}`);
  if (target.recordedProofPath) lines.push(`Known Lean artifact: ${target.recordedProofPath}`);
  if (target.status) lines.push(`Known status: ${target.status}`);
  if (stale) lines.push(CHAT_STALE_NOTE);
  lines.push("User request:");
  lines.push(request);
  return lines.join("\n");
}

// Reshape an adapter `GET /api/sessions/{id}` payload into the mirror's
// ChatSessionResponse: visible bubbles (ordered by the shared per-session `seq`),
// run summaries, the active run, and the derived session status. The transcript
// is preserved verbatim — only filtered, never rewritten.
export function toChatSessionResponse(detail = {}, { targetKey = null, leaSessionId = null, leaSessionUrl = null, status = null } = {}) {
  const rawMessages = Array.isArray(detail.messages) ? detail.messages : [];
  const messages = rawMessages
    .filter(isVisibleChatMessage)
    .slice()
    .sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0))
    .map(toChatMessage);

  const runs = (Array.isArray(detail.runs) ? detail.runs : []).map(toRunSummary);
  const activeRun = detail.active_run ? toRunSummary(detail.active_run) : null;

  return {
    ok: true,
    targetKey,
    leaSessionId,
    leaSessionUrl,
    status: status || detail.status || "unknown",
    messages,
    runs,
    activeRun
  };
}

// True while the run for this session is still going — the signal the extension
// uses to keep polling and then stop once the run settles.
export function isChatRunActive(response) {
  if (!response || typeof response !== "object") return false;
  if (response.activeRun) return true;
  const status = String(response.activeRun?.status || "").toLowerCase();
  return status === "running" || status === "pending" || status === "queued";
}

function isVisibleChatMessage(message) {
  if (!message || typeof message !== "object") return false;
  if (!VISIBLE_MESSAGE_ROLES.has(String(message.role || "").toLowerCase())) return false;
  if (HIDDEN_MESSAGE_KINDS.has(String(message.kind || "").toLowerCase())) return false;
  return String(message.content || "").trim().length > 0;
}

function toChatMessage(message) {
  return {
    id: message.id || null,
    role: String(message.role || "").toLowerCase(),
    content: String(message.content || ""),
    kind: String(message.kind || "assistant"),
    createdAt: message.created_at || message.createdAt || null
  };
}

function toRunSummary(run) {
  return {
    id: run.id || null,
    status: String(run.status || "").toLowerCase() || "unknown",
    createdAt: run.created_at || run.createdAt || null
  };
}

function formatSourceLine(target) {
  const file = String(target.sourceFile || "").trim();
  if (!file) return "";
  const start = Number(target.sourceStartLine);
  const end = Number(target.sourceEndLine);
  if (Number.isFinite(start) && start > 0) {
    if (Number.isFinite(end) && end >= start) return `${file}:${start}-${end}`;
    return `${file}:${start}`;
  }
  return file;
}
