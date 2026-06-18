// LeaUI v2 frontend API client — the HTTP + SSE calls against /api.
//
// All shared types live in ./types and are re-exported here, so existing
// `import { Foo } from "./api"` sites keep working; new code can import types
// straight from ./types.

import type {
  ApprovalDecision,
  SessionSummary,
  SessionStatus,
  ChatMessage,
  CodeStep,
  SafeVerifyStatus,
  SessionDetail,
  Project,
  ProjectDetail,
} from './types';

export * from './types';

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

// ── Projects (v2.1) ────────────────────────────────────────────────────────────
export async function listProjects(): Promise<Project[]> {
  const response = await fetch('/api/projects');
  if (!response.ok) throw new Error(`Failed to load projects: ${response.statusText}`);
  const data = await response.json();
  return Array.isArray(data.projects) ? data.projects : [];
}

export async function getProject(projectId: string): Promise<ProjectDetail> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`);
  if (!response.ok) throw new Error(`Failed to load project: ${response.statusText}`);
  return response.json();
}

export async function createProject(title: string, description?: string): Promise<Project> {
  const response = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, description }),
  });
  if (!response.ok) {
    throw new Error(await detailMessage(response, `Failed to create project: ${response.statusText}`));
  }
  return response.json();
}

export async function updateProject(
  projectId: string,
  update: { title?: string; description?: string },
): Promise<Project> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  });
  if (!response.ok) {
    throw new Error(await detailMessage(response, `Failed to update project: ${response.statusText}`));
  }
  return response.json();
}

export async function deleteProject(projectId: string): Promise<void> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
  if (!response.ok) {
    throw new Error(await detailMessage(response, `Failed to delete project: ${response.statusText}`));
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
export interface ModelOption { value: string; label: string; family?: string }
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
