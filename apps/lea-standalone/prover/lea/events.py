"""The agent event contract — the event-out half of config-in / event-out.

`run_events()` (in agent.py) yields these immutable events instead of printing.
Three consumers share this one contract: the CLI renderer (render.py) reproduces
today's stdout from them, a UI can render them live, and eval can collect them.
"""

from dataclasses import dataclass

from .providers import Usage


@dataclass(frozen=True)
class TurnStarted:
    """Start of a loop iteration (1-based)."""
    turn: int


@dataclass(frozen=True)
class AssistantTextDelta:
    """A streaming chunk of assistant text (deltas, not the whole message)."""
    text: str


@dataclass(frozen=True)
class ToolCalled:
    """The model asked to run a tool."""
    name: str
    args: dict


@dataclass(frozen=True)
class ToolResulted:
    """A tool finished. `content` is the full result; `preview` is the truncation shown to the user."""
    name: str
    content: str
    preview: str


@dataclass(frozen=True)
class ToolApprovalRequested:
    """Two-way control event (D19): the agent is about to run an *impactful* tool
    (bash / write_file / edit_file) and pauses for the human. The adapter answers by
    `gen.send(...)` with 'allow' | 'always_session' | 'deny' (anything not in the
    first two is treated as deny — safe default). Read-only tools + lean_check are
    auto-allowed and never reach here; whether a tool is gated is the adapter's
    policy (run_events just asks via the `gate` hook)."""
    tool_name: str
    args: dict


@dataclass(frozen=True)
class FileChanged:
    """A proof file changed on disk. Meaning-level (D17): the adapter reacts to this
    directly — commit to git + insert a code_step — without decoding which tool ran.
    Carries `path` only (relative to the session dir); the bytes are read from disk /
    `git show` (filesystem-canonical, D3/D8), never shipped in the event."""
    path: str


@dataclass(frozen=True)
class CheckResult:
    """An `lean_check` verdict on one file. `status` is 'ok' or 'error'; `detail` is the
    first error line when status == 'error', else None. ('unchecked' is a DB state, not
    an event — a step nobody checked — so it never appears here.)"""
    path: str
    status: str
    detail: str | None = None


@dataclass(frozen=True)
class VerifyResult:
    """A SafeVerify verdict. `status` is one of:
      'ok'          — passed the kernel-replay audit
      'rejected'    — a cheat was caught (sorry/axiom/shadowing/…)
      'error'       — verification could not run (e.g. no theorem found, compile failed)
      'unavailable' — the SafeVerify binary is not built on this server
    'error'/'unavailable' are kept distinct from 'rejected' on purpose: "couldn't
    verify" must never be read as "verified bad." `detail` carries the reason
    (None on a clean 'ok')."""
    status: str
    detail: str | None = None


@dataclass(frozen=True)
class Error:
    """A run-level failure — the activation could not continue."""
    message: str


@dataclass(frozen=True)
class UsageUpdated:
    """Token usage + cost for a single turn's model response (a per-turn delta)."""
    input_tokens: int
    output_tokens: int
    cost: float


@dataclass(frozen=True)
class Finished:
    """Terminal event. `reason` is "completed" or "max_turns"."""
    reason: str
    text: str
    turns: int
    session_id: str
    model: str
    usage: Usage
    cost: float
    transcript: dict


# Union of everything run_events() can yield — handy for type annotations.
AgentEvent = (
    TurnStarted
    | AssistantTextDelta
    | ToolCalled
    | ToolResulted
    | ToolApprovalRequested
    | FileChanged
    | CheckResult
    | VerifyResult
    | Error
    | UsageUpdated
    | Finished
)
