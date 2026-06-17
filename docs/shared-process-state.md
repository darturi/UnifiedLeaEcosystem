# Design: Shared Process State Across the UI and Overleaf Extension

**Status:** Accepted — implemented behind the `LEA_SHARED_STATE` flag (Option B, refined recorder form)
**Author:** Daniel
**Date:** 2026-06-16

> **Decision (resolved).** Both apps write to one shared database. The recording
> logic has a single owner: the Python derivation in `runner.py` is reused by a
> record-only entry point (`runner.record_run`) invoked through a small CLI
> (`app.recorder`) that the Overleaf companion spawns as a subprocess. This was
> chosen over a native-Node reimplementation because it eliminates parser drift
> and gives full parity (including project-formalization detection), and because
> the extension already requires a local Python Lea API to function — so it adds
> no new language runtime, only a bounded packaging seam. The "use either app
> alone, see the work later in the other" requirement is delivered by the shared
> database itself (an asynchronous hand-off); neither app needs the other running
> at record time.

## 1. Goal

Today the Lea UI and the Overleaf extension both drive runs against the same Lea
API (`/v1/runs`), but only the UI captures and persists the *rich process
information* produced during solving — the per-turn assistant messages, code
steps, status events, theorem-translation approvals, usage breakdown, and the
raw event log. The Overleaf companion consumes the same event stream but throws
almost all of it away, keeping only token/cost totals and turn progress in a
plain-text `.log` file plus a `jobs.json` summary.

We want an Overleaf-originated formalization to be recorded in exactly the same
shape as a UI-originated one, into a **shared database that both applications
write to**, so that the UI can render an Overleaf run's full process timeline
identically to a run it executed itself. This is the foundation for the longer
term goal: formalize from inside Overleaf, then open the UI and inspect that
formalization and its process as if it had happened in the UI.

## 2. Current architecture

### 2.1 What the UI records (the reference behavior)

The UI server (`apps/lea-ui/server`) is the component that already produces the
target artifacts.

