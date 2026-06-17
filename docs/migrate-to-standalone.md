# Migration Plan — Consolidate onto the standalone prover

**Status:** Active plan. Supersedes the earlier `migrate-to-standalone-prover.md`
(shim vs. promote analysis) and `v1-shim-over-new-prover.md` (shim design), both
removed. `shared-process-state.md` remains valid as a record of the *current*
implemented shared-recorder behavior; this plan describes how that seam is
eventually retired.

**Goal:** Make `apps/lea-standalone` the single front end and the single backend
for the whole ecosystem. Replace `apps/lea-ui` with it, rebuild the Overleaf
extension to run against the standalone adapter's `/api` (not the vendored Lea
API), and delete `vendor/lea-prover`.

---

## 1. Decision

We are **not** building a `/v1` compatibility shim. The shim's only reason to
exist was to re-create two features the new `/api` lacks — the
**theorem-translation approval tier** and **project recording** — without
touching the front ends. Those features are now being added natively to the
standalone prover/adapter by a separate effort, so a shim would duplicate work
that's already happening on the `/api` side and then be thrown away.

Instead we adopt the **parasite model**: the Overleaf companion becomes a client
of the standalone adapter. The adapter runs as a long-lived local daemon (the
"host"); the companion (the "parasite") depends on that daemon being up but
**not** on the browser tab being open.

This is a deliberate hybrid:

- **UI** — a true replacement (retire `lea-ui`, ship `lea-standalone` as-is).
- **Overleaf** — companion re-pointed from the vendored `/v1` API to the
  standalone `/api`, proxy-first and embedded-later.

---

## 2. End-state architecture

```
lea-standalone/src (React UI) ──/api──▶ adapter daemon (:8001) ──┐
                                                                 ├─import──▶ lea (new prover)
Chrome ext ──▶ overleaf companion ──/api──▶ adapter daemon (:8001) ──┘
```

- `vendor/lea-prover` and the `.gitmodules` submodule: **deleted**.
- `apps/lea-ui`: **deleted**.
- One Python venv, one prover library, one run manager, one SQLite/git store.
- The adapter is a headless service decoupled from Vite and the browser tab.

---

## 3. Critical path (do these to reach "off vendor, both apps working")

### 3.1 Daemonize the adapter
Promote `apps/lea-standalone/adapter` from "the thing `vite dev` starts" into a
long-lived `127.0.0.1:8001` service with its own launch entry (a
`start-lea.command`-style script / npm target), so the UI tab being closed does
not stop it. This is the precondition that makes Overleaf able to depend on the
adapter without the UI being on screen.

### 3.2 Replace lea-ui with lea-standalone
- Make `apps/lea-standalone` the canonical UI app; update root `package.json`
  workspaces and the `dev:ui` / `setup` / `test` / `doctor` scripts to target it
  (today `dev:ui` runs `-w apps/lea-ui`; standalone's API runs via
  `cd adapter && ./.venv/bin/python run_api.py`).
- Delete `apps/lea-ui` and its `server/` adapter once standalone boots
  end-to-end.
- **Shared-state seam (non-obvious coupling).** `lea-ui`'s `server` owned the
  shared SQLite recorder (`runner.record_run`, `app.recorder`) that the Overleaf
  companion spawns as a subprocess (see `shared-process-state.md`). The
  standalone adapter has its own `store.py` / `db.py` / `gitstore.py` with a
  different, pointer-based schema. Decide the shared-DB owner during cutover. In
  the parasite end-state this seam disappears (Overleaf runs *are* adapter runs,
  recorded once), so prefer routing recording through the adapter rather than
  porting the old recorder.

### 3.3 Rebuild the Overleaf companion as an `/api` client (proxy-first)
- Turn the companion into a thin proxy onto `/api`: it keeps its Overleaf-domain
  logic in Node (theorem parsing, `jobKey`, the formalized/unformalized status
  model, project-markdown read/write) and forwards run lifecycle to the adapter.
