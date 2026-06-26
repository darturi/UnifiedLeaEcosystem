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
