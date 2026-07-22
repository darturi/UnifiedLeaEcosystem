"""Per-role sub-agent overrides (D6) — the user's edits from the Sub-agents page.

The built-in roles (`proof-candidate`, `premise-search`) ship as vendored YAML in the
prover (`lea/agents/*.yaml`). This module stores the user's PER-ROLE overrides
SEPARATELY — a JSON sidecar in the config dir — so a role can be retuned (model,
max_turns, max_cost, system_prompt, tools) WITHOUT mutating the vendored profile. The
adapter threads the loaded dict onto the run's `LeaConfig.subagent_overrides`, and the
prover's `_child_config` merges the matching entry over the profile at spawn.

Only fields that DIFFER from the role's default are stored, so a vendored default the
user didn't touch keeps flowing through; an empty override means "reset to defaults".
"""
from __future__ import annotations

import json
from typing import Any

from .config import ROOT

_OVERRIDES_PATH = ROOT / "config" / "subagent-overrides.json"
_ALLOWED_FIELDS = ("model", "max_turns", "max_cost", "system_prompt", "tools")


def load_overrides() -> dict[str, dict]:
    """All stored overrides: {role_name: {field: value}}. Missing/corrupt file → {}."""
    try:
        data = json.loads(_OVERRIDES_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {k: v for k, v in data.items() if isinstance(v, dict)}


def get_override(name: str) -> dict:
    return load_overrides().get(name) or {}


def sanitize(override: dict | None) -> dict:
    """Keep only well-typed, non-empty override fields — a malformed value is dropped,
    never persisted (a bad override must fail safe, not mis-tune a child)."""
    out: dict[str, Any] = {}
    for k in _ALLOWED_FIELDS:
        v = (override or {}).get(k)
        if v is None:
            continue
        if k in ("model", "system_prompt") and isinstance(v, str) and v.strip():
            out[k] = v.strip()
        elif k == "max_turns" and isinstance(v, bool) is False and isinstance(v, int) and v >= 1:
            out[k] = v
        elif k == "max_cost" and isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0:
            out[k] = float(v)
        elif k == "tools" and isinstance(v, list) and all(isinstance(t, str) for t in v):
            out[k] = v
    return out


def save_override(name: str, override: dict) -> dict:
    """Persist `override` (already reduced to the diff-from-default) for role `name`.
    An empty override REMOVES the entry (reset to defaults). Returns what was stored."""
    clean = sanitize(override)
    everything = load_overrides()
    if clean:
        everything[name] = clean
    else:
        everything.pop(name, None)
    _OVERRIDES_PATH.parent.mkdir(parents=True, exist_ok=True)
    _OVERRIDES_PATH.write_text(json.dumps(everything, indent=2))
    return clean