- **`runner.py:run_lea`** is the engine. The frontend creates a session + run +
  user message via `POST /api/runs`, then opens `GET /api/runs/{run_id}/events`,
  which spawns a background thread running `run_lea`. That thread:
  1. calls `client.start_run(...)` and stores the returned `api_run_id`;
  2. streams the API's SSE events (`LeaApiClient.stream_events`, resumable via
     `from_seq` / `Last-Event-ID`);
  3. for every frame, writes a raw record to a JSONL log and derives structured
     rows;
  4. handles terminal reconciliation (final run status, transcript, "no code
     artifact" detection, post-run `lean_check` consistency checks).

- **`store.py` + `db.py`** own a SQLite database
  (`apps/lea-ui/server/data/lea-interface.sqlite3`) with the schema:
  `sessions`, `projects`, `runs`, `messages`, `code_steps`, `status_events`,
  `run_usage_breakdown`. `db.init_db()` is the canonical schema creator and
  migrator (idempotent `create table if not exists` + additive `alter table`).

- **Raw event log:** `runner._log_api_frame` appends one JSON object per API
  frame to `apps/lea-ui/server/data/lea-api-events/{local_run_id}.jsonl`. Several
  read paths (`store.approval_events_for_session`,
  `store._usage_breakdown_from_raw_logs`) reconstruct derived state from this log
  when DB rows are absent, so the JSONL log is a first-class artifact, not a
  debug convenience.

- **Read surface:** `store.session_detail` assembles everything for the UI, and
  `main.py:session_detail` enriches it at read time with project-theorem
  linkage and project-formalization dependents.

The information derived per frame includes: assistant text deltas coalesced into
`messages`; `code_steps` (from `write_file`/`edit_file`/`lean_check` tool frames,
file snapshots, transcript reconciliation, and "no code" markers); `status_events`;
approval request/resolve events; and a per-turn / per-preflight `run_usage_breakdown`.

### 2.2 What the Overleaf companion does today

The companion (`apps/overleaf-extension/companion/server.mjs`) drives its own run
lifecycle and keeps its own state:

- It builds a prompt, calls `/v1/runs` directly, and manages the
  theorem-translation **stub + approval** flow itself
  (`runStubApprovalFlow`, `persistStubApproval`, `acceptLeaApproval`).
- It streams events via `tailLeaRunUsageEvents` → `handleLeaEventFrame`, but only
  reacts to `usage_updated`, `finished`, and `error`, extracting tokens/cost and
  turn progress. Everything else is ignored.
- It persists to a per-job text log (`.overleaf-lean-stub/jobs/{jobId}.log`) and a
  `jobs.json` map keyed by `jobId`. None of this is the shared schema and the UI
  cannot read it.

The companion already holds all the metadata needed to create a faithful session:
`jobId`, `theoremLabel`, `declarationName`, `overleafProjectId`, `projectSlug`,
`projectMarkdownPath`, `relativePath`/`absolutePath`, `leaModel`,
`leaProviderFamily`, `leaMaxTurns`, the `prompt` (task text), the resolved
`apiRunId` (via `onRunStarted`), usage, and final status.

### 2.3 The key enabler

The Lea API event stream (`vendor/lea-prover/lea_api/jobs.py`) is explicitly a
**replayable, multi-subscriber** stream: every frame is stamped with a monotonic
`seq`, appended to a per-run buffer, and `subscribe(state, start_seq)` returns the
backlog plus a live queue. Multiple independent consumers can therefore stream the
same `api_run_id` from `seq 0` concurrently without interfering. This is what makes
full event capture in the companion possible without changing the API or
disturbing the companion's existing approval/usage consumption.

### 2.4 Relevant environment

`.env` already defines `LEA_API_BASE_URL`, `LEA_UI_API_BASE_URL`
(`http://127.0.0.1:8001`) and `OVERLEAF_COMPANION_URL` — the apps are already aware
of one another. The companion runs on Node 22.22, which ships the built-in
`node:sqlite` module, so it can write SQLite with no native dependency. Shared
config flows through the single monorepo-root `.env` (`scripts/env.mjs`,
`companion/config.mjs`).

## 3. Design overview

Make the persisted process state a **shared database that is the single source of
truth**, owned by a stable schema, and let both apps write to it:

1. **Promote the store to a shared location.** Move the SQLite DB and the JSONL
   event-log directory out of `apps/lea-ui/server/data/` to a monorepo-level
   shared data directory, configurable by env, resolved identically by both apps.
2. **Keep one schema owner.** The Python `db.init_db()` remains the sole authority
   for DDL/migrations. The companion only performs DML (insert/update of rows) and
   appends JSONL; it never creates or alters tables. This avoids two processes
   racing to migrate.
3. **Make the companion a first-class writer.** Add a Node `sharedStore` module
   that mirrors the subset of `store.py` writes needed to create a session, run,
   messages, code steps, status events, approvals, and usage breakdown, plus a
   raw-frame JSONL logger equivalent to `runner._log_api_frame`.
4. **Record during the stream the companion already consumes.** Extend the
   companion's frame handler so that, alongside its existing usage/approval logic,
   it performs the same per-frame derivation `runner.py` performs and writes it to
   the shared store. The companion stays the single stream consumer; it simply
   stops discarding the rich frames.
5. **Tag provenance and link projects** so the UI can render and attribute an
   Overleaf run exactly like its own.

The result: an Overleaf formalization shows up in the UI's session list and
session detail with the same timeline, code steps, approvals, and usage breakdown
as a UI run, distinguishable only by an `origin` tag.

## 4. Detailed design

### 4.1 Shared database location and configuration

Introduce explicit, env-driven paths used by both apps:

- `LEA_SHARED_DATA_DIR` (default: `<monorepo-root>/data`) — parent for shared
  state.
- Derived: `LEA_DB_PATH = $LEA_SHARED_DATA_DIR/lea-interface.sqlite3` and
  `LEA_EVENT_LOG_DIR = $LEA_SHARED_DATA_DIR/lea-api-events/`.

Changes:

- **Python:** `db.py` currently hardcodes `ROOT/data/...` where
  `ROOT = parents[2]` (the `lea-ui` app root). Change `DB_PATH` and
  `store.RAW_EVENT_LOG_DIR` / `runner.RAW_EVENT_LOG_DIR` to read the env-resolved
  shared paths (falling back to the current app-local path only as a migration
  shim). Centralize this in `config.py` so there is one resolver.
- **Node:** add the same resolver to `companion/config.mjs` (extending
  `applyEnvDefaults`) so the companion computes identical paths.

**SQLite concurrency.** Two writer processes against one SQLite file requires
care. Enable **WAL mode** (`PRAGMA journal_mode=WAL`) and a sane
`PRAGMA busy_timeout` (e.g. 5000 ms) on every connection in both languages. WAL
permits one writer + many readers concurrently and dramatically reduces
`SQLITE_BUSY` under the short transactions this workload uses. All writes must be
small, committed transactions (they already are in `store.py`). This is sufficient
for the expected load (interactive, low write-rate, a handful of concurrent runs).

If write contention or multi-host deployment later becomes a concern, the schema
is portable to **Postgres**; see §7 (Alternatives). We recommend starting with
SQLite + WAL because the schema, migrations, and all UI read paths already target
it, and Node 22 can write it natively.

### 4.2 Schema additions (provenance + linkage)

Add, via `db.init_db()` (additive, backward compatible):

- `sessions.origin TEXT NOT NULL DEFAULT 'ui'` — `'ui'` or `'overleaf'`.
- `runs.origin TEXT NOT NULL DEFAULT 'ui'`.
- `sessions.external_ref TEXT` — JSON blob for origin-specific identifiers, e.g.
  `{ "overleaf_project_id": ..., "theorem_label": ..., "companion_job_id": ... }`.

These let the UI badge/attribute Overleaf runs and let the companion find or
reconcile the session it created (e.g., on retry of the same `jobId`). Existing
rows default to `'ui'`, so no backfill is required. The UI read surface
(`store.list_sessions`, `store.session_detail`) passes these through; the frontend
can show an "Overleaf" badge and the source theorem.

### 4.3 Companion `sharedStore` module (Node)

A new `companion/sharedStore.mjs` using `node:sqlite`, providing the minimal write
API the recorder needs, each function a direct analogue of `store.py`:

- `createSession({ title, projectId, origin, externalRef })`
- `createRun({ sessionId, model, provider, maxTurns, projectId, origin })`
- `setRunApiRunId(runId, apiRunId)`
- `addMessage(sessionId, role, content, runId)`
- `addCodeStep({...})` (with `step_number` computed as `max+1` per session, as in
  `store.add_code_step`)
- `addStatusEvent({...})`
- `updateRun(runId, status, { finalText, inputTokens, outputTokens, costUsd })`
- `setRunPendingApproval(runId, payload)`
- `replaceRunUsageBreakdown(runId, rows)`
- `findOrCreateProject({ slug, title, path })` (mirrors `store.create_project`
  semantics + slug validation) for project linkage.
- `touchSession(sessionId, status)`

Plus `logApiFrame(runId, apiRunId, frame)` writing to
`$LEA_EVENT_LOG_DIR/{local_run_id}.jsonl` in the **exact record shape** produced by
`runner._log_api_frame`: `{ api_run_id, local_run_id, seq, type, payload }` with the
same 2000-char truncation rule. Identical shape is required because the Python read
paths (`approval_events_for_session`, `_usage_breakdown_from_raw_logs`) parse this
file.

All IDs are UUIDv4 strings, timestamps ISO-8601 UTC — matching `db.utc_now()` and
`store`'s `uuid4()` usage — so rows are indistinguishable from UI-written rows.

### 4.4 Event recording in the companion (the parser port)

This is the substantive work. The companion's `handleLeaEventFrame` (or a new
recording layer wrapping `tailLeaRunUsageEvents`) must derive the same structured
state per frame that `runner.py` derives. Concretely, port the pure logic of:

