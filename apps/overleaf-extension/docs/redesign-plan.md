# Overleaf Extension — Visual Redesign Plan

> **Goal:** align the Overleaf extension's look with the **lea-standalone "warm-paper"**
> design system (the palette in `apps/lea-standalone/src/styles/lea-v2.css`).
> **Scope:** *aesthetic only.* No behavior, DOM structure, state, or API changes —
> the same elements render in the same places; only their styling changes.
>
> **Decisions locked for this pass:**
> - Deliverable: this doc.
> - Theme: **warm light only** (no dark-mode variant; matches lea-standalone today).
> - Depth: **full reskin** — inline labels, status badges, both popovers, the floating
>   trigger, and the options page.

---

## 1. Why these two look unrelated today

The extension was styled independently from lea-standalone, so it reads as a different
product:

| Axis | Overleaf extension (now) | lea-standalone (target) |
|---|---|---|
| Accent | Violet `#7c3aed` / `#6d28d9` | Terracotta `#c96442` |
| Accent fill | `#ede9fe`, `#eef2ff` (cool) | `#f3e3db` accent-soft (warm) |
| Background | `#f6f7fb`, `#f9fafb`, `#f3f4f6` (cool grey) | `#f5f4ef` bg, `#faf9f6` panel-2 (warm paper) |
| Borders | `#e5e7eb`, `#d1d5db` (cool) | `#e9e7e0` line, `#efede7` line-2 (warm) |
| Text | `#111827` / `#374151` / `#6b7280` (slate) | `#1f1e1d` ink / `#3d3c39` ink-2 / `#8a8983` muted |
| Radius | 6–8px | 12px outer, 7–10px inner |
| Brand mark | none / hamburger glyph | serif "L" in a terracotta tile |
| Status colors | cool semantic (blue in-progress, etc.) | warm semantic (green/amber/red/terracotta) |

The good news: **almost all styling lives in `extension/content.css`** against stable
class names. `content.js` only sets *positioning* inline (`style.left/top`), never
colors. So the reskin is overwhelmingly a CSS token swap plus the standalone
`options.css`/`options.html` — low risk to functionality.

---

## 2. Design tokens to adopt

Port the warm-paper variables into a single `:root`-scoped block at the top of
`content.css` (and mirror the relevant subset in `options.css`). Source of truth is
`lea-v2.css`.

```css
/* warm-paper tokens, ported from lea-standalone/src/styles/lea-v2.css */
--ol-bg:        #f5f4ef;   --ol-panel:   #ffffff;  --ol-panel-2: #faf9f6;
--ol-ink:       #1f1e1d;   --ol-ink-2:   #3d3c39;  --ol-muted:   #8a8983;
--ol-line:      #e9e7e0;   --ol-line-2:  #efede7;
--ol-accent:    #c96442;   --ol-accent-soft: #f3e3db;  --ol-accent-ink: #a44f33; /* hover/darker */
--ol-green: #4f8a5b;  --ol-green-soft: #e6f0e7;
--ol-red:   #c0564a;  --ol-red-soft:   #f6e3e0;
--ol-amber: #b8842a;  --ol-amber-soft: #f6ecd8;
--ol-radius: 12px;    --ol-radius-sm: 8px;
--ol-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
--ol-sans: ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
```

> Prefixed `--ol-*` so the tokens never collide with Overleaf's own CSS variables on
> the host page. `--ol-accent-ink` (`#a44f33`) is a derived darker terracotta for
> button hover/active, since lea-v2 doesn't define one explicitly.

---

## 3. Status color mapping (the one real design decision)

lea-standalone has a **warm** semantic set (green = ok, amber = running/attention,
red = fail, terracotta = active/primary, muted = idle). The extension currently has
six statuses on a cooler scheme. Proposed mapping:

| Status | Now | New (warm) | Rationale |
|---|---|---|---|
| `formalized` | green | **green** (`--ol-green` / soft) | unchanged meaning |
| `unformalized` | amber | **amber** | "needs attention", matches lea idle/attention |
| `in_progress` | **blue** | **terracotta** (`--ol-accent`) | active agent work → brand accent (lea uses accent for "active") |
| `sorry_stub` | orange | **amber** (distinct shade or border) | partial / caution |
| `offline` / `failed` | red | **red** | unchanged meaning |
| `unavailable` | purple | **muted** (`--ol-muted` on `--ol-line-2`) | neutral, not alarming |

