# Plan — Fix Overleaf popover usage stats (match lea-standalone)

## Goal
The "This project" and "All-time" usage rows in the Overleaf settings popover are
stuck at `--`/0. They must show the **same values** lea-standalone shows, sourced
the same way, with the existing popover markup unchanged. "This project" = total
usage across **all theorems formalized in the given Overleaf document**.

## Decisions (locked)
- **Project linkage:** by the document's **namespace** —
  `slugProjectId(overleafProjectId)` (a.k.a. `target.projectSlug`).
- **Scope:** new formalizations only; existing untagged runs stay in All-time only.

## Root cause
1. **Wrong source.** Popover reads the companion's in-memory `state.jobs`
   (`companion/server.mjs` → `handleGetUsage` → `aggregateUsage`). lea-standalone
   reads the shared DB via the adapter `GET /api/stats`
   (`adapter/app/store.py: usage_stats`). Disconnected; in-memory jobs reset on
   restart → zeros.
2. **No project tag.** Overleaf runs persist to the DB through `POST /api/runs`,
   but `create_run(..., None, ...)` and `create_session(message)` set no
   `project_id` (`adapter/app/routes/runs.py`). So per-document filtering is
   impossible. The companion already derives the namespace and threads it on the
   retired `/v1` path and the (nonexistent) `app.recorder` CLI, but the **active**
   adapter path drops it.

## Single source of truth
The adapter `GET /api/stats` payload (`store.usage_stats()`):
- `global` → `{ input_tokens, output_tokens, cost_usd, ... }` (All-time; already
  includes Overleaf runs).
- `sessions[]` → each carries `project_slug` (from `left join projects`) plus
  `input_tokens`/`output_tokens`/`cost_usd`. Per-project total = sum of sessions
  whose `project_slug` matches the document namespace.

---

## Part A — Point the popover at the shared DB (matches All-time immediately)

**`companion/leaApiClient.mjs`**
- Add `fetchAdapterUsageStats({ fetchImpl, baseUrl })` → `GET ${baseUrl}/api/stats`
  (mirror existing `fetchAdapterSettings`).

**`companion/server.mjs` — `handleGetUsage` (make async)**
- Fetch adapter stats. Build the response keeping the existing contract so the
  extension needs no markup change:
  - `allTime` ← map `stats.global` → `{ inputTokens, outputTokens, costUsd }`
    (snake_case → camelCase).
  - `project` ← reduce `stats.sessions` where
    `session.project_slug === slugProjectId(overleafProjectId)`, summing
    input/output/cost → same camelCase shape.
  - Keep `leaMaxSpendUsd`; set `leaCurrentSpendUsd` = mapped `allTime.costUsd`;
    derive `leaSpendLimitReached` from that (so the cost-cap UI also matches
    standalone).
  - **Fallback:** if the adapter is unreachable, fall back to the existing
    in-memory `aggregateUsage(state.jobs)` so the popover degrades instead of
    erroring.
- Update the `/usage` router branch (`server.mjs` ~line 638) to `await` the now
  async handler and pass `{ fetchImpl, baseUrl: adapterBaseUrl, state }`.

**`extension/content.js`**
- No markup change. `renderUsage` already reads `costUsd`/`inputTokens`/
  `outputTokens`; `loadUsage` already sends `overleafProjectId`; the 1s
  `scheduleUsageRefresh` stays. Just verify the mapped field names line up.

> After Part A, **All-time** matches lea-standalone exactly. **This project**
> stays 0 until Part B tags runs.

---

## Part B — Tag Overleaf runs with the document namespace (fills "This project")

**`adapter/app/store.py`**
- Add `get_project_by_slug(slug)` and `get_or_create_project(slug, title)` (reuse
  existing `create_project` / `validate_project_slug`).
- Confirm `create_run` persists `project_id` (insert already has the column);
  thread it from the route.

**`adapter/app/routes/runs.py`**
- Extend `RunRequest` with `project_slug: str | None = None`,
  `project_title: str | None = None`.
- In `create_run`: if `project_slug` is present, resolve
  `project = store.get_or_create_project(project_slug, project_title)`, then
  `create_session(message, project_id=project["id"])` and pass that `project_id`
  into `store.create_run(...)`. Behavior unchanged when `project_slug` is absent
  (interactive UI path).

**`companion` (active adapter path only)**
- `leaApiClient.mjs` `startApiRun` / `runApiProofJob`: add `project_slug` /
  `project_title` to the `POST /api/runs` body when provided.
- `server.mjs` where the API job starts: pass `projectSlug: target.projectSlug`
  and `projectTitle: target.projectSlug` (mirrors the existing `/v1` `project`
  block and recorder args). Namespace is computed once and used for **both**
  tagging (send) and filtering (`slugProjectId`), so the two always agree.

> Each theorem is its own session; all sessions for one document share the project,
> so summing sessions by `project_slug` yields the document total.

---

## Part C — Verification
- **Companion unit tests** (`tests/companion.test.mjs`): mock an adapter
  `/api/stats` payload; assert `handleGetUsage` maps All-time correctly and sums
  only sessions whose `project_slug` matches the namespace; assert graceful
  fallback when the adapter fetch throws.
- **Adapter pytest:** `POST /api/runs` with `project_slug` creates/links the
  project; `usage_stats().sessions` carry `project_slug`; per-project sum is
  correct.
- **Integration:** run adapter + companion, formalize a theorem from Overleaf,
  open the popover → All-time equals the lea-standalone Stats page; This project
  equals the sum of that document's sessions. Formalize a second theorem → This
  project increases by that run's usage.
- Confirm `slugProjectId` is applied identically on tag and filter sides; confirm
  the 1s refresh and cost-cap notice still behave.

## Edge cases / notes
- Existing untagged runs remain in All-time only (by decision).
- Cost cap: surface adapter All-time as `leaCurrentSpendUsd` so the cap matches
  standalone; the adapter already enforces the spend limit in `create_run`.
- `app.recorder` shared-state path is a stub (module absent) and is **not**
  relied on here — the active `/api/runs` path is the only data source.

## Touch list
- `apps/overleaf-extension/companion/leaApiClient.mjs`
- `apps/overleaf-extension/companion/server.mjs`
- `apps/lea-standalone/adapter/app/store.py`
- `apps/lea-standalone/adapter/app/routes/runs.py`
- Tests: `apps/overleaf-extension/tests/companion.test.mjs`, adapter pytest
- (Extension `content.js`: verify only, no markup change)