- `_event_type`, `_text_delta`, `_status_message`, `_terminal_status`,
  `_final_text`, `_seq`, `_usage`, `_cost`, `_walk_dicts` — frame classification &
  extraction helpers.
- Assistant-text coalescing into `messages` (`_flush_assistant_turn`,
  `_emit_chat_message`).
- Code-step derivation: `_code_payloads`, `_track_tool_frame` (the
  `write_file` / `edit_file` / `lean_check` tracker, file snapshots, path-drift
  detection), `_emit_file_snapshot`, `_reconcile_terminal_artifacts`,
  `_emit_terminal_no_code_step`.
- `UsageBreakdownCollector` (preflight vs per-turn attribution).
- Approval payload extraction (`_approval_payload`) and
  `set_run_pending_approval`.
- Terminal consistency checks (`_terminal_status_after_tool_checks`).

The recorder runs inside the companion's existing single subscription, so it sees
every frame the companion already receives. Where the companion currently returns
early for non-usage frames, it instead first hands each frame to the recorder.

**Two project-aware behaviors that live in Python only** need explicit handling:

- `code_steps.used_project_formalizations` is computed by
  `project_usage.detect_used_project_formalizations` (non-trivial Python over the
  project markdown + lea workspace). The companion cannot easily replicate it.
  *Decision:* the companion writes `code_steps` with `used_project_formalizations`
  left empty, and we move this enrichment to **read time** in the UI server
  (`main.py:_code_steps_with_project_dependents` already computes
  `used_by_project_formalizations` on read; extend it to also compute
  `used_project_formalizations` when the stored value is empty and a project is
  linked). This keeps a single Python implementation of the detection logic and
  avoids porting it. UI-written rows keep their stored value; the read path treats
  stored-empty + linked-project as "compute now."
