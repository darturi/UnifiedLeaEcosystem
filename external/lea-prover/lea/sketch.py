"""Sketch utilities — extract sorrys, assemble proofs."""

import re
from pathlib import Path


def extract_sorrys(path: str | Path) -> list[dict]:
    """Find all sorry locations in a .lean file.

    Returns a list of dicts, each with:
      - line: 1-indexed line number of the sorry
      - name: name of the enclosing have/lemma/theorem, or None
      - type: the type annotation if available, or None
      - context: a few surrounding lines for the fill prompt
    """
    path = Path(path)
    if not path.exists():
        return []

    lines = path.read_text().splitlines()
    sorrys = []

    for i, line in enumerate(lines):
        # Match any line containing sorry as a tactic/term
        if re.search(r'\bsorry\b', line) is None:
            continue
        stripped = line.strip()
        # Skip comments
        if stripped.startswith("--") or stripped.startswith("/-"):
            continue

        # Look backwards for the enclosing have/lemma/theorem
        name = None
        type_str = None
        for j in range(i, max(i - 10, -1), -1):
            m = re.match(r'\s*(?:have|let)\s+(\w+)\s*:\s*(.+?)\s*:=', lines[j])
            if m:
                name = m.group(1)
                type_str = m.group(2).strip()
                break
            m = re.match(r'\s*(?:theorem|lemma)\s+(\w+)', lines[j])
            if m:
                name = m.group(1)
                break

        # Gather context: 5 lines before, the sorry line, 3 lines after
        ctx_start = max(0, i - 5)
        ctx_end = min(len(lines), i + 4)
        context = "\n".join(lines[ctx_start:ctx_end])

        sorrys.append({
            "line": i + 1,
            "name": name,
            "type": type_str,
            "context": context,
        })

    return sorrys


def count_sorrys(path: str | Path) -> int:
    """Quick count of sorry occurrences in a file."""
    text = Path(path).read_text()
    return len(re.findall(r'\bsorry\b', text))
