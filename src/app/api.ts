export type SessionStatus = 'running' | 'success' | 'failed' | 'max_turns';
export type ApprovalDecision = 'accept' | 'reject';

export interface PendingApproval {
  type: 'approval_requested';
  approval_id: string;
  tier: 'theorem_translation';
  candidate: number;
  lean_code: string;
  theorem_name?: string | null;
  check_result?: string | null;
}

export interface SessionSummary {
  id: string;
  title: string;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  message_count: number;
  run_count: number;
  models: string[];
  primary_model?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  duration_seconds: number;
}

export interface ChatMessage {
  id: string;
  session_id: string;
  run_id?: string | null;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
  is_live_terminal_summary?: boolean;
  live_started_after_assistant_steps?: number;
  live_started_after_code_steps?: number;
}

export interface CodeStep {
  id: string;
  session_id: string;
  run_id: string;
  step_number: number;
  path: string;
  code: string;
  kind?: 'code' | 'no_code';
  summary?: string | null;
  turn?: number | null;
  created_at: string;
}

export interface StatusEvent {
  id: string;
  session_id?: string;
  run_id?: string;
  step_number?: number | null;
  status?: string | null;
  message: string;
  created_at: string;
}

export interface UsageBreakdownRow {
  id: string;
  session_id?: string;
  run_id?: string;
  run_number: number;
  ordinal: number;
  phase: 'theorem_translation' | 'proof_turn' | 'unattributed' | string;
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

export interface SessionDetail extends SessionSummary {
  messages: ChatMessage[];
  code_steps: CodeStep[];
  status_events: StatusEvent[];
  usage_breakdown: UsageBreakdownRow[];
  active_run?: {
    id: string;
    status: string;
    pending_approval?: PendingApproval | null;
  } | null;
}

export interface UsageSessionSummary extends SessionSummary {}

export interface UsageGlobalStats {
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

export interface UsageDailyPoint {
  day: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  run_count: number;
  session_count: number;
}

export interface UsageModelStats {
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
  global: UsageGlobalStats;
  daily: UsageDailyPoint[];
  models: UsageModelStats[];
}

export async function listSessions(): Promise<SessionSummary[]> {
  const response = await fetch('/api/sessions');
  if (!response.ok) {
    throw new Error(`Failed to load sessions: ${response.statusText}`);
  }
  const data = await response.json();
  return data.sessions;
}

export async function getSession(sessionId: string): Promise<SessionDetail> {
  const response = await fetch(`/api/sessions/${sessionId}`);
  if (!response.ok) {
    throw new Error(`Failed to load session: ${response.statusText}`);
  }
  return response.json();
}

export async function getUsageStats(): Promise<UsageStats> {
  const response = await fetch('/api/stats');
  if (!response.ok) {
    throw new Error(`Failed to load statistics: ${response.statusText}`);
  }
  return response.json();
}

export async function createRun(message: string, sessionId?: string): Promise<{
  session_id: string;
  run_id: string;
  message: ChatMessage;
}> {
  const response = await fetch('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, session_id: sessionId }),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.detail || `Failed to create run: ${response.statusText}`);
  }
  return response.json();
}

export async function submitApproval(
  runId: string,
  approvalId: string,
  decision: ApprovalDecision,
  feedback?: string,
): Promise<void> {
  const body: { decision: ApprovalDecision; feedback?: string } = { decision };
  if (feedback !== undefined) {
    body.feedback = feedback;
  }
  const response = await fetch(`/api/runs/${runId}/approvals/${approvalId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.detail || `Failed to submit approval: ${response.statusText}`);
  }
}
