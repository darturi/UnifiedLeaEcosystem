from __future__ import annotations

import tomllib
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class LeaConfig:
    model: str
    max_turns: int | None
    lea_api_base_url: str
    lea_api_key: str | None = None
    lea_root: Path | None = None
    lea_job_timeout_seconds: int = 900
    google_api_key: str | None = None
    anthropic_api_key: str | None = None
    openai_api_key: str | None = None
    openai_base_url: str | None = None
    narrate_tool_steps: bool = False


def load_config(path: Path | None = None) -> LeaConfig:
    config_path = path or ROOT / "config" / "lea.local.toml"
    data: dict = {}
    if config_path.exists():
        data = tomllib.loads(config_path.read_text())

    lea_root = data.get("lea_root", "external/lea-prover")
    resolved_lea_root = None
    if lea_root:
        resolved_lea_root = Path(lea_root)
        if not resolved_lea_root.is_absolute():
            resolved_lea_root = ROOT / resolved_lea_root

    max_turns = data.get("max_turns")
    timeout = data.get("lea_job_timeout_seconds", 900)
    narrate_tool_steps = data.get("narrate_tool_steps", False)
    if not isinstance(narrate_tool_steps, bool):
        raise ValueError("narrate_tool_steps must be a boolean")

    return LeaConfig(
        model=data.get("model", "gemini/gemini-3.1-pro-preview"),
        max_turns=int(max_turns) if max_turns is not None else None,
        lea_api_base_url=_normalize_base_url(data.get("lea_api_base_url", "http://127.0.0.1:8000")),
        lea_api_key=data.get("lea_api_key"),
        lea_root=resolved_lea_root,
        lea_job_timeout_seconds=int(timeout),
        google_api_key=data.get("google_api_key"),
        anthropic_api_key=data.get("anthropic_api_key"),
        openai_api_key=data.get("openai_api_key"),
        openai_base_url=data.get("openai_base_url"),
        narrate_tool_steps=narrate_tool_steps,
    )


def _normalize_base_url(value: str) -> str:
    parsed = urlparse(str(value).strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("lea_api_base_url must be an absolute http(s) URL")
    return str(value).strip().rstrip("/")
