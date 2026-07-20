"""Declarative subagent profiles (v2.3 item 19).

A *role* is one YAML file in ``lea/agents/<name>.yaml``: config keys plus an
explicit ``system_prompt`` block. Adding a role is writing a file, not writing
code — the loader turns the file into an :class:`AgentProfile`, and
``spawn_subagent(subagent_type=<name>)`` (item 18) builds the child config from it.

**Why one YAML dict, not markdown + ``---`` frontmatter.** The prompt is the bulk of
the file and it is prose full of Lean syntax (colons, backticks, braces, code
blocks). A YAML ``|`` literal block scalar holds that verbatim — indentation is the
only structural rule — and an explicit ``system_prompt:`` key says exactly what it
is to anyone reading the file. This matches mini-swe-agent's config style
(``system_template``/``instance_template`` as ``|`` blocks) and Lea's own
radical-minimalism ethos better than borrowing a big harness's frontmatter format.

**Composition, not replacement (safety).** ``system_prompt`` is a role *head*: item 18
puts it in ``LeaConfig.system_prompt_head``, which the agent loop appends *after* the
shared Lean core (hard rules: never modify the theorem statement; no
``sorry``/``axiom``). A role can specialize and narrow, never drop a guardrail. Item
20 hardens this further (the volatile tail + the can't-drop-the-rules guarantee).

**Capability only narrows.** ``tools`` maps straight onto ``build_toolset(selected)``
(item 18's seam): the list both filters and orders. A profile that names
``[read_file, search_mathlib]`` yields a read-only child — it literally cannot call a
write tool. ``spawn_subagent`` is opt-in, so a profile can never re-grant it.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml

from .errors import ToolError

# Role files live beside this module, in lea/agents/. Kept inside the package so
# they ship with it (the audited prompts we copy in per the proposal's note).
_AGENTS_DIR = Path(__file__).parent / "agents"

# The keys a profile file may set. An unknown key is a typo we refuse loudly rather
# than silently ignore (a dropped `tools:` would hand a child the full toolset).
_ALLOWED_KEYS = {"name", "description", "model", "tools", "max_turns", "system_prompt"}


@dataclass(frozen=True)
class AgentProfile:
    """A parsed role. ``system_prompt`` is the role head appended to the Lean core;
    ``model``/``tools``/``max_turns`` are ``None`` when the file omits them, meaning
    'inherit the parent's'."""

    name: str
    system_prompt: str
    description: str | None = None
    model: str | None = None
    tools: list[str] | None = None
    max_turns: int | None = None


def _profile_path(name: str) -> Path:
    return _AGENTS_DIR / f"{name}.yaml"


def available_profiles() -> list[str]:
    """Every role name discoverable in ``lea/agents/`` (sorted). Used for a helpful
    error when a caller asks for an unknown role."""
    if not _AGENTS_DIR.is_dir():
        return []
    return sorted(p.stem for p in _AGENTS_DIR.glob("*.yaml"))


def parse_profile(name: str, raw: dict) -> AgentProfile:
    """Validate a loaded YAML dict into an :class:`AgentProfile`. Separated from disk
    IO so it is unit-testable without a file. Raises :class:`ToolError` on any shape
    problem — a malformed role must fail loudly, never yield a mis-scoped child."""
    if not isinstance(raw, dict):
        raise ToolError(f"agent profile {name!r} must be a YAML mapping, got {type(raw).__name__}")

    unknown = set(raw) - _ALLOWED_KEYS
    if unknown:
        raise ToolError(
            f"agent profile {name!r} has unknown key(s) {sorted(unknown)}; "
            f"allowed: {sorted(_ALLOWED_KEYS)}"
        )

    system_prompt = raw.get("system_prompt")
    if not isinstance(system_prompt, str) or not system_prompt.strip():
        raise ToolError(f"agent profile {name!r} must set a non-empty 'system_prompt'")

    tools = raw.get("tools")
    if tools is not None:
        if not isinstance(tools, list) or not all(isinstance(t, str) for t in tools):
            raise ToolError(f"agent profile {name!r}: 'tools' must be a list of tool names")

    max_turns = raw.get("max_turns")
    if max_turns is not None and (not isinstance(max_turns, int) or max_turns < 1):
        raise ToolError(f"agent profile {name!r}: 'max_turns' must be a positive integer")

    model = raw.get("model")
    if model is not None and not isinstance(model, str):
        raise ToolError(f"agent profile {name!r}: 'model' must be a string")

    # A `name:` inside the file is optional; the filename is the source of truth. If
    # present it must agree, so a renamed file can't silently keep an old identity.
    declared = raw.get("name")
    if declared is not None and declared != name:
        raise ToolError(
            f"agent profile {name!r}: file 'name' is {declared!r}; it must match the filename"
        )

    return AgentProfile(
        name=name,
        system_prompt=system_prompt.strip(),
        description=raw.get("description"),
        model=model,
        tools=tools,
        max_turns=max_turns,
    )


def load_profile(name: str) -> AgentProfile:
    """Load and validate the role named ``name`` from ``lea/agents/<name>.yaml``.

    Raises :class:`ToolError` if the role is unknown or the file is malformed — the
    caller (``spawn_subagent``) turns that into a tool-result error, never a crash.
    """
    path = _profile_path(name)
    if not path.is_file():
        known = available_profiles()
        hint = f"; known roles: {known}" if known else " (no roles defined yet)"
        raise ToolError(f"unknown subagent role {name!r}{hint}")
    try:
        raw = yaml.safe_load(path.read_text())
    except yaml.YAMLError as exc:
        raise ToolError(f"agent profile {name!r} is not valid YAML: {exc}") from exc
    return parse_profile(name, raw)
