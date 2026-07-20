"""Lea agent — the core loop. Model calls tools until done.

`run_events()` is the generator core: it yields a typed event stream and never
prints. `run()` is a backward-compatible wrapper that drains those events through
the default stdout renderer and returns the final text (and optional transcript),
so existing callers (CLI, eval) keep working unchanged.
"""

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .config import LeaConfig
from .runctx import run_context
from .prompt import compose_role_prompt, domain_cascade_hint, load_system_prompt
from .providers import stream, TextDelta, ToolCall, Done, _ToolMeta, Usage
from . import safeverify
from . import subagents  # subagent-result collector (item 22); also registers spawn_subagent via tools
from . import tools as _tools  # noqa: F401 — importing registers the built-in tools
from .tools import _lean_check_has_error, _lean_check_has_sorry, _first_error_line, _tool_result_ok
from .registry import build_toolset, import_tool_modules, pop_scope, push_scope
from .events import (
    TurnStarted,
    AssistantTextDelta,
    ToolCalled,
    ToolResulted,
    ToolApprovalRequested,
    FileChanged,
    CheckResult,
    UsageUpdated,
    Finished,
)


_NARRATE_TOOL_STEPS_INSTRUCTION = """

When you are about to call one or more tools, first write a concise progress
summary for the user. Keep it to one or two sentences, use Markdown when helpful,
and include mathematical notation in normal LaTeX delimiters when useful. Explain
what you are trying next and why, then call the tool. Do not narrate after every
minor token or repeat boilerplate; summarize the meaningful proof step.
"""


_FORCED_TOOL_NARRATION_INSTRUCTION = """

You are Lea explaining the next proof action to the user. The main model turn
selected a tool call without first writing user-facing narration. Write the
missing narration now.

Rules:
- Write one concise paragraph unless the mathematical plan genuinely benefits
  from a short numbered list.
- Explain the mathematical or Lean proof move being attempted and why it is the
  next useful step.
- Use Markdown and ordinary LaTeX delimiters when helpful.
- Do not mention JSON, API internals, or hidden/private reasoning.
- Do not call tools. Return only the narration text.
"""


_INTENT_CLASSIFIER_PROMPT = """\
You route the user's latest message in an interactive Lean 4 session that already \
contains prior work (often a completed proof).

Reply with exactly one word:
- FORMALIZE — the user is giving you a NEW mathematical statement to formalize and \
prove, is otherwise asking you to prove/formalize something, OR is approving/confirming a \
formalization you just proposed (e.g. "go ahead", "yes, prove it", "sounds good", "that's \
right") so you should now carry out the proof.
- ASSISTANT — the user is asking a question, requesting an explanation, asking you to \
look up a lemma in Mathlib, clarifying a tactic, or otherwise continuing the \
conversation about existing work.

Output only the single word FORMALIZE or ASSISTANT, with no other text."""


_RESULT_CLASSIFIER_PROMPT = """\
You classify the mathematical outcome of a verified Lean artifact for Lea.

The Lean artifact has already passed the final checker. Your job is only to decide
what it verified relative to the user's original request.

Reply with exactly one word:
- PROVED — the artifact proves the user's stated theorem/lemma/conjecture as written.
- DISPROVED — the artifact proves a negation, contradiction, or counterexample showing
  the user's stated theorem/lemma/conjecture is false.
- NEEDS_REVIEW — the relationship is ambiguous, the artifact proves a related but
  different statement, or you are not certain.

Be conservative. If the user asked for a counterexample and the artifact verifies
one, reply DISPROVED. If the user asked for a proof but the artifact verifies the
negation or a counterexample, reply DISPROVED. If unsure, reply NEEDS_REVIEW.

Output only PROVED, DISPROVED, or NEEDS_REVIEW."""


