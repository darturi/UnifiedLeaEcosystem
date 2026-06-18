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

// ────────────────────────────────────────────────────────────────────────────
// HTTP
// ────────────────────────────────────────────────────────────────────────────

async function detailMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => ({} as any));
  if (typeof body.detail === 'string') return body.detail;
  if (body.detail?.message) return body.detail.message;
  if (typeof body.message === 'string') return body.message;
  return fallback;
}

export async function listSessions(): Promise<SessionSummary[]> {
  const response = await fetch('/api/sessions');
  if (!response.ok) throw new Error(`Failed to load sessions: ${response.statusText}`);
  const data = await response.json();
  return Array.isArray(data.sessions) ? data.sessions : [];
}

export async function getSession(sessionId: string): Promise<SessionDetail> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
  if (!response.ok) throw new Error(`Failed to load session: ${response.statusText}`);
  return response.json();
}

export async function createRun(
  message: string,
  sessionId?: string,
): Promise<{ session_id: string; run_id: string; message: ChatMessage }> {
  const response = await fetch('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, session_id: sessionId }),
  });
  if (!response.ok) {
    throw new Error(await detailMessage(response, `Failed to start run: ${response.statusText}`));
  }
  return response.json();
}

export async function submitApproval(
  runId: string,
  approvalId: string,
  decision: ApprovalDecision,
): Promise<void> {
  const response = await fetch(
    `/api/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    },
  );
  if (!response.ok) {
    throw new Error(await detailMessage(response, `Failed to submit decision: ${response.statusText}`));
  }
}

export async function interruptRun(runId: string): Promise<void> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/interrupt`, { method: 'POST' });
  if (!response.ok && response.status !== 409) {
    throw new Error(await detailMessage(response, `Failed to interrupt run: ${response.statusText}`));
  }
}

// ── Writeable canvas + manual checks (F5 wires the UI to these) ────────────────
export interface FileWriteResult {
  unchanged: boolean;
  code_step?: CodeStep | null;
  note?: ChatMessage | null;
}

export async function writeSessionFile(
  sessionId: string,
  path: string,
  content: string,
  note?: string,
): Promise<FileWriteResult> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content, note }),
  });
  if (!response.ok) {
    throw new Error(await detailMessage(response, `Failed to save file: ${response.statusText}`));
  }
  return response.json();
}

export async function leanCheckSession(
  sessionId: string,
  path?: string,
): Promise<{ path: string; status: 'ok' | 'error'; detail?: string | null }> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/lean-check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!response.ok) {
    throw new Error(await detailMessage(response, `lean_check failed: ${response.statusText}`));
  }
  return response.json();
}

export async function verifySession(
  sessionId: string,
  path?: string,
): Promise<{ path: string; status: SafeVerifyStatus; detail?: string | null }> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!response.ok) {
    throw new Error(await detailMessage(response, `Verify failed: ${response.statusText}`));
  }
  return response.json();
}

// ────────────────────────────────────────────────────────────────────────────
// Settings / Stats / Models  (F6 rewires the pages; the endpoints already exist)
// ────────────────────────────────────────────────────────────────────────────

export interface AppSettings {
  model?: string;
  max_turns?: number | null;
  max_spend_usd?: number | null;
  current_spend_usd?: number;
  api_keys?: Record<string, { configured: boolean; last4?: string | null; label: string }>;
  model_options?: { value: string; label: string; family?: string }[];
  [key: string]: unknown;
}

export interface SettingsUpdate {
  model?: string;
  max_turns?: number | null;
  max_spend_usd?: number | null;
  api_keys?: Record<string, { value?: string; clear?: boolean }>;
}

export interface ModelCatalogEntry { value: string; label: string; provider: string }
export interface ModelRequiredKey { env: string; label: string; configured: boolean }
export interface ModelRequirements {
  model: string;
  provider?: string | null;
  required_keys: ModelRequiredKey[];
  satisfied: boolean;
}

// A session row as returned by GET /api/stats. Same shape as SessionSummary, but
// a live session can report status 'running' (used to drive the stats live-refresh).
export interface UsageSessionSummary extends Omit<SessionSummary, 'status'> {
  status: SessionStatus | 'running';
}

// All-time rollups (store.usage_stats → "global"). Internal to UsageStats.
interface UsageGlobals {
  session_count: number;
  message_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  average_tokens_per_session: number;
  average_cost_per_session: number;
  average_messages_per_session: number;
}

// One calendar day of run usage (store.usage_stats → "daily"). Internal to UsageStats.
interface UsageDay {
  day: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  run_count: number;
  session_count: number;
}

// Per-model rollup across runs (store.usage_stats → "models"). Internal to UsageStats.
interface UsageModelRow {
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  run_count: number;
  session_count: number;
}

export interface UsageStats {
  sessions: UsageSessionSummary[];
  global: UsageGlobals;
  daily: UsageDay[];
  models: UsageModelRow[];
}

export async function getSettings(): Promise<AppSettings> {
  const response = await fetch('/api/settings');
  if (!response.ok) throw new Error(`Failed to load settings: ${response.statusText}`);
  return response.json();
}

export async function saveSettings(update: SettingsUpdate): Promise<AppSettings> {
  const response = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  });
  if (!response.ok) {
    const error = new Error(await detailMessage(response, `Failed to save settings: ${response.statusText}`));
    throw error;
  }
  return response.json();
}

export async function fetchModelCatalog(): Promise<ModelCatalogEntry[]> {
  const response = await fetch('/api/models');
  if (!response.ok) throw new Error(`Failed to load models: ${response.statusText}`);
  const data = await response.json();
  return Array.isArray(data.models) ? data.models : [];
}

export async function fetchModelRequirements(model: string): Promise<ModelRequirements> {
  const response = await fetch(`/api/models/requirements?model=${encodeURIComponent(model)}`);
  if (!response.ok) throw new Error(`Failed to load model requirements: ${response.statusText}`);
  return response.json();
}

export async function getUsageStats(): Promise<UsageStats> {
  const response = await fetch('/api/stats');
  if (!response.ok) throw new Error(`Failed to load statistics: ${response.statusText}`);
  return response.json();
}
