"""Blueprint parsing + validation (D28/D29).

`.lea/blueprint.md` is the project's canonical proof decomposition — co-authored by
the agent (via its file tools) and the human, committed on every write (D8). This
module is the *read* side: a robust line-scan that turns the markdown into nodes +
`uses` edges, plus a validator that returns **advisory warnings** (never errors) so
a malformed section degrades locally instead of failing the whole graph.

Why a line-scan and not YAML/regex-over-prose: the file is edited by two sloppy
writers with string tools, and its node bodies are free prose/LaTeX. A line-scan
only cares about `## ` headings and `- key: value` header lines; everything else is
statement text it can't choke on. The parser is fence-aware so a ```-fenced example
(in the seed or the injected context) never registers as a real node.

The format — one `## ` section per node:

    ## continuous_sq
    - kind: lemma                         (definition | lemma | theorem)
    - lean: `Lea.Epsilon.continuous_sq`   (the live decl; omit until named)
    - uses: tendsto_iff_eps, distance_lower   (dependency edges)

    The function x ↦ x² is continuous in the ε–δ sense.   ← statement prose

Status/color is NOT in the file — it's derived from live Lean state in T2.
"""

from __future__ import annotations

import re

# Header lines the parser understands. Anything else under a node is statement prose.
_HEADER_KEYS = ("kind", "lean", "uses")
_HEADER_RE = re.compile(r"^\s*-\s*(kind|lean|uses)\s*:\s*(.*?)\s*$", re.IGNORECASE)
_HEADING_RE = re.compile(r"^##\s+(.+?)\s*$")
_FENCE_RE = re.compile(r"^\s*```")

# The shapes a node's `kind` may take (D28: definition=box · lemma/theorem=ellipse).
VALID_KINDS = ("definition", "lemma", "theorem")


def _strip_inline_code(value: str) -> str:
    """`Lea.Foo.bar` → Lea.Foo.bar — drop wrapping backticks the model/human often
    add around the `lean:` decl name."""
    return value.strip().strip("`").strip()


def parse(text: str) -> dict:
    """Parse blueprint markdown into ``{"nodes": [...], "edges": [...]}``.

    Each node: ``{key, kind, lean, uses: [str], statement}`` (``kind``/``lean`` are
    ``None`` when absent — an un-named node is a *planned* node). Each edge:
    ``{"from": key, "to": dep_key}``, one per ``uses`` entry, in declared order.

    Robust by construction: a ``## `` line opens a node, recognised ``- key:`` lines
    fill its header, every other line is appended to the statement. Lines inside a
    ```` ``` ```` fence are inert (so fenced examples can't spawn phantom nodes)."""
    nodes: list[dict] = []
    current: dict | None = None
    statement_lines: list[str] = []
    in_fence = False

    def flush_statement() -> None:
        if current is not None:
            current["statement"] = "\n".join(statement_lines).strip()

    for line in (text or "").splitlines():
        if _FENCE_RE.match(line):
            in_fence = not in_fence
            if current is not None:
                statement_lines.append(line)
            continue

        if not in_fence:
            heading = _HEADING_RE.match(line)
            if heading:
                flush_statement()
                current = {"key": heading.group(1).strip(), "kind": None, "lean": None, "uses": []}
                statement_lines = []
                nodes.append(current)
                continue

            header = _HEADER_RE.match(line) if current is not None else None
            if header:
                key, value = header.group(1).lower(), header.group(2)
                if key == "kind":
                    current["kind"] = value.strip().lower() or None
                elif key == "lean":
                    current["lean"] = _strip_inline_code(value) or None
                elif key == "uses":
                    current["uses"] = [d for d in (p.strip() for p in value.split(",")) if d]
                continue

        if current is not None:
            statement_lines.append(line)

    flush_statement()

    edges = [{"from": n["key"], "to": dep} for n in nodes for dep in n["uses"]]
    return {"nodes": nodes, "edges": edges}


def validate(text: str) -> list[dict]:
    """Parse and return **advisory** warnings (never raise) about the structure, so
    the authoring view (F6) can flag problems without blocking the save. Each warning
    is ``{"node": key | None, "message": str}``. Checks: duplicate node keys, missing
    or unrecognised ``kind``, and dangling ``uses`` edges (a dependency that names no
    existing node)."""
    parsed = parse(text)
    nodes = parsed["nodes"]
    keys = [n["key"] for n in nodes]
    known = set(keys)
    warnings: list[dict] = []

    seen: set[str] = set()
    for key in keys:
        if key in seen:
            warnings.append({"node": key, "message": f"duplicate node key `{key}` — keys must be unique"})
        seen.add(key)

    for node in nodes:
        key = node["key"]
        if node["kind"] is None:
            warnings.append({"node": key, "message": f"node `{key}` has no `kind:` (definition | lemma | theorem)"})
        elif node["kind"] not in VALID_KINDS:
            warnings.append(
                {"node": key, "message": f"node `{key}` has unrecognised kind `{node['kind']}` (use definition | lemma | theorem)"}
            )
        for dep in node["uses"]:
            if dep not in known:
                warnings.append(
                    {"node": key, "message": f"node `{key}` uses `{dep}`, which is not a node in this blueprint"}
                )

    return warnings