def _text_only_history(messages: list, limit: int = 8) -> list[dict]:
    """Flatten messages to a cheap text-only {role, content} list for classification.

    Drops tool calls/results and assistant tool-call parts so the classifier sees a
    clean conversation; keeps only the trailing `limit` text turns.
    """
    out: list[dict] = []
    for msg in messages:
        role = msg.get("role")
        content = msg.get("content")
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            text = " ".join(
                part.get("text", "")
                for part in content
                if isinstance(part, dict) and part.get("type") == "text"
            )
        else:
            text = ""
        text = text.strip()
        if not text:
            continue
        if role == "assistant":
            # Assistant turns must use the parts format: _to_openai_messages treats a
            # bare string as a user-only shape and iterates assistant content as a list.
            out.append({"role": "assistant", "content": [{"type": "text", "text": text}]})
        else:
            out.append({"role": "user", "content": text})
    return out[-limit:]


def _classify_intent(model: str, messages: list, config: LeaConfig) -> tuple[str, Usage, float]:
    """Ask the model whether the latest turn is FORMALIZE or ASSISTANT.

    Returns (decision, usage, cost). Defaults to FORMALIZE on any ambiguity so a
    genuine theorem to prove is never silently dropped into chat mode.
    """
    history = _text_only_history(messages)
    text = ""
    usage = Usage()
    cost = 0.0
    for event in stream(
        model,
        _INTENT_CLASSIFIER_PROMPT,
        history,
        [],
        config.model_kwargs,
        streaming=config.stream,
    ):
        if isinstance(event, TextDelta):
            text += event.text
        elif isinstance(event, Done):
            usage.input_tokens += event.usage.input_tokens
            usage.output_tokens += event.usage.output_tokens
            cost += event.cost
    decision = "ASSISTANT" if "ASSISTANT" in text.strip().upper() else "FORMALIZE"
    return decision, usage, cost


def _content_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text":
                parts.append(str(part.get("text") or ""))
            elif part.get("type") == "tool_result":
                continue
        return " ".join(p for p in parts if p)
    return ""


def _latest_user_request(messages: list) -> str:
    for msg in reversed(messages):
        if msg.get("role") != "user":
            continue
        text = _content_text(msg.get("content")).strip()
        if text:
            return text
    return ""


def _theorem_signature(path: str | None) -> str:
    if not path:
        return ""
    try:
        return safeverify.theorem_signature(Path(path).read_text()) or ""
    except Exception:
        return ""


def _parse_result_kind(text: str) -> str:
    value = (text or "").strip().upper()
    if "DISPROVED" in value:
        return "disproved"
    if "PROVED" in value:
        return "proved"
    if "NEEDS_REVIEW" in value or "NEEDS REVIEW" in value:
        return "needs_review"
    return "needs_review"


def _classify_final_result(
    *,
    model: str,
    messages: list,
    final_text: str,
    theorem_signature: str,
    config: LeaConfig,
) -> tuple[str, str | None, Usage, float]:
    """Classify a checked artifact relative to the user's request.

    This is intentionally conservative: parse failures, provider errors, or any
    non-conforming answer become needs_review, not proof success.
    """
    request = _latest_user_request(messages)
    classifier_messages = [{
        "role": "user",
        "content": (
            "User request:\n"
            f"{request or '(unavailable)'}\n\n"
            "Verified Lean theorem signature:\n"
            f"{theorem_signature or '(unavailable)'}\n\n"
            "Final assistant message:\n"
            f"{final_text or '(unavailable)'}"
        ),
    }]
    text = ""
    usage = Usage()
    cost = 0.0
    try:
        for event in stream(
            model,
            _RESULT_CLASSIFIER_PROMPT,
            classifier_messages,
            [],
            config.model_kwargs,
            streaming=config.stream,
        ):
            if isinstance(event, TextDelta):
                text += event.text
            elif isinstance(event, Done):
                usage.input_tokens += event.usage.input_tokens
                usage.output_tokens += event.usage.output_tokens
                cost += event.cost
    except Exception as exc:
        return "needs_review", f"Result classification failed: {type(exc).__name__}: {exc}", usage, cost
    kind = _parse_result_kind(text)
    detail = text.strip() or None
    return kind, detail, usage, cost


