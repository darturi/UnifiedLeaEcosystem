# Plan: Link settings across the Overleaf extension and lea-standalone

## Problem

The two front-ends edit settings through **two independent stores**, so a change in
one is invisible to the other:

| | lea-standalone (UI) | Overleaf extension |
|---|---|---|
| Edit surface | `SettingsPage.tsx` | `options.html` / `options.js` |
| Write path | `PUT /api/settings` → `app/settings.py` | `POST /settings/lea` → `companion/server.mjs` |
| Store | `apps/lea-standalone/config/lea.local.toml` | root `.env` (shared keys) + companion `settings.json` |
| Read at run time | `app/config.load_config()` reads the TOML | `applyEnvDefaults()` reads `.env` / `settings.json` |

The adapter ignores the `LEA_*` env vars the companion writes (it reads only the
TOML), and the companion never reads the TOML. Result: max turns, model, spend cap,
provider keys, etc. drift between the two UIs.

Good news for the fix: the companion's `leaApiBaseUrl` (default `:8001`, `api`
flavor) **already points at the lea-standalone adapter** — the same FastAPI app that
serves `GET/PUT /api/settings` (confirmed in `companion/doctor.mjs`). So a single
source of truth is reachable without new infrastructure.

## Approach (recommended): adapter `lea.local.toml` is the single source of truth

Make the companion **delegate** all *shared* settings to the adapter's existing
`/api/settings` endpoints, instead of keeping its own copy. This mirrors the existing
"avoid parser drift by delegating to Python" pattern already used for run recording.
Infra-only settings (how the companion reaches the adapter) stay local to the
companion.

### Parameter inventory

**Shared — linked across both UIs (single source = adapter TOML):**
- `model`
- `max_turns`
- `max_spend_usd`
- provider API keys (OpenAI / Anthropic / Google)
- `theorem_translation_max_retries`
- `permission_tier` *(currently only in the standalone UI; see Phase 0)*
- `narrate_tool_steps` *(optional — env-only today)*

**Overleaf-local infra — NOT shared (stay in companion `settings.json`/`.env`):**
- `companionUrl`, `leaRepoPath`, `leaApiBaseUrl`, `leaApiFlavor`, `leaJobTimeoutSeconds`

**Locked:**
- `leaLatexContextMode` → forced to `off` in the Overleaf UI (feature not implemented)

## Phases

### Phase 0 — Confirm the canonical schema (revised after code review)
- **Correction:** `permission_tier` and `theorem_translation_max_retries` were
  *deliberately removed* from the backend (`lea.config.LeaConfig`); the test
  `test_dead_http_and_tier_fields_are_gone` pins them as gone, and `SettingsPage.tsx`
  references them only as vestigial dead UI. We do **not** resurrect them.
- The adapter's live, supported shared schema is therefore: `model`, `max_turns`,
  `max_spend_usd`, and provider `api_keys` — all already served/persisted by
  `/api/settings`. This is the set we link. Provider-key format checks and live
  verification already live in the adapter and are reused.
- Note a model-ID format difference to normalize during delegation: the companion
  catalog uses `anthropic/claude-opus-4-8`; the adapter shortlist uses bare
  `claude-opus-4-8`. The adapter accepts arbitrary model IDs (infers family from
  prefix), so the companion forwards its value as-is and aliases bare Anthropic IDs
  back to the prefixed form on read.

### Phase 1 — Add a settings client to the companion
- In `companion/leaApiClient.mjs` add `getAdapterSettings({baseUrl})` →
  `GET /api/settings` and `putAdapterSettings({baseUrl, body})` → `PUT /api/settings`.
- Add a field-name mapping layer (companion ↔ adapter):
  `leaModel↔model`, `leaMaxTurns↔max_turns`, `leaMaxSpendUsd↔max_spend_usd`,
  `leaTheoremTranslationMaxRetries↔theorem_translation_max_retries`,
  `leaProviderApiKeys{openai,google,anthropic}↔api_keys{OPENAI_API_KEY,…}`.

