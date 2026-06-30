# Feature: Inline Lea Tags (LaTeX-Package-Based Target Markers)

## Summary

Add a second, opt-in way to mark a theorem, lemma, proposition, corollary, or
definition for Lea: an invisible LaTeX command from a small first-party
package, instead of (or alongside) the existing `% lea:` comment marker.

```tex
\usepackage{lea-tags}
...
\begin{claim}\label{clm:even-square}
\leatheorem{label=even_square, uses={even_def}, context={Use the parity definition first.}}
If $n$ is even, then $n^2$ is even.
\end{claim}
```

`\leatheorem{...}` typesets nothing. The Overleaf extension scans the editor
source for these commands the same way it scans for `% lea:` comments today,
and produces the same target shape the rest of the pipeline already consumes.

This is additive, not a replacement. The current comment-marker system
(`docs/FEATURE-overleaf-comment-marked-theorems.md`,
`docs/FEATURE-overleaf-definition-tags.md`) is implemented and working
(`apps/overleaf-extension/extension/targetParserCore.mjs`); nothing here
changes its behavior.

## Goal

Let Lea recognize a theorem-like or definition-like block without requiring
the block to sit inside one of a fixed set of LaTeX environment names.

The current detector only looks inside `theorem`, `lemma`, `proposition`,
`corollary`, and `definition` environments
(`SUPPORTED_ENVIRONMENTS` in `targetParserCore.mjs`). Real papers routinely
define their own theorem-like environments with `\newtheorem` — `claim`,
`conjecture`, `fact`, `observation`, journal-specific names, or renamed
environments from a shared house style file. None of those work with Lea
today even though the comment-marker mechanics underneath are environment-name
agnostic in every other respect.

A package-based tag also gives LaTeX itself a chance to catch malformed
metadata (unbalanced braces, a stray `}` in `context={...}`) as a normal
compile error, instead of the author finding out only from the extension's
own diagnostics panel.

## Current Behavior

Today's detector works in two layers, both inside `targetParserCore.mjs`:

1. `findSupportedEnvironments` regex-scans for `\begin{theorem}`,
   `\begin{lemma}`, `\begin{proposition}`, `\begin{corollary}`, and
   `\begin{definition}` and tracks nesting with a stack.
2. `findLeaCommentGroups` regex-scans for contiguous `% lea: ...` comment
   lines, then `parseCommentMarkedTargets` associates each group with its
   smallest enclosing environment from step 1, requires exactly one marker
   group per environment, validates `label`/`uses` as Lean identifiers, and
   strips the marker comments and `\label{...}` from the extracted body text
   (`stripLeaTargetText`).

Each resulting target already carries a `syntax` field, currently always
`"comment"` — a sign the original design anticipated more than one marker
syntax even though only one is implemented.

The legacy `\theorem[label=...]{...}` command syntax also still works as a
deprecated compatibility path (see `README.md`).

## Why A LaTeX Package Instead Of Just More Comment Syntax

Three things a comment marker structurally cannot do, that a real command
can:

- **Environment-name independence.** A command can say what kind of target it
  is (`\leatheorem`, `\lealemma`, `\leadefinition`, or a generic
  `\lea{kind=theorem,...}`) without the enclosing environment's name having
  to match an allowlist. This removes the single biggest practical limitation
  of the current system.
- **Compile-time structural validation.** A malformed `% lea: context={...`
  with a missing closing brace is silently mis-parsed by the extension and
  the author may not notice until the target looks wrong in the popover. A
  malformed `\leatheorem{context={...}` is a LaTeX compile error the moment
  the author saves, surfaced in Overleaf's own log.
- **A documented, versioned surface.** A `.sty` file can ship its own usage
  comments and a changelog, and tools that understand LaTeX packages (editor
  autocomplete, linters) can reason about it. A bare comment convention has
  none of that.

What it gives up, relative to a comment:

- **A new failure mode.** A forgotten `\usepackage{lea-tags}` turns every
  `\leatheorem{...}` call into an "Undefined control sequence" compile error
  for the whole document. A forgotten or malformed `% lea:` comment just means
  the target is silently not detected — annoying, never build-breaking.