def _domain_cascade_for_check(args: dict, working_dir: str | None, surfaced: set[str]) -> str | None:
    """The domain-scoped tactic hint (item 26) for the file a `lean_check` targeted, or None.

    Reads the checked file's text — resolving a relative path against this activation's
    `working_dir` first (two concurrent runs don't share a per-run cwd), then as given — and
    asks `domain_cascade_hint` for the fragments whose domain is present and not yet surfaced.
    Best-effort: any read failure yields None (a missing hint never breaks a check)."""
    path = args.get("path")
    if not isinstance(path, str) or not path:
        return None
    p = Path(path).expanduser()
    candidates = [p] if p.is_absolute() else (
        [Path(working_dir).expanduser() / p, p] if working_dir else [p]
    )
    for cand in candidates:
        try:
            text = cand.read_text()
        except OSError:
            continue
        return domain_cascade_hint(text, surfaced)
    return None


def _meaning_events(tool_name: str, args: dict, result: str) -> list:
    """Map one finished tool call to the meaning-level events the adapter acts on
    (D17). Reuses the same classification as ProofVerificationState.note_tool_result
    so the event stream and the agent's proof-state can never disagree.

    Scope (A2): FileChanged (on .lean writes) + CheckResult (on lean_check).
    VerifyResult arrives with the verify capability (A6); Error with the bridge.
    """
    path = args.get("path")
    if not isinstance(path, str) or not path:
        return []
    if tool_name in {"write_file", "edit_file"}:
        if path.endswith(".lean") and _tool_result_ok(result):
            return [FileChanged(path)]
        return []
    if tool_name == "lean_check":
        err = _lean_check_has_error(result)
        return [CheckResult(path, "error" if err else "ok",
                            _first_error_line(result) if err else None)]
    return []


class ProofVerificationState:
    """Track whether the latest Lean proof file has passed a fresh check."""

    def __init__(self):
        self.latest_proof_path: str | None = None
        self.unchecked_write = False
        self.latest_check_path: str | None = None
        self.latest_check_output: str | None = None
        self.latest_check_passed: bool | None = None

    def note_tool_result(self, tool_name: str, args: dict, result: str) -> None:
        path = args.get("path")
        if not isinstance(path, str) or not path:
            return
        if tool_name in {"write_file", "edit_file"}:
            if _tool_result_ok(result) and path.endswith(".lean"):
                self.latest_proof_path = path
                self.unchecked_write = True
            return
        if tool_name == "lean_check":
            # A proof is only verified if it compiles with no errors AND no `sorry`
            # — `sorry` is a warning, so checking errors alone would accept a
            # skeleton as a finished proof (a false "Proved").
            passed = not _lean_check_has_error(result) and not _lean_check_has_sorry(result)
            self.latest_check_path = path
            self.latest_check_output = result
            self.latest_check_passed = passed
            if path == self.latest_proof_path:
                self.unchecked_write = False

    def needs_final_check(self) -> bool:
        if not self.latest_proof_path:
            return False
        return (
            self.unchecked_write
            or self.latest_check_path != self.latest_proof_path
        )

    def latest_proof_verified(self) -> bool:
        return (
            bool(self.latest_proof_path)
            and not self.unchecked_write
            and self.latest_check_path == self.latest_proof_path
            and self.latest_check_passed is True
        )


_FINAL_GATE_FAILURE_MESSAGE = (
    "Error: final verification gate failed. Lea claimed the proof was complete, "
    "but the latest proof file did not pass lean_check."
)

_NO_PROOF_ARTIFACT_MESSAGE = (
    "Error: no proof artifact was produced. You must create a complete .lean file "
    "with the write_file tool, then run lean_check on that file. Do not finish with "
    "only prose or a Markdown code block."
)