- `lea_root` resolution for file snapshots: the companion already knows
  `leaRepoPath`/`leaWorkspacePath`, which is the same root `config.lea_root` points
  at, so `_resolve_lea_path` / `_relative_path` port directly.

**Avoiding parser drift (critical).** Two implementations of this logic will drift
unless constrained. The plan:

1. Treat the Python helpers in `runner.py`/`store.py` as the **reference spec** and
   write that spec down (a short `docs/event-derivation.md` enumerating each frame
   type → derived rows).
2. Build a **shared fixture corpus**: real recorded JSONL logs (we already have
   one at `apps/lea-ui/server/data/lea-api-events/*.jsonl`) plus hand-crafted edge
   cases (approval candidates, path drift, no-code terminal, max_turns, tool
   results with errors).
3. Add **golden tests in both languages** that run each fixture through the
   derivation and assert identical `messages` / `code_steps` / `status_events` /
   `approval_events` / `run_usage_breakdown`. The Python golden output is the
   oracle; the Node test must match it byte-for-byte (modulo UUIDs/timestamps,
   which tests normalize).

See §7 for an alternative that eliminates the second implementation entirely.

### 4.5 Wiring into the companion run flow

In `runLeaJob` / `runLeaApiProofJob`:

1. On job start, `createSession` + `createRun` (origin `'overleaf'`,
   `external_ref` with overleaf/theorem/job ids), `findOrCreateProject` from
   `projectSlug` + `projectMarkdownPath`, link `session.project_id` /
   `run.project_id`, and `addMessage(role='user', prompt)`.
2. In `onRunStarted(apiRunId)`, also call `setRunApiRunId(runId, apiRunId)`.
3. Route every streamed frame through the recorder (which logs JSONL + writes
   derived rows + updates usage breakdown), in addition to the existing
   usage/spend and progress callbacks.