- **A new distribution problem.** The package file has to exist somewhere the
  Overleaf project's compiler can find it. See Distribution below.
- **Slightly more authoring ceremony** for documents that don't already use
  amsthm-style environments at all.

## Recommendation

Ship tag-based detection as a second `syntax` value alongside the existing
comment marker, not a replacement:

- Keep `% lea:` comments as the zero-setup default. It requires no preamble
  change and can never break a build, so it stays the right answer for
  someone trying Lea for the first time.
- Add `\lea{...}` / `\leatheorem{...}` / `\lealemma{...}` /
  `\leaproposition{...}` / `\leacorollary{...}` / `\leadefinition{...}` as the
  answer for documents whose theorem-like environments aren't in the
  allowlist, or for authors who'd rather have a compile error than a silently
  unrecognized marker.
- Reuse the existing key=value / braced-list parsing helpers
  (`parseBalancedSuffix`, `splitMetadataEntries`, `splitTopLevel`, `unbrace`,
  `parseMetadata`) for tag arguments. They already operate on a plain string
  and don't care whether that string came from a comment or a macro argument,
  so the new parser surface is mostly a new "find the markers" function, not
  new metadata parsing.

## Tag Syntax

### Package

A single file, `lea-tags.sty`, defining commands that typeset nothing:

```tex
\NeedsTeXFormat{LaTeX2e}
\ProvidesPackage{lea-tags}[2026/07/01 v0.1 Lea inline formalization tags]
\RequirePackage{xparse}

% Generic form: caller states kind= explicitly.
\NewDocumentCommand{\lea}{m}{}

% Named convenience wrappers, equivalent to \lea{kind=...,<args>}.
\NewDocumentCommand{\leatheorem}{m}{}
\NewDocumentCommand{\lealemma}{m}{}
\NewDocumentCommand{\leaproposition}{m}{}
\NewDocumentCommand{\leacorollary}{m}{}
\NewDocumentCommand{\leadefinition}{m}{}
```

Every command takes one braced argument and expands to nothing. LaTeX still
parses the argument as a balanced group, which is what gives us compile-time
brace validation; the contents are never typeset and never interpreted by
LaTeX beyond brace matching.

### Tagging an existing (possibly custom) environment

```tex
\begin{claim}\label{clm:foo}
\leatheorem{label=foo_claim, uses={bar}, context={Treat foo as a Nat predicate.}}
Statement text...
\end{claim}
```

`claim` is not in today's environment allowlist and would be invisible to
Lea under the comment-marker path. Because `\leatheorem` states its own kind,
the parser no longer needs `claim` to be a recognized name — it only needs
*some* enclosing `\begin{X}...\end{X}` to know where the target's body
starts and ends.

### Generic form, for any kind

```tex
\begin{conjecture}\label{conj:open}
\lea{kind=theorem, label=open_conjecture, context={State only; mark as a stub if unprovable today.}}
Goldbach-style statement...
\end{conjecture}
```

`kind` accepts the same values the comment marker already accepts:
`theorem` and `definition`.

### Shorthand environment (not yet implemented)

For authors who don't already use `amsthm`, a sugar environment could wrap
both the visual numbering and the tag in one block:

```tex
\begin{leatheorem}{label=foo}
Statement text...
\end{leatheorem}
```

This would be an ordinary `\newtheorem`-backed environment plus a
`\leatheorem{...}` tag at the top, detected exactly like the
tag-on-existing-environment case (pure sugar, not a new detection path). The
shipped v1 package only defines the six no-op tag commands
(`\lea`/`\leatheorem`/`\lealemma`/`\leaproposition`/`\leacorollary`/
`\leadefinition`); this shorthand environment is deferred to a later version
-- see Future Extensions.

## Metadata Fields

