export type SessionStatus = 'running' | 'success' | 'failed' | 'max_turns';

export interface SessionSummary {
  id: string;
  title: string;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
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

export interface SessionDetail extends SessionSummary {
  messages: ChatMessage[];
  code_steps: CodeStep[];
  status_events: StatusEvent[];
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