- **Proxy-first, not embedded-first** — deliberately. A separate effort is live
  in the adapter/prover code; embedding the companion's endpoints into the
  FastAPI adapter now would create merge contention. Embedding is the eventual
  cleanup (§5), and it's the version that fully kills the recorder seam.
- Repoint launch/config: companion `package.json` `start:lea-api` and
  `LEA_API_BASE_URL` move off `vendor/` and the `:8000` `/v1` API onto the
  adapter daemon. The extension itself is unchanged.

### 3.4 Retire vendor
Delete `vendor/lea-prover`, remove the submodule from `.gitmodules`, and strip
`vendor/`-targeted steps from `scripts/setup.mjs` (install the new prover + build
its Mathlib cache instead). Do this as soon as the companion's `/api` path
streams runs and tool-approvals — accepting that theorem-translation approval and
project status are temporarily stubbed (see §4).

---

## 4. Backlog (TODOs — intentionally deferred)

These are accepted gaps during the interim, to be integrated as they land:

- **Theorem-translation approval tier.** Being added natively to the standalone
  prover/adapter by a separate effort. Until it lands on `/api`, the companion's
  approve-the-statement-then-formalize step is stubbed. **Coordinate now:** make
  sure the native approval surfaces something the companion can poll the way it
  polls `pending_approval` today (`maybeResumeStubFormalization`). If it only
  exposes tool-gating, the companion is back to synthesizing — so land the native
  approval in a companion-friendly shape.
- **Project recording / status model.** Also being added natively (`run_events`
  already yields `ProjectEntryUpdated`; the adapter currently passes
  `project=None`, parked under `adapter/_deferred/`). Overleaf's
  formalized/unformalized status lights up once `/api` carries projects.
- **Multi-run concurrency.** The adapter bridge enforces "one run streams at a
  time" (`routes/runs.py`). For a single local user this is fine; the companion
  already serializes its own jobs (`job_in_progress` 409 on `jobKey`). The only
  uncovered case is a UI run and an Overleaf run overlapping — rare for one
  person. **Guardrail, not a build:** verify that a second concurrent run
  degrades to a clean, retryable "backend busy" error rather than crashing the
  shared daemon, deadlocking, or interleaving two runs into one stream. If the
  current guard misbehaves under a real second connection, apply a small fix now;
  otherwise defer the real multi-run manager. Give whoever's in the bridge a
  one-line heads-up so it isn't designed in a way that's painful to extend.

---

## 5. Follow-on consolidation (after the backlog lands)

Once the adapter has grown (a) daemon mode, (b) native approval + projects on
`/api`, and (c) real multi-run support, collapse the companion into the adapter:
fold its endpoints into the FastAPI app as a router sharing the run manager,
store, and git. This is the fully-embedded parasite — it removes Node from the
run path and eliminates the `shared-process-state.md` recorder seam entirely.
Until then, the proxy form is the right intermediate.

---

## 6. Sequencing

1. Daemonize the adapter (§3.1) — unblocks everything else.
2. Rebuild the companion as an `/api` proxy (§3.3) against the daemon, with the
   approval/project steps stubbed; do the concurrency guardrail check (§4).
3. Replace `lea-ui` with `lea-standalone` and resolve the shared-DB owner (§3.2).
4. Retire `vendor/` (§3.4) once both surfaces run green on the new prover.
5. Integrate the native approval, projects, and multi-run support as they land
   (§4), then embed the companion into the adapter (§5).

---

## 7. Verification

- Overleaf `tests/*.test.mjs` assert exact API URLs and decision payloads — keep
  them green (or update them deliberately) as the companion moves to `/api`; they
  are a precise contract check.
- Adapter `tests/` (bridge / store / sessions) stay green.
- Manual parity passes: a full UI formalization; an Overleaf
  formalize-and-record flow; a cancel mid-run; the concurrency guardrail (UI run
  + Overleaf run at once → clean busy error); `npm run doctor`.
- Keep `vendor/` recoverable (a tag/branch) for one release as rollback.
