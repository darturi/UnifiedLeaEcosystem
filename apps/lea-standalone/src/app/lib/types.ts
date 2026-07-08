// LeaUI v2 frontend API client.
//
// One source of truth for the HTTP + SSE contract the v2 adapter exposes under
// /api. Git owns proof content; the DB is a pointer+verdict index. Both messages
// and code steps carry an authoritative `seq` (the shared timeline, C4), so the
// frontend never reconstructs ordering — it merges on `seq`.

// ── Session-level status (derived in store.list_sessions) ──────────────────────
// 'running' = a session with no code yet but an active run, so a freshly registered
// formalization (including an Overleaf-driven one) shows as in-progress immediately;
// once code exists the working-copy verdict takes over.
export type SessionStatus =
  | 'empty'
  | 'unchecked'
  | 'ok'
  | 'error'
  | 'running'
  | 'proved'
  | 'defined'
  | 'disproved';
// ── Run-level status (a single proof attempt) ─────────────────────────────────
// 'proved' / 'disproved' are checked-artifact outcomes; 'needs_review' is
// preserved as classifier metadata, not a primary session/code status.
// 'answered' = a chat / QA / sketch turn that finished cleanly but proved nothing.
export type RunStatus =
  | 'pending'
  | 'running'
  | 'proved'
  | 'disproved'
  | 'needs_review'
  | 'answered'
  | 'max_turns'
  | 'cancelled'
  | 'failed';

export interface RunSummary {
  id: string;
  status: RunStatus | string;
  result_kind?: 'proved' | 'disproved' | 'needs_review' | string | null;
  result_detail?: string | null;
}
// ── Per-tool approval gate (D19) ──────────────────────────────────────────────
export type GatedTool = 'bash' | 'write_file' | 'edit_file';
export type ApprovalDecision = 'allow' | 'deny' | 'always_session';

export interface SessionSummary {
  id: string;
  project_id?: string | null;
  title: string;
  status: SessionStatus;
  // Session origin / providence: 'ui' = interactive Lea UI (default), 'overleaf' =
  // spawned from the Overleaf extension. `origin_url` is the canonical Overleaf
  // document URL for an Overleaf-originated session (used to open/focus the source).
  origin?: 'ui' | 'overleaf' | string;
  origin_url?: string | null;
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

// ── Projects (v2.1) ───────────────────────────────────────────────────────────
// A project is a shared dir + git repo + this index row (D21). The slug is
// immutable and determines the namespace `Lea.<Project>` + repo path (D22).
// `session_count` is present on the list endpoint; `description`/`remote_url` are
// nullable metadata. Instructions/Memory/Blueprint are `.lea/*.md` files, not
// fields here.
export interface Project {
  id: string;
  slug: string;
  title: string;
  description?: string | null;
  namespace: string;
  repo_path: string;
  remote_url?: string | null;
  created_at: string;
  updated_at: string;
  session_count?: number;
}

// GET /api/projects/{id}: the project meta plus its sessions (the project window).
export interface ProjectDetail extends Project {
  sessions: SessionSummary[];
}

// An uploaded reference doc (D27). Bytes live in the project repo under
// `.lea/files/`; this row is the pointer + extraction metadata. `extracted_path`
// is the `.txt` sidecar for Tier-2 (pdf/docx); null for native text + images.
export interface ProjectFile {
  id: string;
  project_id: string;
  filename: string;
  stored_path: string;
  mime?: string | null;
  kind: string;
  extracted_path?: string | null;
  created_at: string;
}

// ── Skills (Skill Factory, v2.1.1) ────────────────────────────────────────────
// A skill is a DB row: a markdown `body` (procedural knowledge) injected into the
// prover's system prompt for the runs it resolves for. Scope (D47): `is_global`
// → every project; else the projects in `project_ids`; loose sessions get none.
// `source_url`/`source_ref` record GitHub provenance for an imported skill.
export interface Skill {
  id: string;
  name: string;
  slug: string;
  body: string;
  is_global: boolean;
  project_ids: string[];
  source_url?: string | null;
  source_ref?: string | null;
  created_at: string;
  updated_at: string;
}

// ── Blueprint & derived graph (v2.1 Slice 5, D28/D29) ─────────────────────────
// The blueprint is `.lea/blueprint.md` (markdown-canonical); the graph is parsed +
// derived on read. Status is derived from live Lean state, never stored.
export type BlueprintStatus = 'planned' | 'stated' | 'ready' | 'proved' | 'failed';

// A structural warning from the validator (advisory — never blocks a save). `node`
// is the section key it concerns, or null for whole-file issues.
export interface BlueprintWarning {
  node: string | null;
  message: string;
}

// One session that committed a node's `lean:` file, newest first (D29).
export interface GraphNodeSession {
  session_id: string;
  title: string;
  last_at: string;
}

export interface GraphNode {
  key: string;
  kind: string | null;        // definition | lemma | theorem (shape)
  lean: string | null;        // the live decl, once named
  uses: string[];             // dependency keys (edges)
  statement: string;
  file: string | null;        // repo-relative file resolved for the decl, if any
  status: BlueprintStatus;    // derived from live state (color)
  verified: boolean;          // proved AND SafeVerify-audited (audit-grade, above proved)
  sessions: GraphNodeSession[];
  last_modified_by: string | null;
}

export interface GraphEdge {
  from: string;               // dependent node key
  to: string;                 // dependency node key
}

export interface ProjectGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ── Global search (v2.1 Slice 7, D41) ─────────────────────────────────────────
// A search hit is a session, tagged with its project (null for loose chats) so the
// ⌘K overlay can section "Loose chats" vs "Inside projects". The only path to a
// project session, which the sidebar hides.
export interface SearchResult {
  id: string;
  title: string;
  status: SessionStatus;
  updated_at: string;
  project_id: string | null;
  project_title?: string | null;
  project_namespace?: string | null;
}

// ── Filesystem tab (v2.1 Slice 6, D34) ────────────────────────────────────────
// The project repo as a browsable tree. A dir carries `children`; a file carries
// `size`. `path` is repo-relative POSIX. `.git/`/`.lake/` are hidden server-side.
export interface TreeEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size?: number;
  children?: TreeEntry[];
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
  artifact_kind?: 'proof' | 'definition' | 'mixed' | 'unknown' | string | null;
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
  result_kind?: string | null;
  result_detail?: string | null;
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
export interface DoneEvent {
  status: RunStatus;
  result_kind?: string | null;
  result_detail?: string | null;
}

// ── Frontend-derived timeline (built from messages + code steps by timeline.mjs) ──
export type TimelineItem =
  | { kind: 'message'; key: string; message: ChatMessage }
  | { kind: 'code'; key: string; step: CodeStep; codeIndex: number };