### Phase 2 — Companion read path
- `handleGetSettings` / `buildSettingsResponse` fetches shared fields from the
  adapter and merges them over local infra fields, so `GET /settings` (and the
  extension's "Load from companion") reflect adapter state.
- Remove shared keys from `SHARED_SETTING_ENV_FIELDS` so the companion stops writing
  `LEA_MODEL` / `LEA_MAX_TURNS` / `LEA_MAX_SPEND_USD` / keys to `.env`; the adapter
  TOML becomes authoritative. (Keep provider keys flowing to wherever the prover
  actually reads them — verify during impl.)

### Phase 3 — Companion write path
- `handleSaveLeaSettings` forwards shared fields to `PUT /api/settings` (provider
  keys included — the adapter validates and verifies them), and persists only infra
  fields to `settings.json`. Surface adapter validation errors (422) back through the
  companion's existing error-response shape.

### Phase 4 — Run-time consistency
- Job launch currently uses `state.settings.leaMaxTurns` for `--max-turns`. After
  Phase 2 those values originate from the adapter, so confirm the launch path reads
  the merged/authoritative values (re-fetch on job start, or refresh on save). The
  adapter's own in-process runs already use `load_config()`, so they're consistent by
  construction.

### Phase 5 — Lock LaTeX context to "Off"
- `options.html`: disable the `#lea-latex-context-mode` select and pin it to `off`
  (e.g. `disabled` + single "Off" option, or a static "Off — not yet available"
  label).
- `options.js`: always send `leaLatexContextMode: "off"` on save; ignore any stored
  `active_file`.
- Companion already defaults/normalizes to `off`; optionally reject `active_file`
  server-side for safety while keeping the normalizer back-compatible.

### Phase 6 — Tests & verification
- Adapter: extend `test_settings.py` / `test_config.py` for the newly-served fields.
- Companion: update `config.test.mjs` / `companion.test.mjs`; mock the adapter
  settings endpoints; assert read/write delegation and field mapping.
- Round-trip test: set `max_turns` via the adapter `PUT`, confirm companion `GET`
  returns it; set via companion `POST`, confirm adapter `GET` reflects it.
- Manual check: change Max Turns in one UI, reload the other, confirm it matches.

## Implementation status (done)

Implemented on the `api` flavor (the default), with the adapter as the single
source of truth for `model`, `max_turns`, `max_spend_usd`, and provider API keys:

- `companion/leaApiClient.mjs`: added `fetchAdapterSettings` / `putAdapterSettings`;
  `fetchJson` now returns the parsed body on errors and flattens the adapter's
  structured `{message, field}` detail.
- `companion/server.mjs`: `syncSharedSettingsFromAdapter()` overlays the adapter's
  shared values + key status onto local state; `buildSettingsResponse` is now async
  and calls it; `handleUpdateLeaSettings` forwards the shared fields (incl. the
  selected model's key) to `PUT /api/settings`, surfaces a reachable-adapter
  rejection as its real status (e.g. 422) and degrades gracefully if the adapter is
  unreachable; `isProviderKeyConfigured` treats an adapter-configured key as
  configured here too; formalize/stub re-sync before launching.
- Model-ID normalization: bare adapter Anthropic IDs alias back to the companion's
  prefixed catalog form.
- LaTeX context locked to Off: `extension/options.html` (disabled select + hint),
  `extension/options.js` (always sends `off`), `extension/options.css` (hint style).
- Tests: 113 companion (incl. 3 new api-flavor delegation tests) and 70 adapter
  settings/config tests pass.

Two deliberate refinements vs. the original phases:

- The shared scalars are still mirrored to `.env` so the legacy `v1` flavor (which
  has no adapter) keeps working; on `api` flavor the adapter overlay wins on read
  and governs runs, so that `.env` copy is inert.
- `permission_tier` / `theorem_translation_max_retries` were left as-is (dead
  backend fields, per Phase 0) — not linked.

## Resolved decisions
1. **Source of truth — delegate to the adapter.** Shared settings live in the
   adapter's `lea.local.toml`; the companion reads/writes them via `/api/settings`.
   This is the approach detailed in Phases 1–4.
2. **Shared scope — `permission_tier` and `narrate_tool_steps` stay standalone-only
   in the UI, but are backed by the shared store** so they still apply to
   Overleaf-originated runs. The Overleaf options page does **not** add controls for
   them; it just doesn't override them when saving (send only the fields it exposes).