4. The companion's own stub/approval flow is unchanged; the recorder simply
   observes the `approval_requested` / `approval_resolved` frames and records them
   (and pending-approval state) for parity.
5. On terminal, run the same reconciliation (`updateRun` final status/usage,
   `replaceRunUsageBreakdown`, `setRunPendingApproval(null)`,
   `touchSession(status)`), mirroring the tail of `run_lea`.

The companion keeps `jobs.json` and the text log for now (no behavior regression);
they become redundant with the shared store and can be retired in a later cleanup.

### 4.6 Concurrency model

- `runner.py` holds a process-global `active_run_lock` that serializes UI runs.
  It does **not** and should not gate Overleaf runs (different process). Overleaf
  and UI runs may proceed concurrently; SQLite WAL + `busy_timeout` + short
  transactions handle the row-level concurrency. Document this explicitly.
- Each writer opens its own connection with WAL + `busy_timeout` pragmas.
- Step-number allocation (`max(step_number)+1` per session) is per-session and an
  Overleaf session is written only by the companion, so there is no cross-process
  contention on that counter.

### 4.7 UI surface

- `store.list_sessions` / `session_detail` already select `*`; add `origin` /
  `external_ref` to the normalized payloads.
- Frontend (`apps/lea-ui/src/app`): badge Overleaf-origin sessions and surface the
  source theorem/project from `external_ref`. No new endpoints required — the UI
  reads the same DB it always has.

## 5. Migration & rollout

1. **Schema + path migration (Python first).** Land `db.init_db()` additions
   (`origin`, `external_ref`, WAL pragma) and the shared-path resolver in the UI
   server. Add a one-time move of an existing app-local
   `apps/lea-ui/server/data/` DB + event logs to the shared dir (or symlink) in
   `scripts/setup.mjs` / `scripts/reset-local-state.mjs`. UI behavior is unchanged.
2. **Companion read-path config.** Point the companion at the shared paths; verify
   it can open the DB read-only (smoke test) before enabling writes.
3. **Companion writer + recorder, behind a flag.** Implement `sharedStore.mjs` and
   the parser port; gate with `LEA_SHARED_STATE=1` so it can be rolled out and
   rolled back without code changes. Keep `jobs.json`/text logs in parallel.
4. **Parity validation.** Run identical theorems through both the UI and the
   Overleaf companion; diff the resulting `session_detail` payloads (normalize
   ids/timestamps). Iterate on the golden fixtures until they match.
5. **Default on, then retire redundant state.** Flip the flag default; later
   remove the now-redundant companion text-log/`jobs.json` summary (separate PR).
6. **Doctor checks.** Extend `companion/doctor.mjs` and the UI doctor to verify the
   shared dir exists, is writable, the DB opens, and WAL is active.

## 6. Testing strategy

- **Golden parity tests** (Python + Node) over the shared fixture corpus (§4.4) —
  the primary defense against drift.
- **Companion unit tests** (`apps/overleaf-extension/tests/*.test.mjs`,
  `node --test`) for `sharedStore.mjs` writes and the recorder, asserting the rows
  it produces.
- **Python store tests** (`apps/lea-ui/server/tests/test_store.py`) extended for
  `origin`/`external_ref` and read-time `used_project_formalizations` enrichment.
- **Cross-process integration test:** with a stub/fake Lea API replaying a fixed
  event sequence, drive a companion job end-to-end and assert
  `GET /api/sessions/{id}` from the UI server returns a faithful, fully-populated
  detail with `origin='overleaf'`.
- **Concurrency smoke test:** interleave a UI run and an Overleaf run; assert no
  `SQLITE_BUSY` failures and both sessions land complete.

## 7. Risks, trade-offs, and alternatives

- **Dual-parser drift (highest risk).** Two implementations of the event→rows
  derivation can diverge as the Lea API's event vocabulary evolves. Mitigated by
  the golden fixture corpus and a written spec, but it is ongoing maintenance.