Open question to confirm during build: `unformalized` and `sorry_stub` both land on
amber — keep them distinguishable via border vs. fill (e.g. `sorry_stub` = amber text
on `--ol-amber-soft` with a dashed/!-marked accent; `unformalized` = amber on a
lighter fill). The existing `!` stub-use mark stays but recolors to amber.

---

## 4. Component inventory & target treatment

Every item below is a **restyle of existing markup** — no structural edits unless noted.

1. **Inline theorem highlight** (`.ol-lean-theorem`) — swap violet underline/fill for
   a soft terracotta (`--ol-accent` at low alpha, `--ol-accent-soft`-ish underline).
2. **Inline status badge** (`.ol-lean-status*`, the floating per-theorem pill) —
   warm panel, `--ol-line` border, 6px radius, semantic status colors from §3. Keep
   the pulse animation; retint to muted/amber.
3. **Stub-use mark** (`.ol-lean-stubbed-use-mark`) — amber instead of `#fde68a`.
4. **Floating settings trigger** (`.ol-lean-settings-trigger`) — warm panel pill,
   `--ol-line` border, terracotta hover; **optionally** replace the 3-slider glyph
   with the serif **"L"** tile (`background: --ol-accent; color:#fff; font-family:
   Georgia, serif`) to carry the lea brand. (Brand-mark swap is the only optional
   markup change; default to keeping the glyph if we want pure-CSS.)
5. **Theorem popover** (`.ol-lean-theorem-popover` + title/meta/buttons) — 12px
   radius, warm panel, softer warm shadow, terracotta primary button
   (`[data-primary="true"]`), warm secondary buttons.
6. **Main settings/usage popover** (`.ol-lean-popover`, header, kicker, mark, body) —
   12px radius, warm shadow + arrow recolor; the kicker **mark** tile goes terracotta
   on `--ol-accent-soft`; uppercase mono kickers keep their type, recolor to `--ol-muted`.
7. **Theorem card / usage panel / settings panel** (`.ol-lean-theorem-card`,
   `.ol-lean-usage-panel`, `.ol-lean-settings-panel`) — `--ol-panel-2` fill,
   `--ol-line-2` border, warm text.
8. **Status chips** (`.ol-lean-status-chip-*`) — same warm semantic set as §3.
9. **Usage metrics** (`.ol-lean-usage-*`) — warm fills, terracotta emphasis numbers
   (`strong` was violet `#7c3aed` → `--ol-accent`), warm separators.
10. **Provider panel** (`.ol-lean-provider-*`) — configured state goes from cool
    indigo (`#eef2ff`/`#c7d2fe`/`#4338ca`) to **terracotta-soft** (`--ol-accent-soft`
    border/fill, `--ol-accent-ink` label).
11. **Buttons** (`.ol-lean-primary-button`, `secondary`, `save-button`) — primary &
    active-save go terracotta with `--ol-accent-ink` hover; secondary warm panel.
12. **Cost-cap notice** (`.ol-lean-cost-cap-notice`) — keep red semantics, but move
    to the warm red tokens (`--ol-red` / `--ol-red-soft`) and 10–12px radius.
13. **Focus rings** (`:focus-visible`, currently violet `rgba(124,58,237,.55)`) →
    terracotta `--ol-accent` at ~55% alpha.
14. **Options page** (`options.html` + `options.css`) — page bg `--ol-bg`, white card
    with `--ol-line` border + 12px radius, terracotta submit button, warm inputs,
    warm provider-key status list (keep green/red configured/missing states but on
    warm soft fills). Add a small serif "L" + "Lea Formalizer" lockup to the `<h1>`
    to match the brand mark. Markup edits here are minimal (a header lockup span).

---

## 5. Typography

