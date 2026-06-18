# Stats Panel — Implementation Plan

Add a reachable **Usage & Statistics** view to `lea-standalone`, restyled to match
the main chat panel (the warm-paper `lea-v2.css` design system). Scope confirmed:

- **No direct-vs-Overleaf split** in this pass — surface the existing global /
  per-session / per-model stats only. (Origin split is deferred; see *Future work*.)
- **Reskin, keep layout** — re-theme the existing 3-pane `StatsPage`, don't
  restructure it.
- **Entry point** — a stats icon button in the sidebar footer, next to the ⚙ gear.

## Current state (what already exists)

- `src/app/components/StatsPage.tsx` is a **byte-for-byte copy** of the old
  `LeaUI` stats page. All the information the old panel showed is already ported:
  a session list (left), per-session detail with stat cards + token split + turn
  cost breakdown (middle), and global statistics with daily token/cost charts,
  all-time token split, by-model bars, and per-session averages (right).
- It is already wired in `App.tsx` (`if (view === 'stats') return <StatsPage … />`)
  and supports live refresh while a run is active.
- **It has no entry point** — `Sidebar` never receives an `onOpenStats` prop, so
  the view is currently unreachable from the UI.
- **It is styled in the shadcn / Tailwind aesthetic** (`theme.css` tokens:
  near-black `#030213`, monospace cards, indigo/cyan/emerald charts) — which
  clashes with the chat panel's warm-paper look (`lea-v2.css`: cream `#f5f4ef`,
  terracotta `#c96442`, Georgia serif, soft green/red/amber, 12px radius).
- The backend is complete: `GET /api/stats` → `store.usage_stats()` returns
  `{ sessions, global, daily, models }`; `GET /api/sessions/{id}` returns
  `usage_breakdown`. **No backend change is needed for this pass.**

## Work items

### 1. Wire the entry point (small)

- `Sidebar.tsx`: add an `onOpenStats: () => void` prop and a stats icon button in
  `.sidebar-foot`, immediately left of the existing `.gear` button. Use a
  `lucide-react` icon already in the bundle (e.g. `BarChart3` / `TrendingUp`) or a
  glyph consistent with the `⚙` treatment; reuse/extend the `.gear` button style.
- `App.tsx`: pass `onOpenStats={() => setView('stats')}` into `<Sidebar … />`.
  (`view === 'stats'` rendering already exists — no other change.)

### 2. Reskin `StatsPage` to the warm-paper system (the bulk)

Match the chat panel's hand-written-CSS approach rather than shadcn utilities:

- Wrap the page in the `lea-app` scope and add a `.stats` block to
  `src/styles/lea-v2.css` mirroring the chat conventions (`.pane-head`, `.chip`,
  panel/line/ink vars, 12px radius). Replace Tailwind color utilities
  (`bg-background`, `border-border`, `text-muted-foreground`, …) and inline hex
  colors with these classes / CSS vars.
- Replace the page header (the `ArrowLeft` "Back / Usage & Statistics" bar) with a
  `.pane-head`-style header so it reads as a native Lea view.
- Re-map the hardcoded chart/accent constants at the top of `StatsPage.tsx`:

  | Constant (current) | Now | Warm-paper target |
  |---|---|---|
  | `INPUT_COLOR` `#6366f1` | indigo | `--fn` `#2f6f9f` (or `--accent` `#c96442`) |
  | `OUTPUT_COLOR` `#22d3ee` | cyan | `--amber`/`--num` `#b8842a` |
  | `MONEY_COLOR` `#34d399` | emerald | `--green` `#4f8a5b` |
  | `MODEL_COLORS` (6 neon hues) | — | warm palette: accent / fn / green / amber / type / red |
  | status / badges | — | `.chip.ok` / `.chip.run` / `.chip.fail` (green/amber/red soft) |

- Stat cards: keep monospace for the numeric values (fits the codey feel) but use
  `--ink` for the figure and softened `--muted` small-caps labels; cards on
  `--panel` with `--line` borders and `--radius`.
- Recharts: keep the components, swap the gradient/stroke/fill/tooltip colors to
  the warm palette; soften axis tick color to `--muted`.

### 3. Reconcile `api.ts` types (small, required to type-check)

`StatsPage` imports `UsageSessionSummary` from `../api`, which **is not defined
there**, and `UsageStats` is loosely typed (`global: Record<string, number>`,
`models: Record<string, unknown>[]`) while the page reads concrete fields
(`global.cost_usd`, `models[].model`, `session.primary_model`, …).

- Add an exported `UsageSessionSummary` interface matching the backend's
  `_normalize_usage_session` shape (`primary_model`, `input_tokens`,
  `output_tokens`, `total_tokens`, `cost_usd`, `message_count`, `run_count`,
  `duration_seconds`, `started_at`, `ended_at`, `status`, `title`, `id`, …).
- Tighten `UsageStats` (`global: UsageGlobals`, `daily: UsageDay[]`,
  `models: UsageModelRow[]`, `sessions: UsageSessionSummary[]`).
- These mirror fields already produced by `adapter/app/store.py`; no backend change.

### 4. Verify

- `npm run build` (and the project's typecheck/lint) passes — confirms item 3.
- Manual/visual: open the app, click the new sidebar stats button, confirm the
  panel renders in the warm-paper theme and visually matches the chat panel
  (background, borders, accent, chips, charts), including the empty state and a
  live-running session.

## Files touched

- `src/app/components/Sidebar.tsx` — add prop + footer button.
- `src/app/App.tsx` — pass `onOpenStats`.
- `src/app/components/StatsPage.tsx` — reskin (classes, header, color constants).
- `src/styles/lea-v2.css` — add `.stats` block.
- `src/app/api.ts` — add/tighten usage types.

## Out of scope / future work

- **Direct vs Overleaf split.** Not in this pass. When wanted, the cleanest route
  is an explicit `source` column on `runs` (extension stamps `source='overleaf'`
  on `createRun`), then group `usage_stats()` by source and add a segment toggle.
  A no-migration interim is to use `runs.autonomous` (=1 ≈ the Overleaf autonomous
  path) as a proxy.

## Notes / risks

- `SettingsPage.tsx` is also still shadcn-styled. This plan leaves it untouched;
  if the warm-paper variables in `theme.css` are ever swapped globally instead of
  scoping the reskin to `.stats`, it would affect Settings too — hence the scoped
  `.stats` CSS approach above.
- Keep the reskin scoped (new `.stats` rules + local constant swaps) so no other
  shadcn component shifts.