def _tool_call_for_prompt(name: str, args: dict) -> dict:
    """Compact a tool call enough to show a narration-only model pass."""
    compact: dict = {}
    for key, value in args.items():
        if isinstance(value, str):
            if key == "content" and len(value) > 1600:
                compact[key] = value[:1600] + "\n... [truncated]"
            elif len(value) > 800:
                compact[key] = value[:800] + "... [truncated]"
            else:
                compact[key] = value
        else:
            compact[key] = value
    return {"name": name, "args": compact}


def _forced_tool_narration(
    *,
    model: str,
    system: str,
    messages: list,
    tool_name: str,
    tool_args: dict,
    config: LeaConfig,
):
    """Ask the model for narration when a tool-only turn would otherwise be silent."""
    narration_messages = messages + [{
        "role": "user",
        "content": (
            "Write the user-facing narration that should appear immediately "
            "before this Lea tool call:\n"
            f"{json.dumps(_tool_call_for_prompt(tool_name, tool_args), ensure_ascii=False, indent=2)}"
        ),
    }]
    text = ""
    usage = Usage()
    cost = 0.0
    try:
        for event in stream(
            model,
            system + _FORCED_TOOL_NARRATION_INSTRUCTION,
            narration_messages,
            [],
            config.model_kwargs,
            streaming=config.stream,
        ):
            if isinstance(event, TextDelta):
                text += event.text
                yield event
            elif isinstance(event, Done):
                usage.input_tokens += event.usage.input_tokens
                usage.output_tokens += event.usage.output_tokens
                cost += event.cost
    except Exception:
        fallback = _fallback_tool_narration(tool_name, tool_args)
        text += fallback
        yield TextDelta(fallback)
    return text.strip(), usage, cost


def _fallback_tool_narration(tool_name: str, args: dict) -> str:
    path = args.get("path")
    if tool_name == "write_file":
        if isinstance(path, str) and path:
            return f"I will write the next Lean proof attempt in `{path}` and then check whether it compiles."
        return "I will write the next Lean proof attempt and then check whether it compiles."
    if tool_name == "edit_file":
        if isinstance(path, str) and path:
            return f"I will revise `{path}` to address the previous Lean feedback, then re-run the checker."
        return "I will revise the Lean proof to address the previous checker feedback, then re-run it."
    if tool_name == "lean_check":
        if isinstance(path, str) and path:
            return f"I will run Lean on `{path}` to verify the current proof and inspect any errors."
        return "I will run Lean to verify the current proof and inspect any errors."
    if tool_name == "search_mathlib":
        query = args.get("query")
        if isinstance(query, str) and query:
            return f"I will search Mathlib for lemmas related to `{query}` so the next proof step can use existing results."
        return "I will search Mathlib for a relevant lemma before continuing the proof."
    return f"I will use `{tool_name}` for the next proof step and then use its result to continue."


