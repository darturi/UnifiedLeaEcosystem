# Plan — Surface Overleaf origin in the Lea UI (indicator + origin stats + open/focus Overleaf)

## Goal
A formalization spawned from the Overleaf extension currently leaves **no trace of its
origin** ("providence") once you look at the session from the Lea UI. This phase makes
that origin visible and actionable:

1. **Origin indicator.** A session spawned from Overleaf shows an unobtrusive
   indicator in the UI whenever that session is open, styled to match the rest of
   the UI.
2. **Origin statistics.** Wire up the Stats page's placeholder source-tracking tab
   (global Direct-vs-Overleaf analysis) **and** show a per-session origin indicator
   in the Stats middle (session-detail) pane.
3. **Open / focus Overleaf.** The Overleaf indicator is clickable: it opens the
   originating Overleaf document **in a new tab if it isn't already open, or
   switches to the existing tab if it is** — the Lea UI tab itself stays open.
   This mirrors, in reverse, the existing Overleaf→UI "View in Lea UI" action.

## Naming (avoids collision with the future *projects* feature)
A separate **projects** feature is planned, and a `projects` table already exists as
its v2.1 foundation (and is reused by the Overleaf *usage-namespace* tagging today).
To keep this work from entangling with it, providence is modeled as its own concept:

- The concept/field name is **`origin`** (a session's origin: `ui` | `overleaf`),
  **never** `project`/`source`-on-project.
- Origin is stored **directly on the session**, not on the `projects` table. Nothing
  here touches `projects`; the projects feature can own that table cleanly later.
- The existing `project_slug`/`project_title` usage-namespace tagging (popover "This
  project" totals) is left exactly as-is — unrelated to origin and not extended here.

## Decisions (locked)
- **Indicator placement:** both the main chat session header **and** the Stats
  middle session-detail pane.
- **Link target:** the Overleaf **document page** (`https://www.overleaf.com/project/<id>`,
  Overleaf's own URL shape). No per-label deep link (Overleaf has none), so we land
  the user in the document, not at the exact theorem.
- **Host:** public **www.overleaf.com** only.
- **Open/focus semantics:** new tab if not open, else activate the existing tab; the
  Lea UI tab is never navigated away. "Activate existing tab" requires the extension
  (a web page cannot enumerate browser tabs), so the UI asks the extension to do it,
  with a `window.open` fallback when the extension is absent.
- **Scope:** new formalizations only. A schema change means a fresh DB
  (`npm run reset:local`), per the project's no-migrations convention
  (`adapter/app/db.py`). Pre-existing sessions read as `origin = 'ui'`.

## Why the URL must be stored, not derived
`slugProjectId()` (`apps/overleaf-extension/shared/leanStub.mjs`) is **lossy**: it
replaces every non-`[A-Za-z0-9_-]` char with `_` and truncates to 80 chars. Overleaf
ids are usually 24-char hex (so slug == id in practice), but we must not depend on
reversing the slug to rebuild the URL. The companion already knows the raw
`overleafProjectId` (`target.overleafProjectId`), so it builds and sends the full
canonical URL at run-creation time; the adapter persists it verbatim on the session.

---

## Part A — Adapter: record + expose origin (on the session)

### A1. Schema (`apps/lea-standalone/adapter/app/db.py`)
- `sessions`: add `origin text not null default 'ui'` (`'ui'` | `'overleaf'`) and
  `origin_url text` (full Overleaf document URL, NULL for UI sessions).

No `ALTER`s (clean-rebuild convention). Adding the columns to the `create table`
block + `npm run reset:local` is the migration. The `projects` table is untouched.

### A2. Store (`apps/lea-standalone/adapter/app/store.py`)
- `create_session(title, project_id=None, origin='ui', origin_url=None)` — persist the
  two new columns. Default `'ui'` keeps the interactive path unchanged.
- `list_sessions()` — add `s.origin` and `s.origin_url` to the SELECT (no join; they
  live on the session row).
- `session_detail()` — the base `get_session` row already includes the columns
  (`select *`); ensure `origin`/`origin_url` pass through to the returned dict.
- `usage_stats()` — add an **origin rollup** for the global tab. `sessions` already
  each carry `origin` + usage; reduce them into:
  ```
  stats["origins"] = [
    {"origin": "ui",       "session_count", "input_tokens", "output_tokens",
     "total_tokens", "cost_usd"},
    {"origin": "overleaf", ...},
  ]
  ```
  Aggregate from the same `sessions` list `global` is computed from, so the numbers
  stay internally consistent. Emit both rows even when one is zero so the UI layout is
  stable.

### A3. Run route (`apps/lea-standalone/adapter/app/routes/runs.py`)
- Extend `RunRequest` with `origin: str | None = None` and
  `origin_url: str | None = None` (companion sends `'overleaf'` + the document URL;
  UI path omits → defaults to `ui`).
- In `create_run`, when creating a session, pass
  `store.create_session(message, project_id=project_id, origin=(request.origin or "ui"),
  origin_url=request.origin_url)`. The existing `project_slug`/`project_title`
  resolution (usage namespace) is unchanged and orthogonal. Reusing an existing
  session leaves its origin as first recorded.

---

## Part B — Companion: send the origin on the active adapter path

### B1. URL helper (`apps/overleaf-extension/companion/server.mjs`)
- Add `buildOverleafDocumentUrl(overleafProjectId)` →
  `https://www.overleaf.com/project/<encodeURIComponent(id)>`. One spot owns the host
  assumption, beside `slugProjectId`/`buildLeaTarget`.

### B2. Thread origin through the run start
- `runLeaProofJobForJob` (the `isApiFlavor` branch, ~line 1480) → pass
  `origin: "overleaf"` and
  `originUrl: buildOverleafDocumentUrl(target.overleafProjectId)` into
  `runApiProofJob`, alongside the existing `projectSlug`/`projectTitle`.
- `companion/leaApiClient.mjs`:
  - `runApiProofJob({ ..., origin = null, originUrl = null })` → forward to
    `startApiRun`.
  - `startApiRun({ ..., origin = null, originUrl = null })` → add to the POST body:
    `if (origin) body.origin = origin; if (originUrl) body.origin_url = originUrl;`
    (mirrors the existing `project_slug`/`project_title` block).
- The retired `/v1` path and the `app.recorder` CLI stub are **not** updated (not the
  active data source — same note as the usage-stats plan).

---

## Part C — Lea UI: indicator + open/focus + origin stats

### C1. Types / API client
- `src/app/lib/types.ts` `SessionSummary`: add `origin?: 'ui' | 'overleaf' | string`
  and `origin_url?: string | null`. `SessionDetail` inherits these.
- `src/app/lib/api.ts`: add a `UsageOriginRow` interface and `origins: UsageOriginRow[]`
  to `UsageStats`. `UsageSessionSummary` inherits `origin`/`origin_url`.

### C2. Open/focus helper (shared UI util)
- New `src/app/lib/overleafLink.ts` exporting `openOverleafDocument(url)`:
  1. If the extension bridge is present (see C5; detected via a page marker the
     bridge sets, mirroring how `content.js` checks `chrome.runtime`), `postMessage`
     a request to it and resolve on its ack — the extension performs new-tab-or-
     activate-existing. The Lea UI tab stays focused as-is.
  2. Otherwise fall back to `window.open(url, '_blank', 'noopener')` (opens a new
     tab; cannot activate a pre-existing independent tab without the extension —
     accepted degraded behavior).
  This is the symmetric counterpart of `openLeaSession` in `content.js`.

### C3. Feature 1 — chat header indicator (`src/app/components/ChatThread.tsx`)
- In `pane-head` (next to `headChip`, ~line 289), when `session?.origin === 'overleaf'`
  render a small `OriginBadge` (new component): a compact pill labeled "Overleaf"
  with a document glyph, tooltip = "Formalized from Overleaf". `onClick` →
  `openOverleafDocument(session.origin_url)` when a URL exists; otherwise static.
- Styling: add a `.chip.origin-overleaf` modifier in `src/styles/lea-v2.css`
  (warm-paper system), terracotta-tinted to match the existing `.chip`/status chips
  — unobtrusive, no new color language. The `session` prop is the list **summary**,
  which now carries `origin`/`origin_url`, so the badge needs no extra fetch.

### C4. Feature 2 — Stats page (`src/app/components/StatsPage.tsx`)
- **Middle pane** (`SessionDetailPane`, meta row ~line 249): add the same
  `OriginBadge` (reuse the C3 component) reading `session.origin`/`origin_url`,
  clickable via `openOverleafDocument`. For `origin === 'ui'` show a muted
  "Direct (UI)" tag so every selected session states its origin.
- **Global pane** (`GlobalStatsPane`, the *By source* placeholder ~lines 519–533):
  replace the dashed placeholder + "not wired up yet" note with real rows driven by
  `stats.origins`. Re-label the section **By origin**: Direct (UI) and Overleaf
  extension, each showing session count, tokens, and cost, with the same thin
  proportion bar used by the *By model* block.
- **Session list pane** (optional, low-cost): a tiny Overleaf dot/glyph on Overleaf
  rows in `SessionListPane` for at-a-glance scanning. Nice-to-have; can defer.
- The Stats `origins` data rides the existing `/api/stats` payload, so the existing
  digest-gated live refresh covers it with no new polling.

### C5. Feature 3 — extension: open/focus the Overleaf tab
Mirror the existing Overleaf→UI machinery (`background.js: openLeaSessionTab`) in
reverse:
- `extension/background.js`: add an `OPEN_OVERLEAF_DOCUMENT` message handler doing the
  **same query-or-create** logic as `openLeaSessionTab`, but against the Overleaf
  origin: `chrome.tabs.query({ url: "https://www.overleaf.com/*" })` → if a tab
  matches the target document, `chrome.tabs.update(id,{active:true})` +
  `chrome.windows.update(windowId,{focused:true})`; else `chrome.tabs.create({url})`.
  Match on the `/project/<id>` path so we activate the *right* doc, not just any
  Overleaf tab.
- `extension/uiBridge.js` (new content script, runs on the UI origin): listens for a
  `window.postMessage` request from the Lea UI page, validates `event.origin`, relays
  via `chrome.runtime.sendMessage({type:'OPEN_OVERLEAF_DOCUMENT', url})`, and posts the
  result back to the page. On load it sets a page marker (e.g. a `data-` attribute /
  ready event) so `openOverleafDocument` (C2) knows the bridge exists. This is the
  reverse analogue of the existing page↔content-script messaging.
- `extension/manifest.json`:
  - Add a `content_scripts` entry for the UI origins
    (`http://localhost/*`, `http://127.0.0.1/*` — already in `host_permissions`)
    running `uiBridge.js` at `document_idle`.
  - `tabs` permission and the Overleaf host are already present; no new host perms
    needed for the public-host-only decision.

> The configured UI base (`leaUiBaseUrl`, default `http://localhost:5173`) is a
> local origin in practice, so the static localhost/127.0.0.1 matches cover it.
> Supporting an arbitrary configured UI origin would need
> `chrome.scripting.registerContentScripts` — out of scope here.

---

## Part D — Verification
- **Adapter pytest** (`adapter/tests/test_store.py`, `test_routes_runs.py`; host
  py3.13 venv per prior memory):
  - `create_session(origin='overleaf', origin_url=...)` persists both columns;
    default is `('ui', None)`.
  - `POST /api/runs` with `origin='overleaf'` + `origin_url` records them on the new
    session; `list_sessions()` rows carry `origin`/`origin_url`; a no-origin run reads
    `origin='ui'`, `origin_url=None`.
  - `usage_stats()["origins"]` sums correctly and emits both rows.
- **Companion tests** (`tests/leaApiClient.test.mjs`, `tests/companion.test.mjs`):
  `startApiRun` body includes `origin`/`origin_url` when supplied (and omits them
  otherwise); `buildOverleafDocumentUrl` shape.
- **Extension**: `background.js`/`uiBridge.js` aren't currently unit-tested — verify
  manually (optionally factor the query-or-create tab selection into a pure helper to
  unit test, as a stretch).
- **Frontend**: `vite build`/`tsc` can't run in the sandbox (per prior memory) — rely
  on `node --test src/app/*.test.mjs` for any pure helper (e.g. the
  `openOverleafDocument` bridge-vs-fallback decision) and manual UI checks.
- **Manual integration**: formalize a theorem from Overleaf → the session shows the
  Overleaf badge in the chat header and the Stats middle pane; clicking it activates
  the already-open Overleaf tab, and opens a new one when that tab is closed, with the
  Lea UI tab staying put; Stats *By origin* shows Direct vs Overleaf totals matching
  the per-session sums.
- Note the **DB reset** requirement (`npm run reset:local`) in the PR description;
  pre-existing sessions read as Direct (UI).

## Touch list
- `apps/lea-standalone/adapter/app/db.py` (sessions schema)
- `apps/lea-standalone/adapter/app/store.py` (`create_session`, list/detail/stats)
- `apps/lea-standalone/adapter/app/routes/runs.py` (`RunRequest` + `create_session`)
- `apps/overleaf-extension/companion/server.mjs` (`buildOverleafDocumentUrl`, thread origin)
- `apps/overleaf-extension/companion/leaApiClient.mjs` (`startApiRun`/`runApiProofJob`)
- `apps/lea-standalone/src/app/lib/types.ts`, `lib/api.ts` (types)
- `apps/lea-standalone/src/app/lib/overleafLink.ts` (new open/focus helper)
- `apps/lea-standalone/src/app/components/ChatThread.tsx` (header badge + `OriginBadge`)
- `apps/lea-standalone/src/app/components/StatsPage.tsx` (middle-pane badge + By origin)
- `apps/lea-standalone/src/styles/lea-v2.css` (`.chip.origin-overleaf`)
- `apps/overleaf-extension/extension/background.js` (`OPEN_OVERLEAF_DOCUMENT`)
- `apps/overleaf-extension/extension/uiBridge.js` (new), `extension/manifest.json`
- Tests: adapter pytest, `tests/leaApiClient.test.mjs`, `tests/companion.test.mjs`,
  any frontend `*.test.mjs` helper