- **SQLite multi-writer contention.** Low risk at expected load with WAL +
  `busy_timeout`, but real if usage grows or deployment goes multi-host. Postgres
  is the escape hatch; the schema is portable and `db.py`'s `connect()` is the
  single seam to swap.
- **Schema ownership.** Keeping Python as the sole migrator avoids dual-DDL races
  but means the companion can break if it runs against an un-migrated DB. Mitigate
  with a startup version check in the companion (read a `schema_version` and refuse
  to write if older than expected).
- **`used_project_formalizations` gap.** Resolved by moving enrichment to UI read
  time; the trade-off is a small read-time cost and a behavioral note that this
  field is computed, not stored, for Overleaf rows.

**Alternative worth weighing — reuse the Python recorder as a subprocess.** Rather
than porting `runner.py` to Node, the companion could spawn the UI server's runner
in a new *record-only* mode (skip `start_run`, skip approval resolution and spend
cancellation — just stream a given `api_run_id` and write rows) as a short-lived
Python subprocess that writes to the same shared DB. This still satisfies "both
apps write to the shared database" (two processes, one DB) while keeping a
**single** implementation of the derivation logic, eliminating the drift risk
entirely. The cost is a Python runtime dependency in the companion's execution
path and inter-process orchestration. Given that drift is the dominant long-term
risk, this alternative deserves serious consideration before committing to the
native-Node port; the rest of this design (shared paths, schema, provenance,
linkage, concurrency, migration) is unchanged either way.

## 8. Work breakdown and status

Implemented (behind `LEA_SHARED_STATE`, default off):

- [x] Shared-path resolver + WAL/`busy_timeout` pragmas in `db.py`. Default data
  dir is the existing `apps/lea-ui/data`, so both apps share one store with no
  migration; overridable via `LEA_SHARED_DATA_DIR` / `LEA_DB_PATH` /
  `LEA_EVENT_LOG_DIR`.
- [x] Schema additions: `sessions.origin`, `sessions.external_ref`, `runs.origin`
  (additive, backward compatible).
- [x] `store.py`: `origin`/`external_ref` on `create_session`/`create_run`,
  surfaced through read payloads; `get_project_by_slug` + `find_or_create_project`
  for project linkage.
- [x] `runner.record_run`: record-only observer reusing the existing derivation
  helpers (no global lock, no `start_run`, no approval resolution, no spend
  cancel).
- [x] `app.recorder` CLI: creates/links project + session + run (origin
  `overleaf`, `external_ref`), records, prints `{session_id, run_id, status}`.
- [x] Companion: `LEA_SHARED_STATE` + recorder-python/server-dir config;
  `spawnLeaRecorder` wired into both `onRunStarted` sites (proof and
  theorem-translation paths), best-effort, non-blocking.
- [x] UI read passthrough (`origin`/`external_ref`) + TS type; `.env.example`
  documented.
- [x] Tests: Python `test_recorder.py` (record_run parity, approvals, CLI
  linkage) + companion `recorder.test.mjs` (args, result parsing, spawn wiring).

Because the recorder reuses the Python derivation, the cross-language golden
fixture corpus from §4.4 is no longer needed for correctness; the single Python
implementation in `runner.py` is the only one. `used_project_formalizations` is
populated natively by the recorder (it is Python), so the read-time-enrichment
workaround from §4.4 is unnecessary.

Remaining / follow-ups:

- [ ] Flip `LEA_SHARED_STATE` default on after live parity validation.
- [ ] `doctor` checks: shared dir writable, DB opens, WAL active, recorder Python
  resolvable.
- [ ] Cross-process concurrency soak test (interleaved UI + Overleaf runs).
- [ ] Retire the now-redundant companion text-log/`jobs.json` summary (separate
  change).
- [ ] Optional: lift `store` + derivation + `project_usage` into a standalone
  Python package so the recorder need not import from the UI server tree.