Keep the existing font *stacks* (system sans, ui-mono) — lea-v2 uses the same
families, so no font loading is needed. Two refinements to match lea:
- Introduce **Georgia serif** only for the brand "L" mark (trigger tile + options
  header), mirroring `.brand .logo` / `.avatar.lea` in lea-v2.
- The uppercase mono "kicker/label" treatment already matches lea's `.group-label`
  spirit — keep it, just recolor to `--ol-muted`.

---

## 6. Execution steps

**Step 1 — Token layer.** Add the `--ol-*` token block to the top of `content.css`.
No visual change yet; purely additive.

**Step 2 — Reskin `content.css` by section**, top to bottom, replacing literal hex
with tokens, in this order so each is independently reviewable:
  1. Inline theorem highlight + status badges + stub mark + focus rings (items 1–3, 13)
  2. Floating trigger (item 4)
  3. Theorem popover (item 5)
  4. Main popover shell: header/kicker/mark/arrow (item 6)
  5. Cards + status chips (items 7–8)
  6. Usage + provider panels (items 9–10)
  7. Buttons + settings panel + cost-cap notice (items 11–12)

**Step 3 — Status semantics.** Apply the §3 mapping; resolve the
`unformalized` vs `sorry_stub` distinction visually.

**Step 4 — Options page.** Reskin `options.css`; add the brand lockup to
`options.html`.

**Step 5 — Brand mark (optional).** If we want the serif "L", swap the trigger's
slider glyph markup in `content.js` (lines ~83–87) for the tile span. This is the
*only* JS touch; skip it to keep the pass pure-CSS.

**Step 6 — Verification (see §7).**

**Step 7 — Cleanup.** Grep for any remaining cool-palette hex literals
(`7c3aed`, `6d28d9`, `ede9fe`, `eef2ff`, `2f65f6`, `f6f7fb`, `e5e7eb`, `111827`, …)
to confirm full migration.

---

## 7. Verification

- **Visual diff in Overleaf:** load the unpacked extension, open a document with
  theorems, and screenshot each surface — inline highlight, each status badge state,
  the floating trigger, the theorem popover, the full settings/usage popover
  (including provider-configured vs not), the cost-cap notice, and the options page.
  Compare side-by-side against the lea-standalone chat UI for palette consistency.
- **State coverage:** exercise all six statuses (formalize a theorem, trigger an
  in-progress run, force an offline/failed state) to confirm every status color reads
  correctly and stays legible on Overleaf's own light background.
- **Contrast check:** verify text/background pairs meet ~WCAG AA (terracotta `#c96442`
  on white for buttons; muted `#8a8983` for secondary text).
- **No-regression sweep:** `git diff` should show **only** `content.css`, `options.css`,
  `options.html` (and optionally the one `content.js` glyph block) — confirming the
  change is aesthetic. Smoke-test that buttons still fire actions and the popover still
  opens/positions (positioning is JS-driven and untouched).
- **Host-collision check:** confirm `--ol-*` prefixed tokens and `.ol-lean-*` scoping
  mean nothing leaks into or inherits from Overleaf's page styles.

---

## 8. Risks & notes

- **Z-index / overlay context unchanged** — we're not touching positioning, stacking,
  or `pointer-events`, so the overlay keeps working.
- **Legibility over Overleaf's UI:** the warm paper bg is light, like Overleaf's
  editor chrome; badges keep a solid panel fill + border so they stay readable against
  any editor background.
- **Dark mode deferred:** lea-standalone is light-only today; if it later ships the
  warm-paper dark variant, revisit with a `prefers-color-scheme` / Overleaf-theme
  hook. Token structure here makes that a localized future change.
- **Single source of truth:** consider, in a later pass, extracting the `--ol-*`
  tokens into a shared file both apps import, so the two never drift again. Out of
  scope for this aesthetic pass but worth flagging.

---

## 9. Files touched

| File | Change |
|---|---|
| `extension/content.css` | Token block + full repalette (bulk of the work) |
| `extension/options.css` | Repalette page/card/inputs/buttons |
| `extension/options.html` | Add brand lockup span to `<h1>` (minor) |
| `extension/content.js` | *Optional:* swap trigger glyph for serif "L" (~lines 83–87) |