def run_events(
    config: LeaConfig,
    messages: list,
    *,
    namespace: str | None = None,
    session_id: str | None = None,
    working_dir: str | None = None,
    should_stop=None,
    gate=None,
    depth: int = 0,
):
    """Core loop as a generator: yields typed events, never prints.

    **Stateless (D16):** one activation = one pure call. The caller passes the full
    conversation `messages` (the transcript it owns in the DB), and the prover holds
    nothing between activations — no disk persistence, no resume-from-disk. The
    final messages ride back out in the `Finished` event's transcript.

    Yields per turn: TurnStarted, AssistantTextDelta*, ToolCalled*, UsageUpdated,
    ToolResulted* (+ meaning-level FileChanged/CheckResult), and finally Finished.

    **Per-tool gate (D19):** `gate` is an optional callable `(tool_name, args) -> bool`
    supplied by the adapter; True means "this tool needs human approval." Before
    running such a tool the loop yields a two-way `ToolApprovalRequested`; the caller
    answers with `gen.send('allow' | 'always_session' | 'deny')`. The gated set + the
    session allowlist are the adapter's policy (it owns `always_session`); run_events
    only asks and honors the answer. `gate=None` → no gating.

    **Interrupt (D18):** `should_stop` is an optional `() -> bool` the caller flips to
    request a stop. It's checked at each turn boundary (one turn = one UI step), so the
    stop is *cooperative and clean* — the current step's write is already committed and
    the canvas is accurate — not a hard kill. On stop the loop yields a terminal
    `Finished("interrupted", ...)` carrying the transcript so far (so a follow-up still
    has a coherent base). An in-flight turn is not interrupted mid-flight; the stop
    lands at the next turn boundary.

    Owns MCP lifecycle: starts configured servers (which register their tools)
    before the inner loop resolves the toolset, and stops them when the event
    stream ends or is closed.
    """
    # Open this activation's tool-registry overlay (item 27) BEFORE starting MCP, so the
    # MCP tools register into *this run's* layer (on the caller thread) rather than the
    # process-global registry — two concurrent MCP-enabled runs then can't corrupt each
    # other's toolsets. Popped in the finally, dropping the run's dynamic tools with it.
    registry_scope = push_scope()
    mcp_manager = None
    if config.mcp_servers:
        from .mcp import MCPManager
        mcp_manager = MCPManager(config.mcp_servers)
        mcp_manager.start()
    # Establish the per-activation run context (item 8) for the whole event
    # stream: `working_dir` so filesystem tools (bash) act in this run's tree
    # instead of the process-global cwd, and `run_key` (session id) for the
    # lock/scratch keys later items build on. It wraps the `yield from`, so the
    # ContextVars stay set through every tool call delegated to the inner loop.
    run_key = session_id or uuid.uuid4().hex[:12]
    try:
        # `depth` (item 18) records this activation's nesting; `config` is stashed so
        # spawn_subagent can derive a child config. Both ride the ContextVars through
        # every tool call the inner loop delegates.
        with run_context(working_dir=working_dir, run_key=run_key, depth=depth, config=config):
            # A fresh subagent-result collector per activation (item 22): spawn_subagent
            # records here, the inner loop drains into SubagentFinished events. Scoped so
            # results can't leak across runs; a child opens its own empty scope.
            results_token = subagents.begin_results_scope()
            try:
                yield from _run_events_inner(
                    config, messages, namespace=namespace, session_id=session_id,
                    working_dir=working_dir, should_stop=should_stop, gate=gate,
                )
            finally:
                subagents.end_results_scope(results_token)
    finally:
        if mcp_manager is not None:
            mcp_manager.stop()
        pop_scope(registry_scope)