Identical semantics to the existing comment marker — `label` (required, valid
Lean identifier), `uses` (optional braced comma list of prior Lea labels),
`context` (optional free text), `kind` (only meaningful with the generic
`\lea{...}` form; implied by the named wrappers). See
`docs/FEATURE-overleaf-comment-marked-theorems.md` and
`docs/FEATURE-overleaf-definition-tags.md` for the field-level rules this
reuses verbatim.

## Detection And Extraction Changes (`targetParserCore.mjs`)

1. New `findLeaTagCommands(source)`, parallel to `findLeaCommentGroups`:
   regex-scan for `\lea`, `\leatheorem`, `\lealemma`, `\leaproposition`,
   `\leacorollary`, `\leadefinition` (word-boundary, not preceded by a
   letter, so it doesn't match a user's own `\leaniteration`-style macro),
   then extract the single `{...}` argument with the existing
   `parseBalancedSuffix` helper. Reject (with a diagnostic) a tag command
   whose argument isn't a single balanced brace group immediately following
   it.
2. The named wrappers map directly to a `kind` (`\leatheorem` /
   `\lealemma` / `\leaproposition` / `\leacorollary` → `theorem`,
   `\leadefinition` → `definition`); the generic `\lea{...}` reads `kind=`
   from its own argument, same as `% lea: formalize kind=definition` does
   today.
3. New `findGenericEnvironments(source)`: the same nesting-stack approach as
   `findSupportedEnvironments`, but matching **any** `\begin{X}...\end{X}`
   pair rather than only the allowlisted names. Used only to locate the
   smallest enclosing environment for a *tag*-based marker. The
   comment-marker path keeps using the allowlisted `findSupportedEnvironments`
   unchanged, so no existing document's behavior changes.
4. Tag markers found with no enclosing environment at all produce a
   `missing_environment` diagnostic, same code the comment path already uses
   for the analogous case.
5. `extractEnvironmentText` / `stripLeaTargetText` are reused for body
   extraction; `stripLeaTargetText` gets one addition — strip
   `\lea{...}` / `\leatheorem{...}` / etc. calls (matched with the same
   balanced-brace logic) from the extracted body, the same way it already
   strips `% lea: ...` lines and `\label{...}`.
6. Targets produced this way set `syntax: "tag"` instead of `"comment"`. The
   field already exists in the target shape and is plumbed through; nothing
   downstream needs to change to carry it.
7. A marker count or kind mismatch between a comment marker and a tag command
   inside the same environment reuses the existing `duplicate_marker` /
   `environment_mismatch` diagnostics, generalized to be syntax-agnostic —
   one target per environment, regardless of which syntax declared it.

### New diagnostic: package not loaded

Tag commands only compile if `lea-tags.sty` (or an inline fallback
definition, see Distribution) is loaded. Add a preamble check: scan the text
before `\begin{document}` for `\usepackage{lea-tags}` (or `\input{lea-tags}`,
or a `\NewDocumentCommand{\lea}` redefinition) whenever the body contains a
tag command. If it's missing, emit a `tag_package_not_loaded` diagnostic
*before* the author hits a broken Overleaf compile, since that failure mode
doesn't exist for comment markers and is the main new risk this feature
introduces.

## Companion Behavior

No prompt changes. The companion already branches on `targetKind`
(`theorem` vs `definition`), and `syntax` is informational only — record it
on the job for debugging/telemetry, but it must not affect which prompt is
selected or how `uses` is resolved. A theorem tagged via `\leatheorem{...}`
and one tagged via `% lea: formalize` are indistinguishable to the companion
and the adapter.

## UI Behavior

