"""The adapter's config loader — reads `config/lea.local.toml` into the *one*
`LeaConfig` (architecture D1·cfg).

There is a single config dataclass for the whole system, and it lives in the
prover (`lea.config.LeaConfig`) because `run_events(config, …)` is typed to it
and the prover must stay an independently-importable library. This module is the
single loader: it parses the TOML the Settings UI edits and builds one of those
objects. We re-export `LeaConfig` so existing `from .config import LeaConfig`
imports keep working.

Provider API keys are **not** stored on the config object — `load_config()`
exports them into `os.environ` (litellm reads them there), so the returned config
holds no secrets and is safe to log or serialize. Previously `scripts/dev.mjs`
injected these into the bundled prover *subprocess*; now the prover runs
in-process, so the adapter's own environment is where they belong.
"""

from __future__ import annotations

import os
import re
import tomllib
from pathlib import Path

from lea.config import LeaConfig  # the one config dataclass (re-exported below)

__all__ = ["LeaConfig", "load_config", "configured_provider_keys", "ROOT", "LEGACY_KEY_ENV"]

ROOT = Path(__file__).resolve().parents[2]

# Legacy flat TOML key -> the LiteLLM env var it maps to. Kept for back-compat;
# any other provider key is stored under its uppercase env var name directly.
LEGACY_KEY_ENV = {
    "google_api_key": "GOOGLE_API_KEY",
    "anthropic_api_key": "ANTHROPIC_API_KEY",
    "openai_api_key": "OPENAI_API_KEY",
}
_ENV_KEY_RE = re.compile(r"[A-Z][A-Z0-9_]*_API_KEY")


def _provider_keys(data: dict) -> dict[str, str]:
    """Collect provider API keys from the TOML, keyed by LiteLLM env-var name.

    Legacy flat keys (`google_api_key`, …) first, then any uppercase
    `*_API_KEY` root entries (additional providers).
    """
    api_keys: dict[str, str] = {}
    for flat_key, env_name in LEGACY_KEY_ENV.items():
        if data.get(flat_key):
            api_keys[env_name] = str(data[flat_key])
    for key, value in data.items():
        if isinstance(key, str) and _ENV_KEY_RE.fullmatch(key) and value:
            api_keys[key] = str(value)
    return api_keys


def configured_provider_keys(path: Path | None = None) -> dict[str, str]:
    """The provider API keys present in the config file, env-var-keyed.

    Read-only — does **not** export to `os.environ`. The Settings UI uses this to
    show which keys are set (and validate the selected model has one) without
    going through `load_config`. Key-parsing lives only here, so the loader and
    the Settings layer can never disagree about what counts as a configured key.
    """
    config_path = path or ROOT / "config" / "lea.local.toml"
    data: dict = tomllib.loads(config_path.read_text()) if config_path.exists() else {}
    return _provider_keys(data)


def load_config(path: Path | None = None) -> LeaConfig:
    """Parse `lea.local.toml` into the one `LeaConfig`, exporting keys to env.

    Only the UI-facing knobs come from the file (`model`, `max_turns`,
    `narrate_tool_steps`, `lea_root`, `max_spend_usd`); the agent-internal fields
    (`prompt_variant`, `stream`, `tools`, …) keep their `LeaConfig` defaults.
    Provider keys are exported to `os.environ`, never stored on the object.
    """
    config_path = path or ROOT / "config" / "lea.local.toml"
    data: dict = {}
    if config_path.exists():
        data = tomllib.loads(config_path.read_text())

    lea_root = data.get("lea_root", "prover")
    resolved_lea_root: Path | None = None
    if lea_root:
        resolved_lea_root = Path(lea_root)
        if not resolved_lea_root.is_absolute():
            resolved_lea_root = ROOT / resolved_lea_root

    max_turns = data.get("max_turns")

    narrate_tool_steps = data.get("narrate_tool_steps", False)
    if not isinstance(narrate_tool_steps, bool):
        raise ValueError("narrate_tool_steps must be a boolean")

    max_spend_usd = data.get("max_spend_usd")
    if max_spend_usd is not None:
        max_spend_usd = float(max_spend_usd)
        if max_spend_usd < 0:
            raise ValueError("max_spend_usd must be greater than or equal to 0")

    # Secrets go to the process environment (litellm reads them there), not onto
    # the config object — so the config is loggable and the prover, running
    # in-process, sees the keys the same way the old subprocess did.
    for env_name, value in _provider_keys(data).items():
        os.environ[env_name] = value

    return LeaConfig(
        model=data.get("model", "gemini/gemini-3.1-pro-preview"),
        max_turns=int(max_turns) if max_turns is not None else None,
        narrate_tool_steps=narrate_tool_steps,
        lea_root=resolved_lea_root,
        max_spend_usd=max_spend_usd,
    )