def _run_events_inner(
    config: LeaConfig,
    messages: list,
    *,
    namespace: str | None = None,
    session_id: str | None = None,
    working_dir: str | None = None,
    should_stop=None,
    gate=None,
):
    # `namespace` (e.g. "Lea.Foo") lets the adapter state the active write
    # namespace for a project run (D32); None keeps the default Lea.Misc block.
    system = load_system_prompt(
        config.prompt_variant, config.skills, workspace=working_dir, namespace=namespace,
    )
    if config.narrate_tool_steps:
        system += _NARRATE_TOOL_STEPS_INSTRUCTION
    # A subagent role head (item 19) is composed onto the shared Lean core and
    # BRACKETED by a non-negotiable reassertion of the hard rules (item 20), so a role
    # can specialize but can never override "never modify the statement" / no
    # sorry/axiom — even as the last instruction. No head → core unchanged.
    system = compose_role_prompt(system, config.system_prompt_head)
    model = config.model

    # Resolve the active toolset once: import any user tool modules so their
    # tools register, then select per config (None → all registered tools).
    import_tool_modules(config.tool_modules)
    tools_schema, tool_handlers = build_toolset(config.tools)

    # Stateless (D16): the caller owns the transcript. Work on a private copy so we
    # never mutate the caller's list in place; the final state rides out via the
    # Finished transcript. Per-activation usage starts at zero — the adapter
    # accumulates across activations. The adapter owns session identity; we only
    # generate a label if it didn't pass one (e.g. a standalone/test call).
    messages = list(messages)
    if session_id is None:
        session_id = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    total_usage = Usage()

    total_cost = 0.0
    proof_state = ProofVerificationState()

    def transcript(turns: int) -> dict:
        clean = []
        for msg in messages:
            if msg["role"] == "assistant" and isinstance(msg["content"], list):
                clean.append({"role": "assistant", "content": [
                    {k: v for k, v in item.items() if k != "raw_part"}
                    for item in msg["content"]
                ]})
            else:
                clean.append(msg)
        return {
            "session_id": session_id,
            "model": model,
            "turns": turns,
            "usage": {"input_tokens": total_usage.input_tokens, "output_tokens": total_usage.output_tokens},
            "messages": clean,
        }

    # Interactive chat: classify whether this turn is a new formalization or an
    # assistant/QA request (explain, look up a lemma, etc.), and route. Only fires
    # when the conversation already has a prior assistant turn — a first turn is
    # always a formalization, so the cold-start path is untouched. (Keying off a
    # prior assistant turn, not message count, stays correct even when the caller
    # prepends project context to a fresh run.)
    assistant_mode = False
    if config.prompt_variant == "interactive" and any(m.get("role") == "assistant" for m in messages):
        decision, intent_usage, intent_cost = _classify_intent(model, messages, config)
        total_usage.input_tokens += intent_usage.input_tokens
        total_usage.output_tokens += intent_usage.output_tokens
        total_cost += intent_cost
        if intent_usage.input_tokens or intent_usage.output_tokens or intent_cost:
            yield UsageUpdated(intent_usage.input_tokens, intent_usage.output_tokens, intent_cost)
        assistant_mode = decision == "ASSISTANT"

    # Domains whose tactic cascade has already been surfaced this activation (item 26),
    # so a domain hint rides a lean_check result once, not on every check.
    surfaced_domains: set[str] = set()

    turn = 0
    while True:
        # Cooperative interrupt (D18): the human asked to stop. `turn` is the count
        # of completed turns, so the last step's write is already committed and the
        # canvas is accurate — a clean stop, not a hard kill. The transcript so far
        # rides out so a follow-up still has a coherent base.
        if should_stop is not None and should_stop():
            yield Finished("interrupted", "Run interrupted by the user.",
                           turn, session_id, model, total_usage, total_cost, transcript(turn))
            return

        turn += 1
        if config.max_turns and turn > config.max_turns:
            yield Finished("max_turns", "Error: max turns reached without completing the proof.",
                           turn - 1, session_id, model, total_usage, total_cost, transcript(turn - 1))
            return

        yield TurnStarted(turn)

        assistant_parts = []
        current_text = ""
        tool_calls = []
        forced_narration_emitted = False

        for event in stream(model, system, messages, tools_schema, config.model_kwargs, streaming=config.stream):
            if isinstance(event, TextDelta):
                current_text += event.text
                yield AssistantTextDelta(event.text)
            elif isinstance(event, ToolCall):
                if config.narrate_tool_steps and not forced_narration_emitted and not current_text and not any(
                    part.get("type") == "text" and part.get("text") for part in assistant_parts
                ):
                    narration = _forced_tool_narration(
                        model=model,
                        system=system,
                        messages=messages,
                        tool_name=event.name,
                        tool_args=event.args,
                        config=config,
                    )
                    try:
                        while True:
                            narration_event = next(narration)
                            current_text += narration_event.text
                            yield AssistantTextDelta(narration_event.text)
                    except StopIteration as result:
                        _, narration_usage, narration_cost = result.value
                        total_usage.input_tokens += narration_usage.input_tokens
                        total_usage.output_tokens += narration_usage.output_tokens
                        total_cost += narration_cost
                        if narration_usage.input_tokens or narration_usage.output_tokens or narration_cost:
                            yield UsageUpdated(
                                narration_usage.input_tokens,
                                narration_usage.output_tokens,
                                narration_cost,
                            )
                    forced_narration_emitted = True
                if current_text:
                    assistant_parts.append({"type": "text", "text": current_text})
                    current_text = ""
                yield ToolCalled(event.name, event.args)
                tool_calls.append({"name": event.name, "args": event.args, "id": None, "raw_part": event.raw_part})
            elif isinstance(event, _ToolMeta):
                if tool_calls:
                    tool_calls[-1]["id"] = event.tool_use_id
            elif isinstance(event, Done):
                total_usage.input_tokens += event.usage.input_tokens
                total_usage.output_tokens += event.usage.output_tokens
                total_cost += event.cost
                yield UsageUpdated(event.usage.input_tokens, event.usage.output_tokens, event.cost)

        if current_text:
            assistant_parts.append({"type": "text", "text": current_text})
        for tc in tool_calls:
            assistant_parts.append({
                "type": "tool_call",
                "name": tc["name"],
                "args": tc["args"],
                "id": tc["id"],
                "raw_part": tc.get("raw_part"),
            })
        messages.append({"role": "assistant", "content": assistant_parts})

        if not tool_calls:
            text = "".join(p["text"] for p in assistant_parts if p["type"] == "text")
            if assistant_mode:
                # Chat/assistant turn — not a formalization run, so skip the
                # final proof gate entirely.
                yield Finished("assistant", text or "(no response)", turn, session_id, model,
                               total_usage, total_cost, transcript(turn))
                return
            if not proof_state.latest_proof_path:
                # Interactive collaborator: a text-only turn before any proof file
                # exists means the model is presenting its plan / natural-language
                # sketch and waiting for the user — the prompt tells it to lead with
                # the math and not touch files until the user confirms. Let the run
                # pause here instead of forcing a proof artifact. Non-interactive
                # variants (eval/default) keep the nudge so they never stop short.
                if config.prompt_variant == "interactive":
                    yield Finished("assistant", text or "(no response)", turn, session_id,
                                   model, total_usage, total_cost, transcript(turn))
                    return
                messages.append({"role": "user", "content": _NO_PROOF_ARTIFACT_MESSAGE})
                continue
            if proof_state.needs_final_check():
                check_path = proof_state.latest_proof_path
                assert check_path is not None
                check_args = {"path": check_path}
                yield ToolCalled("lean_check", check_args)
                handler = tool_handlers.get("lean_check")
                if handler:
                    try:
                        result = handler(check_args)
                    except Exception as e:
                        result = f"Error: tool 'lean_check' raised {type(e).__name__}: {e}"
                else:
                    result = "Error: unknown tool 'lean_check'"
                preview = result[:200] + "..." if len(result) > 200 else result
                yield ToolResulted("lean_check", result, preview)
                for ev in _meaning_events("lean_check", check_args, result):
                    yield ev
                proof_state.note_tool_result("lean_check", check_args, result)

                tool_result = {"type": "tool_result", "tool_name": "lean_check", "content": result}
                gate_call_id = f"final_gate_lean_check_{turn}"
                messages.append({"role": "assistant", "content": [{
                    "type": "tool_call",
                    "name": "lean_check",
                    "args": check_args,
                    "id": gate_call_id,
                }]})
                tool_result["tool_use_id"] = gate_call_id
                tool_result["tool_call_id"] = gate_call_id
                messages.append({"role": "user", "content": [tool_result]})
            if proof_state.latest_proof_path and not proof_state.latest_proof_verified():
                if config.prompt_variant == "interactive":
                    # Collaborator: the proof isn't actually done (errors, or still
                    # has a `sorry` — e.g. a skeleton the agent is asking you about).
                    # End cleanly as a chat turn — never a false "Proved" — and let
                    # the user steer the next step instead of barreling ahead.
                    yield Finished("assistant", text or "(no response)", turn, session_id,
                                   model, total_usage, total_cost, transcript(turn))
                    return
                diagnostic = proof_state.latest_check_output or "No successful lean_check was observed."
                messages.append({"role": "user", "content": f"{_FINAL_GATE_FAILURE_MESSAGE}\n\n{diagnostic}"})
                continue

            final_text = text or "(no response)"
            result_kind, result_detail, result_usage, result_cost = _classify_final_result(
                model=model,
                messages=messages,
                final_text=final_text,
                theorem_signature=_theorem_signature(proof_state.latest_proof_path),
                config=config,
            )
            total_usage.input_tokens += result_usage.input_tokens
            total_usage.output_tokens += result_usage.output_tokens
            total_cost += result_cost
            if result_usage.input_tokens or result_usage.output_tokens or result_cost:
                yield UsageUpdated(result_usage.input_tokens, result_usage.output_tokens, result_cost)
            final_transcript = transcript(turn)
            yield Finished("completed", final_text, turn, session_id, model,
                           total_usage, total_cost, final_transcript,
                           result_kind=result_kind, result_detail=result_detail)
            return

        tool_results = []
        for tc in tool_calls:
            # Per-tool gate (D19): pause for human approval before an impactful tool.
            # The adapter owns which tools are gated and the session allowlist, so a
            # not-yet-allowed gated tool yields a two-way ToolApprovalRequested; deny
            # (or anything not explicitly allowed) skips it with a tool-error so the
            # model picks another step rather than the run dying.
            approved = True
            if gate is not None and gate(tc["name"], tc["args"]):
                decision = yield ToolApprovalRequested(tc["name"], tc["args"])
                approved = decision in ("allow", "always_session")

            if not approved:
                result = (
                    f"The user declined to run this {tc['name']} call. Treat this as a redirect, "
                    "not a failure. Do NOT silently retry or jump to a different step. In your next "
                    "message, explain to the user what you were about to do and why, then ask how "
                    "they'd like to proceed — and wait for their reply before acting."
                )
            else:
                handler = tool_handlers.get(tc["name"])
                if handler:
                    try:
                        result = handler(tc["args"])
                    except Exception as e:
                        result = f"Error: tool '{tc['name']}' raised {type(e).__name__}: {e}"
                else:
                    result = f"Error: unknown tool '{tc['name']}'"

                # Item 26: on a model-invoked lean_check, append the domain-scoped tactic
                # cascade for the mathematics actually in the checked file — injected here
                # at tool-use time so the cached prompt prefix is untouched, once per domain
                # per run. Best-effort: an unreadable path just yields no hint.
                if tc["name"] == "lean_check":
                    hint = _domain_cascade_for_check(tc.get("args") or {}, working_dir, surfaced_domains)
                    if hint:
                        result = f"{result}\n\n{hint}"

            preview = result[:200] + "..." if len(result) > 200 else result
            yield ToolResulted(tc["name"], result, preview)
            for ev in _meaning_events(tc["name"], tc["args"], result):
                yield ev
            # A spawn_subagent call produced a typed result the string can't carry
            # (the child transcript, the result id). Surface it as SubagentFinished so
            # the adapter can store the transcript separately and keep the audit link.
            if tc["name"] == "spawn_subagent":
                for child_result in subagents.drain_results():
                    yield child_result.to_event()
            proof_state.note_tool_result(tc["name"], tc["args"], result)

            tool_result = {"type": "tool_result", "tool_name": tc["name"], "content": result}
            if tc["id"]:
                tool_result["tool_use_id"] = tc["id"]
                tool_result["tool_call_id"] = tc["id"]
            tool_results.append(tool_result)

        messages.append({"role": "user", "content": tool_results})
