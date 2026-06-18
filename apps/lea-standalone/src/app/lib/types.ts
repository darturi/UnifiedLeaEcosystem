// LeaUI v2 frontend API client.
//
// One source of truth for the HTTP + SSE contract the v2 adapter exposes under
// /api. Git owns proof content; the DB is a pointer+verdict index. Both messages
// and code steps carry an authoritative `seq` (the shared timeline, C4), so the
// frontend never reconstructs ordering — it merges on `seq`.

// ── Session-level status (derived in store.list_sessions) ──────────────────────
export type SessionStatus = 'empty' | 'unchecked' | 'ok' | 'error';
// ── Run-level status (a single proof attempt) ─────────────────────────────────
// 'success' = the agent passed the final verification gate (theorem proved — this
// is what shows the green "Proved" milestone). 'answered' = a chat / QA / sketch
// turn that finished cleanly but proved nothing.
export type RunStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'answered'
  | 'max_turns'
  | 'cancelled'
  | 'failed';

export interface RunSummary {
  id: string;
  status: RunStatus | string;
}
// ── Per-tool approval gate (D19) ──────────────────────────────────────────────
export type GatedTool = 'bash' | 'write_file' | 'edit_file';
export type ApprovalDecision = 'allow' | 'deny' | 'always_session';

export interface SessionSummary {
  id: string;
  project_id?: string | null;
  title: string;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  ended_at?: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  run_count: number;
  message_count: number;
  code_step_count: number;
  primary_model?: string | null;
  models: string[];
  latest_check_status?: 'ok' | 'error' | 'unchecked' | null;
  duration_seconds: number;
}

export interface ChatMessage {
  id: string;
  session_id: string;
  run_id?: string | null;
  role: 'user' | 'assistant';
  content: string;
  kind?: 'assistant' | 'edit_note' | string;
  commit_sha?: string | null;
  seq?: number;
  created_at: string;
  // Frontend-only marker for the streaming bubble before its persisted twin lands.
  live?: boolean;
}

export interface CodeStep {
  id: string;
  session_id: string;
  run_id?: string | null;
  seq?: number;
  turn?: number | null;
  author: 'agent' | 'user';
  path: string;
  commit_sha: string;
  summary?: string | null;
  check_status?: 'ok' | 'error' | 'unchecked' | null;
  check_detail?: string | null;
  created_at: string;
  // Hydrated from git on read; also present on the SSE `code_step` event.
  code: string;
}

export interface StatusEvent {
  id: string;
  session_id?: string;
  run_id?: string;
  step_number?: number | null;
  status?: string | null;
  message: string;
  turn?: number | null;
  check_status?: 'ok' | 'error' | null;
  check_detail?: string | null;
  created_at: string;
}

// A paused tool call awaiting a human decision (live only).
export interface PendingApproval {
  approval_id: string;
  run_id: string;
  session_id: string;
  tool_name: GatedTool | string;
  args: Record<string, unknown>;
}

// An approval as kept in the thread history: gains a `decision` once resolved
// (so denied/allowed cards stay visible) + a synthetic `seq` for interleaving.
export type ApprovalRecord = PendingApproval & { decision?: string | null; seq?: number };

export interface ApprovalEvent {
  id: string;
  session_id?: string;
  run_id?: string;
  approval_id: string;
  tool_name?: string | null;
  args?: Record<string, unknown> | null;
  decision?: ApprovalDecision | string | null;
  resolved_at?: string | null;
}

export type SafeVerifyStatus = 'ok' | 'rejected' | 'error' | 'unavailable' | 'running' | 'pending';

export interface SafeVerifyResult {
  run_id?: string;
  status: SafeVerifyStatus;
  detail?: string | null;
}

export interface UsageBreakdownRow {
  id: string;
  session_id?: string;
  run_id?: string;
  run_number: number;
  ordinal: number;
  phase: string;
  label: string;
  turn?: number | null;
  candidate?: number | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  event_count: number;
  created_at?: string;
}

export interface ActiveRun {
  id: string;
  status: RunStatus | string;
  model?: string;
  pending_approval?: PendingApproval | null;
}

export interface SessionDetail extends SessionSummary {
  messages: ChatMessage[];
  code_steps: CodeStep[];
  status_events: StatusEvent[];
  approval_events: ApprovalEvent[];
  usage_breakdown: UsageBreakdownRow[];
  active_run?: ActiveRun | null;
  runs?: RunSummary[];
  safe_verify?: SafeVerifyResult | null;
}

// ── SSE event payloads (GET /api/runs/{run_id}/events) ─────────────────────────
export interface AssistantDeltaEvent { text: string }
export interface RunStatusEventPayload {
  status: string;
  message: string;
  turn?: number;
  check_status?: 'ok' | 'error';
  check_detail?: string | null;
}
export interface ApprovalResolvedEvent { approval_id: string; decision: ApprovalDecision }
export interface RunErrorEvent { message: string }
export interface DoneEvent { status: RunStatus }

// ── Frontend-derived timeline (built from messages + code steps by timeline.mjs) ──
export type TimelineItem =
  | { kind: 'message'; key: string; message: ChatMessage }
  | { kind: 'code'; key: string; step: CodeStep; codeIndex: number };
