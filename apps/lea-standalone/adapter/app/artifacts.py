"""Lean artifact shape classification for UI/result labels.

This is intentionally shallow: Lean itself owns correctness via ``lean_check``.
The classifier only decides whether a checked file should be displayed as a
theorem proof or as a definition-oriented artifact.
"""

from __future__ import annotations

import re


_BLOCK_COMMENT_RE = re.compile(r"/-[\s\S]*?-/")
_LINE_COMMENT_RE = re.compile(r"--.*$", re.MULTILINE)
_STRING_RE = re.compile(r'"(?:\\.|[^"\\])*"')

_PROOF_DECL_RE = re.compile(
    r"(?m)^\s*(?:private\s+|protected\s+|noncomputable\s+|unsafe\s+)*"
    r"(?:theorem|lemma|example)\b"
)
_DEFINITION_DECL_RE = re.compile(
    r"(?m)^\s*(?:private\s+|protected\s+|noncomputable\s+|unsafe\s+|partial\s+)*"
    r"(?:def|abbrev|structure|class|inductive|coinductive|instance|opaque)\b"
)


def classify_lean_artifact(code: str | None) -> str:
    """Return ``proof``, ``definition``, ``mixed``, or ``unknown`` for Lean code."""
    if not code or not code.strip():
        return "unknown"
    scrubbed = _scrub_comments_and_strings(code)
    has_proof = bool(_PROOF_DECL_RE.search(scrubbed))
    has_definition = bool(_DEFINITION_DECL_RE.search(scrubbed))
    if has_proof and has_definition:
        return "mixed"
    if has_proof:
        return "proof"
    if has_definition:
        return "definition"
    return "unknown"


def _scrub_comments_and_strings(code: str) -> str:
    without_comments = _LINE_COMMENT_RE.sub(" ", _BLOCK_COMMENT_RE.sub(" ", code))
    return _STRING_RE.sub('""', without_comments)


_NAMED_DECL_RE = re.compile(
    r"(?m)^\s*(?:private\s+|protected\s+|noncomputable\s+|unsafe\s+|partial\s+)*"
    r"(?:theorem|lemma|def|abbrev|structure|class|inductive|coinductive|instance|opaque)\s+"
    r"([A-Za-z_][A-Za-z0-9_']*)"
)


def extract_declaration_name(code: str | None) -> str | None:
    """The first top-level declaration's name, or None.

    Recorded proof files are one-declaration-per-file by convention, so "first
    declaration" is "the declaration". Used by the run finalizer to write the
    structured artifact index (PLAN-system-hardening 4.1) — the durable answer
    to "which declaration lives in which file" that clients previously had to
    reverse-engineer from filesystem diffs."""
    if not code:
        return None
    scrubbed = _scrub_comments_and_strings(code)
    match = _NAMED_DECL_RE.search(scrubbed)
    return match.group(1) if match else None


_SORRY_MARKER_RE = re.compile(r"\b(sorry|admit)\b")


def contains_sorry_marker(code: str | None) -> bool:
    """True when the code still leans on sorry/admit — comments and strings
    scrubbed first, so prose like `-- no sorry here` doesn't count. The
    ledger-side twin of the companion's containsSorryMarker (PLAN 4.4): status
    verdicts move adapter-side, so the scan lives here too."""
    if not code:
        return False
    return bool(_SORRY_MARKER_RE.search(_scrub_comments_and_strings(code)))


def declaration_present(code: str | None, name: str) -> bool:
    """Whether a top-level declaration with this exact name exists in the code
    (comments/strings scrubbed)."""
    if not code or not name:
        return False
    pattern = re.compile(
        r"(?m)^\s*(?:private\s+|protected\s+|noncomputable\s+|unsafe\s+|partial\s+)*"
        r"(?:theorem|lemma|def|abbrev|structure|class|inductive|coinductive|instance|opaque)\s+"
        + re.escape(name) + r"(?![A-Za-z0-9_'])"
    )
    return bool(pattern.search(_scrub_comments_and_strings(code)))
