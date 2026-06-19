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
  ProjectFile,
  ProjectGraph,
  BlueprintWarning,
  TreeEntry,
  SearchResult,
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

export interface ProjectSession {
  id: string;
  title: string;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

// Create a session that lives inside the project (D23). The run started for it
// resolves the shared project repo + namespace server-side.
export async function createSessionInProject(projectId: string, title?: string): Promise<ProjectSession> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!response.ok) {
    throw new Error(await detailMessage(response, `Failed to create session: ${response.statusText}`));
  }
  return response.json();
}

// ── Project files: upload / list / download / delete (.lea/files/, S1/S2) ──────
export async function listProjectFiles(projectId: string): Promise<ProjectFile[]> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`);
  if (!response.ok) throw new Error(await detailMessage(response, `Failed to load files: ${response.statusText}`));
  const data = await response.json();
  return Array.isArray(data.files) ? data.files : [];
}

export async function uploadProjectFile(projectId: string, file: File): Promise<ProjectFile> {
  const form = new FormData();
  form.append('file', file);
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, {
    method: 'POST',
    body: form, // no Content-Type header — the browser sets the multipart boundary
  });
  if (!response.ok) {
    throw new Error(await detailMessage(response, `Failed to upload ${file.name}: ${response.statusText}`));
  }
  return response.json();
}

export async function deleteProjectFile(projectId: string, fileId: string): Promise<void> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}`,
    { method: 'DELETE' },
  );
  if (!response.ok) {
    throw new Error(await detailMessage(response, `Failed to delete file: ${response.statusText}`));
  }
}

// The browser navigates here to download; the route streams the stored bytes.
export function projectFileDownloadUrl(projectId: string, fileId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}`;
}

// ── Project docs: Instructions / Memory / Blueprint (.lea/*.md) ────────────────
// One pair of calls backs the markdown editors (D39). `doc` is the route segment;
// content is raw markdown in/out. Blueprint shares the same content round-trip
// (its responses also carry `warnings`, fetched separately via getProjectBlueprint).
export type ProjectDocName = 'instructions' | 'memory' | 'blueprint';

export async function getProjectDoc(projectId: string, doc: ProjectDocName): Promise<string> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/${doc}`,
  );
  if (!response.ok) {
    throw new Error(await detailMessage(response, `Failed to load ${doc}: ${response.statusText}`));
  }
  const data = await response.json();
  return typeof data.content === 'string' ? data.content : '';
}

export async function putProjectDoc(
  projectId: string,
  doc: ProjectDocName,
  content: string,
): Promise<{ content: string; commit_sha?: string }> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/${doc}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    },
  );
  if (!response.ok) {
    throw new Error(await detailMessage(response, `Failed to save ${doc}: ${response.statusText}`));
  }
  return response.json();
}

// ── Blueprint authoring + derived graph (Slice 5, D28/D29) ─────────────────────
// The blueprint's content round-trips through getProjectDoc/putProjectDoc('blueprint');
// these two add the blueprint-specific extras: structural `warnings` (advisory) and
// the parsed-and-derived dependency `graph` (node status + session attribution).

export async function getProjectBlueprint(
  projectId: string,
): Promise<{ content: string; warnings: BlueprintWarning[] }> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/blueprint`);
  if (!response.ok) {
    throw new Error(await detailMessage(response, `Failed to load blueprint: ${response.statusText}`));
  }
  const data = await response.json();
  return { content: typeof data.content === 'string' ? data.content : '', warnings: data.warnings ?? [] };
}

export async function getProjectGraph(projectId: string): Promise<ProjectGraph> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/graph`);
  if (!response.ok) {
    throw new Error(await detailMessage(response, `Failed to load graph: ${response.statusText}`));
  }
  const data = await response.json();
  return { nodes: Array.isArray(data.nodes) ? data.nodes : [], edges: Array.isArray(data.edges) ? data.edges : [] };
}

// ── Filesystem tab: tree / read / edit / export the project repo (Slice 6, D34) ─
// The project is already a git repo, so this is mostly exposure: browse the tree,
// read/edit any file (write+commit, path-guarded), download the whole thing.

export async function getProjectTree(projectId: string): Promise<TreeEntry[]> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/tree`);
  if (!response.ok) throw new Error(await detailMessage(response, `Failed to load files: ${response.statusText}`));
  const data = await response.json();
  return Array.isArray(data.tree) ? data.tree : [];
}

// A binary/undecodable file comes back as 415; we surface that as `binary: true`
// (the viewer offers a download instead of garbled text) rather than throwing.
export async function getProjectFile(
  projectId: string,
  path: string,
): Promise<{ path: string; content: string; lean: boolean; binary: boolean }> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(path)}`,
  );
  if (response.status === 415) return { path, content: '', lean: false, binary: true };
  if (!response.ok) throw new Error(await detailMessage(response, `Failed to load ${path}: ${response.statusText}`));
  const data = await response.json();
  return { path: data.path ?? path, content: data.content ?? '', lean: !!data.lean, binary: false };
}

export async function putProjectFile(
  projectId: string,
  path: string,
  content: string,
): Promise<{ path: string; commit_sha: string; check: { status: 'ok' | 'error'; detail?: string | null } | null }> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/file`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content }),
  });
  if (!response.ok) throw new Error(await detailMessage(response, `Failed to save ${path}: ${response.statusText}`));
  return response.json();
}

// The browser navigates here to download the project as a zip.
export function projectExportUrl(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/export`;
}

// ── Global search (Slice 7, D41) ──────────────────────────────────────────────
// Sessions matching the query by their own title or their project's title, each
// tagged with its project. The only way to reach a project session (sidebar-hidden).
export async function searchSessions(query: string): Promise<SearchResult[]> {
  const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
  if (!response.ok) throw new Error(await detailMessage(response, `Search failed: ${response.statusText}`));
  const data = await response.json();
  return Array.isArray(data.results) ? data.results : [];
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

// Per-origin rollup across sessions (store.usage_stats → "origins"): Direct (UI) vs
// Overleaf extension. Internal to UsageStats.
interface UsageOriginRow {
  origin: 'ui' | 'overleaf' | string;
  session_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

export interface UsageStats {
  sessions: UsageSessionSummary[];
  global: UsageGlobals;
  daily: UsageDay[];
  models: UsageModelRow[];
  origins: UsageOriginRow[];
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
