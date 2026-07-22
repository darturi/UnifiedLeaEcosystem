"""Sub-agents endpoints (D6): view/edit every built-in role's settings.

Read the vendored role profiles from the prover (`lea.profiles`) and merge the user's
stored per-role overrides over them. A role is never mutated on disk — edits persist as
overrides (see `app.subagent_overrides`), merged at spawn by the prover's `_child_config`.
"""
import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from lea import profiles as lea_profiles

from .. import subagent_overrides

router = APIRouter()
logger = logging.getLogger("lea-interface.subagents")


class OverrideRequest(BaseModel):
    model: str | None = None
    max_turns: int | None = None
    max_cost: float | None = None
    system_prompt: str | None = None
    tools: list[str] | None = None


def _defaults(prof) -> dict:
    # max_cost is net-new (no YAML field), so its default is always None (uncapped).
    return {
        "model": prof.model,            # None → inherit the coordinator's model
        "max_turns": prof.max_turns,
        "max_cost": None,
        "system_prompt": prof.system_prompt,
        "tools": list(prof.tools or []),
    }


def _profile_payload(name: str) -> dict:
    prof = lea_profiles.load_profile(name)
    default = _defaults(prof)
    override = subagent_overrides.get_override(name)
    effective = {**default, **override}
    return {
        "name": prof.name,
        "description": prof.description,
        "default": default,
        "override": override,
        "effective": effective,
    }


@router.get("/api/sub-agents/profiles")
def list_profiles() -> dict:
    """Every built-in role with its default settings, the stored override, and the
    effective (merged) settings the frontend renders + edits."""
    return {"profiles": [_profile_payload(n) for n in lea_profiles.available_profiles()]}


@router.put("/api/sub-agents/profiles/{name}")
def update_profile(name: str, request: OverrideRequest) -> dict:
    """Save a role's override. The body carries the *effective* settings the user edited;
    we store only the fields that DIFFER from the role's default (so untouched vendored
    defaults keep flowing through, and a reset-to-default clears the override)."""
    try:
        prof = lea_profiles.load_profile(name)
    except Exception:
        raise HTTPException(status_code=404, detail=f"Unknown sub-agent role {name!r}")
    default = _defaults(prof)
    incoming = subagent_overrides.sanitize(request.dict())
    override = {k: v for k, v in incoming.items() if v != default.get(k)}
    subagent_overrides.save_override(name, override)
    return _profile_payload(name)
