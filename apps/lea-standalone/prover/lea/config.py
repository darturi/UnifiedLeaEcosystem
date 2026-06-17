"""The one config object the agent loop reads — `LeaConfig`.

This is the *single* config dataclass for the whole system (LeaUI architecture
D1·cfg). The prover is a pure in-process library: `run_events(config, …)` is
typed to this class, and the **adapter** owns the loader (`adapter/app/config.py`
reads `config/lea.local.toml` and builds one of these) plus the config file.
There is no second adapter-side config and no mapper between them — one class,
one loader, one file.

The prover must never import the adapter (it stays independently importable), so
the dataclass lives here, in the lower layer. The agent-internal fields carry
sensible defaults so the UI can omit them; the two deployment fields at the
bottom (`lea_root`, `max_spend_usd`) are read by the adapter and ignored by the
loop. Provider API keys are deliberately **not** here — the adapter exports them
to `os.environ` (litellm reads them there), so this object holds no secrets and
is safe to log or serialize.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class LeaConfig:
    """Everything the core loop needs, plus two adapter-read deployment fields."""

    # --- required: the only two values a caller must supply ---
    model: str                  # LiteLLM "provider/model", e.g. "gemini/gemini-3.1-pro-preview"
    max_turns: int | None       # None → run until the proof is done

    # --- agent loop knobs (defaulted; the UI omits them) ---
    narrate_tool_steps: bool = False  # True → ask the model to summarize intent before tool calls
    prompt_variant: str = "interactive"  # the chat variant (formalization vs assistant routing)
    model_kwargs: dict = field(default_factory=dict)  # passthrough to litellm.completion
    stream: bool = True         # True → stream tokens live; False → one blocking call
    tools: list[str] | None = None  # tool allowlist (order = call order); None → all registered
    tool_modules: list[str] = field(default_factory=list)  # modules to import so custom tools register
    skills: list[str] = field(default_factory=list)  # skill markdown injected into the system prompt
    mcp_servers: dict = field(default_factory=dict)  # name → server spec (stdio or remote)

    # --- deployment / UI (the adapter reads these; the loop ignores them) ---
    lea_root: Path | None = None      # where proof files + per-session git repos live
    max_spend_usd: float | None = None  # UI billing guard checked by the adapter