No new user-facing copy for the common case — badges, popovers, and status
text stay exactly as they are for comment-marked targets. The only new UI
surface is the `tag_package_not_loaded` diagnostic, which should be shown
prominently (it is the one failure mode in this feature that can break the
author's document compile, not just hide a target from Lea).

A `(tag)` vs `(comment)` distinction is useful only in a diagnostics/debug
view, not in the primary popover.

## Distribution

This is the open question with the most product-decision weight, called out
explicitly rather than decided here:

1. **Manual install (recommended for v1).** The user downloads
   `lea-tags.sty` from the extension's options page or repo, uploads it as a
   project file in Overleaf, and adds one `\usepackage{lea-tags}` line. No
   new extension permissions, no new write surface. Matches how most users
   already install a house-style `.sty` on Overleaf.
2. **Inline preamble snippet (recommended alongside #1).** Since the package
   body is five `\NewDocumentCommand` lines with no real dependencies beyond
   `xparse`, also publish it as a copy-paste preamble block so users who
   don't want a second project file can paste it directly instead of
   `\usepackage{lea-tags}`. Zero file-upload step at all.
3. **Auto-provisioning (future).** A one-click "Insert Lea tags" action that
   writes the `.sty` file into the Overleaf project and patches the main
   `.tex` preamble automatically. This needs Overleaf project-file write
   access the extension doesn't currently have (it reads editor text and
   overlays DOM badges; it doesn't write project files). Worth revisiting if
   the extension gains project-file write capability for other reasons, but
   out of scope for the first version of this feature.

## Compatibility

- Existing `% lea:` comment markers, the legacy `\theorem[label=...]{...}`
  command, and the existing environment allowlist all continue to work
  unchanged.
- A document that never loads `lea-tags` and never uses tag commands behaves
  exactly as it does today — this feature has no effect until an author
  opts in.
- A theorem-like environment may use either syntax but not both; using both
  in the same environment is a `duplicate_marker` diagnostic, same as two
  comment-marker groups today.

## Acceptance Criteria

1. A custom (non-allowlisted) environment such as `\begin{claim}...\end{claim}`
   containing `\leatheorem{label=foo}` appears in the extension UI as a
   formalizable theorem target.
2. The tag commands are invisible in the rendered PDF.
3. The extracted target text excludes tag commands and `\label{...}`, exactly
   as it already excludes `% lea:` comments and `\label{...}`.
4. `label`, `uses`, `context`, and `kind` preserve identical semantics and
   validation to the comment-marker path.
5. A document with a tag command but no `\usepackage{lea-tags}` (and no
   inline fallback definition) produces a `tag_package_not_loaded`
   diagnostic in the extension before the author needs to discover it from a
   failed Overleaf compile.
6. Mixing a comment marker and a tag command in the same environment produces
   a clear duplicate-marker diagnostic.
7. Targets produced via tags carry `syntax: "tag"`; targets produced via
   comments continue to carry `syntax: "comment"`.
8. The companion and adapter behave identically regardless of which `syntax`
   produced a given `targetKind`/`targetLabel`/`targetText`.
9. All existing comment-marker and legacy-command tests continue to pass
   unmodified.
10. New tests cover: custom-environment detection, the generic `\lea{kind=...}`
    form, each named wrapper, the `leatheorem` shorthand environment, the
    missing-package diagnostic, and cross-syntax duplicate detection.

## Future Extensions

- The `leatheorem` shorthand environment described above, for documents with
  no existing theorem-like environments.
- A "draft mode" rendering of tags as small margin notes (visible only when a
  document-level flag is set), for authors who want a visual reminder of
  what's tagged without publishing it.
- Tagging sub-claims inside a `proof` environment, once there's a use case
  for formalizing intermediate steps rather than only top-level statements.
- Auto-provisioning the package into a project (Distribution option 3 above).
- A lint mode the companion or a CI step can run against a `.tex` source to
  report tag/comment diagnostics without opening Overleaf at all.

## Implementation Status

Implemented (2026-06-30): all phases in `docs/PLAN-overleaf-inline-lea-tags.md`
are done and tested -- `lea-tags.sty` (options-page download + copy-snippet),
tag detection and the `tag_package_not_loaded`/`malformed_tag`/
`suspicious_environment` diagnostics in `targetParserCore.mjs`, Lean pane
tag-awareness in `leanPaneManifest.mjs`, and `targetSyntax` telemetry on the
companion job record. See that plan's Status section for the two correctness
issues found during implementation (and fixed) that aren't otherwise obvious
from this spec.
