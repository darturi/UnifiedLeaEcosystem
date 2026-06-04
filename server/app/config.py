from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class LeaConfig:
    provider: str | None
    model: str
    max_turns: int | None
    lea_root: Path
    google_api_key: str | None = None
    anthropic_api_key: str | None = None
    openai_api_key: str | None = None
    openai_base_url: str | None = None


def load_config(path: Path | None = None) -> LeaConfig:
    config_path = path or ROOT / "config" / "lea.local.toml"
    data: dict = {}
    if config_path.exists():
        data = tomllib.loads(config_path.read_text())

    lea_root = Path(data.get("lea_root", "external/lea-prover"))
    if not lea_root.is_absolute():
        lea_root = ROOT / lea_root

    max_turns = data.get("max_turns")
    return LeaConfig(
        provider=data.get("provider"),
        model=data.get("model", "gemini-3.1-pro-preview"),
        max_turns=int(max_turns) if max_turns is not None else None,
        lea_root=lea_root,
        google_api_key=data.get("google_api_key"),
        anthropic_api_key=data.get("anthropic_api_key"),
        openai_api_key=data.get("openai_api_key"),
        openai_base_url=data.get("openai_base_url"),
    )


def apply_provider_env(config: LeaConfig) -> None:
    mappings = {
        "GOOGLE_API_KEY": config.google_api_key,
        "ANTHROPIC_API_KEY": config.anthropic_api_key,
        "OPENAI_API_KEY": config.openai_api_key,
        "OPENAI_BASE_URL": config.openai_base_url,
    }
    for key, value in mappings.items():
        if value:
            os.environ[key] = value

