from __future__ import annotations

import os
import re
import subprocess
import sys
import time
import ast
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from queue import Queue
from threading import Lock
from typing import Any

from .config import LeaConfig, apply_provider_env
from . import store


active_run_lock = Lock()


@dataclass
class RunnerContext:
    session_id: str
    run_id: str
    task: str
    config: LeaConfig
    events: Queue[dict[str, Any]]


def emit(events: Queue[dict[str, Any]], event_type: str, payload: dict[str, Any]) -> None:
    events.put({"type": event_type, "payload": payload})


def log_status(context: RunnerContext, message: str, **payload: Any) -> None:
    data = {"message": message, **payload}
    print(f"[lea-run:{context.run_id}] {message}", flush=True)
    emit(context.events, "status", data)


@contextmanager
def working_directory(path: Path):
    previous = Path.cwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(previous)


def _load_lea_modules(config: LeaConfig):
    lea_root = config.lea_root.resolve()
    if not lea_root.exists():
        raise FileNotFoundError(f"Lea root not found: {lea_root}")
    if str(lea_root) not in sys.path:
        sys.path.insert(0, str(lea_root))

    from lea.agent import DEFAULT_MODEL
    from lea.prompt import load_system_prompt
    from lea.providers import Done, TextDelta, ToolCall, Usage, _ToolMeta, detect_provider, stream
    from lea.tools import TOOL_HANDLERS, TOOLS_SCHEMA

    return {
        "DEFAULT_MODEL": DEFAULT_MODEL,
        "load_system_prompt": load_system_prompt,
        "Done": Done,
        "TextDelta": TextDelta,
        "ToolCall": ToolCall,
        "Usage": Usage,
        "_ToolMeta": _ToolMeta,
        "detect_provider": detect_provider,
        "stream": stream,
        "TOOL_HANDLERS": TOOL_HANDLERS,
        "TOOLS_SCHEMA": TOOLS_SCHEMA,
    }


def _relative_path(path: str, lea_root: Path) -> str:
    lea_root = lea_root.resolve()
    candidate = Path(path).expanduser()
    if not candidate.is_absolute():
        candidate = (lea_root / candidate).resolve()
    else:
        candidate = candidate.resolve()
    try:
        return str(candidate.relative_to(lea_root))
    except ValueError:
        return str(candidate)


def _resolve_lea_path(path: str, lea_root: Path) -> Path:
    candidate = Path(path).expanduser()
    if candidate.is_absolute():
        return candidate.resolve()
    return (lea_root / candidate).resolve()


def _emit_file_snapshot(
    *,
    context: RunnerContext,
    path: Path,
    emitted: set[tuple[Path, int, int]],
) -> dict[str, Any] | None:
    if not path.exists() or path.suffix != ".lean":
        return None
    stat = path.stat()
    emitted_key = (path.resolve(), stat.st_mtime_ns, stat.st_size)
    if emitted_key in emitted:
        return None
    emitted.add(emitted_key)
    step = store.add_code_step(
        context.session_id,
        context.run_id,
        _relative_path(str(path), context.config.lea_root.resolve()),
        path.read_text(),
        kind="code",
        turn=getattr(context, "current_turn", None),
    )
    emit(context.events, "code_step", step)
    log_status(context, f"Captured Lean file update: {step['path']}", status="code_step")
    return step


def _emit_no_code_step(
    *,
    context: RunnerContext,
    turn: int,
    had_tool_call: bool,
    latest_path: str | None,
    latest_code: str,
) -> dict[str, Any]:
    summary = (
        f"Turn {turn}: no Lean file changes after tool calls."
        if had_tool_call
        else f"Turn {turn}: no tool calls and no Lean file changes."
    )
    step = store.add_code_step(
        context.session_id,
        context.run_id,
        latest_path or "No Lean file yet",
        latest_code,
        kind="no_code",
        summary=summary,
        turn=turn,
    )
    emit(context.events, "code_step", step)
    log_status(context, summary, status="no_code_step", turn=turn)
    return step


def _snapshot_if_lean_file(
    *,
    tool_name: str,
    args: dict,
    result: str,
    context: RunnerContext,
) -> None:
    if tool_name not in {"write_file", "edit_file"}:
        return
    path_arg = args.get("path")
    if not path_arg or not str(path_arg).endswith(".lean"):
        return
    if result.startswith("Error:"):
        return

    file_path = _resolve_lea_path(str(path_arg), context.config.lea_root.resolve())
    if not file_path.exists():
        return

    code = file_path.read_text()
    step = store.add_code_step(context.session_id, context.run_id, _relative_path(str(file_path), context.config.lea_root.resolve()), code)
    emit(context.events, "code_step", step)


def _proof_files(lea_root: Path) -> dict[Path, tuple[int, int]]:
    proof_root = lea_root / "workspace" / "proofs"
    if not proof_root.exists():
        return {}
    files: dict[Path, tuple[int, int]] = {}
    for path in proof_root.rglob("*.lean"):
        stat = path.stat()
        files[path.resolve()] = (stat.st_mtime_ns, stat.st_size)
    return files


def _emit_changed_proof_files(
    *,
    context: RunnerContext,
    before: dict[Path, tuple[int, int]],
    emitted: set[tuple[Path, int, int]],
) -> tuple[dict[Path, tuple[int, int]], list[dict[str, Any]]]:
    current = _proof_files(context.config.lea_root.resolve())
    steps = []
    for path, signature in current.items():
        if before.get(path) == signature:
            continue
        emitted_key = (path, signature[0], signature[1])
        if emitted_key in emitted:
            continue
        step = _emit_file_snapshot(context=context, path=path, emitted=emitted)
        if step:
            steps.append(step)
    return current, steps


def _parse_tool_call(line: str) -> tuple[str, dict[str, Any]] | None:
    stripped = line.strip()
    if not stripped.startswith("-> "):
        return None
    match = re.match(r"->\s+([a-zA-Z_][a-zA-Z0-9_]*)\((.*)\)\s*$", stripped)
    if not match:
        return None
    try:
        args = ast.literal_eval(match.group(2))
    except (SyntaxError, ValueError):
        return None
    if not isinstance(args, dict):
        return None
    return match.group(1), args


def _run_lea_subprocess(context: RunnerContext) -> None:
    model = context.config.model
    provider = context.config.provider
    if not provider:
        lea = _load_lea_modules(context.config)
        provider = lea["detect_provider"](model)

    env = os.environ.copy()
    apply_provider_env(context.config)
    env.update(os.environ)
    lea_root = context.config.lea_root.resolve()
    env["PYTHONPATH"] = os.pathsep.join([str(lea_root), env.get("PYTHONPATH", "")]).strip(os.pathsep)

    args = [
        "uv",
        "run",
        "python",
        "-m",
        "lea.cli",
        "-p",
        provider,
        "-m",
        model,
    ]
    if context.config.max_turns:
        args.extend(["--max-turns", str(context.config.max_turns)])
    args.append(context.task)

    store.update_run(context.run_id, "running")
    store.touch_session(context.session_id, "running")
    log_status(
        context,
        f"Starting Lea subprocess with provider={provider}, model={model}, max_turns={context.config.max_turns or 'unlimited'}",
        status="running",
        provider=provider,
        model=model,
        max_turns=context.config.max_turns,
    )
    log_status(context, "$ " + " ".join(args), status="command")

    before = _proof_files(lea_root)
    emitted: set[tuple[Path, int, int]] = set()
    process = subprocess.Popen(
        args,
        cwd=lea_root,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    assistant_buffer: list[str] = []
    final_text_lines: list[str] = []
    current_turn: int | None = None
    turn_had_tool_call = False
    turn_had_code_step = False
    latest_code = ""
    latest_path: str | None = None
    pending_snapshot_path: Path | None = None
    assert process.stdout is not None

    def finish_turn() -> None:
        nonlocal turn_had_code_step
        if current_turn is None or turn_had_code_step:
            return
        _emit_no_code_step(
            context=context,
            turn=current_turn,
            had_tool_call=turn_had_tool_call,
            latest_path=latest_path,
            latest_code=latest_code,
        )
        turn_had_code_step = True

    while True:
        line = process.stdout.readline()
        if line:
            assistant_buffer.append(line)
            turn_match = re.match(r"--- turn (\d+) ---", line.strip())
            if turn_match:
                finish_turn()
                current_turn = int(turn_match.group(1))
                setattr(context, "current_turn", current_turn)
                turn_had_tool_call = False
                turn_had_code_step = False
                pending_snapshot_path = None
            parsed_tool = _parse_tool_call(line)
            if parsed_tool and parsed_tool[0] in {"write_file", "edit_file"}:
                turn_had_tool_call = True
                path_arg = parsed_tool[1].get("path")
                if isinstance(path_arg, str) and path_arg.endswith(".lean"):
                    pending_snapshot_path = _resolve_lea_path(path_arg, lea_root)
            elif parsed_tool:
                turn_had_tool_call = True
            _emit_lea_cli_line(
                context=context,
                line=line,
                current_turn=current_turn,
                final_text_lines=final_text_lines,
            )
            if line.strip().startswith("<- ") and pending_snapshot_path:
                if not line.strip().startswith("<- Error:"):
                    step = _emit_file_snapshot(context=context, path=pending_snapshot_path, emitted=emitted)
                    if step:
                        turn_had_code_step = True
                        latest_path = step["path"]
                        latest_code = step["code"]
                pending_snapshot_path = None
            print(f"[lea-run:{context.run_id}] {line.rstrip()}", flush=True)
        before, poll_steps = _emit_changed_proof_files(context=context, before=before, emitted=emitted)
        if poll_steps:
            turn_had_code_step = True
            latest_path = poll_steps[-1]["path"]
            latest_code = poll_steps[-1]["code"]
        if not line and process.poll() is not None:
            break
        if not line:
            time.sleep(0.2)

    before, poll_steps = _emit_changed_proof_files(context=context, before=before, emitted=emitted)
    if poll_steps:
        turn_had_code_step = True
        latest_path = poll_steps[-1]["path"]
        latest_code = poll_steps[-1]["code"]
    finish_turn()
    output = "".join(assistant_buffer).strip()
    final_text = "\n".join(dict.fromkeys(final_text_lines)).strip()
    if final_text:
        message = store.add_message(context.session_id, "assistant", final_text, context.run_id)
        emit(context.events, "message", message)

    code = process.returncode or 0
    status = "success" if code == 0 and "OK" in output else "failed"
    store.update_run(context.run_id, status, final_text=final_text or output or f"Lea exited with {code}")
    store.touch_session(context.session_id, status)
    emit(context.events, "done", {"status": status, "exit_code": code})


def _emit_chat_message(context: RunnerContext, role: str, content: str) -> None:
    message = store.add_message(context.session_id, role, content, context.run_id)
    emit(context.events, "message", message)


def _shorten(value: str, limit: int = 1000) -> str:
    if len(value) <= limit:
        return value
    return value[:limit] + "\n... (truncated)"


def _emit_lea_cli_line(
    *,
    context: RunnerContext,
    line: str,
    current_turn: int | None,
    final_text_lines: list[str],
) -> None:
    stripped = line.strip()
    if not stripped:
        return

    turn_match = re.match(r"--- turn (\d+) ---", stripped)
    if turn_match:
        _emit_chat_message(context, "system", f"Turn {turn_match.group(1)}")
        return

    if stripped.startswith("-> "):
        label = f"Turn {current_turn}: tool call" if current_turn else "Tool call"
        _emit_chat_message(context, "system", f"{label}\n{_shorten(stripped)}")
        return

    if stripped.startswith("<- "):
        label = f"Turn {current_turn}: tool result" if current_turn else "Tool result"
        _emit_chat_message(context, "system", f"{label}\n{_shorten(stripped)}")
        return

    if stripped.startswith("--- ") and "tokens" in stripped:
        _emit_chat_message(context, "system", stripped)
        return

    if stripped.startswith("Building ") or stripped.startswith("Built ") or stripped.startswith("Installed ") or stripped.startswith("Uninstalled "):
        log_status(context, stripped, status="lea_setup")
        return

    final_text_lines.append(stripped)


def run_lea(context: RunnerContext) -> None:
    if not active_run_lock.acquire(blocking=False):
        store.update_run(context.run_id, "failed", final_text="Another Lea run is already active.")
        store.touch_session(context.session_id, "failed")
        emit(context.events, "error", {"message": "Another Lea run is already active."})
        emit(context.events, "done", {"status": "failed"})
        return

    try:
        _run_lea_subprocess(context)
        return

        apply_provider_env(context.config)
        lea = _load_lea_modules(context.config)
        model = context.config.model or lea["DEFAULT_MODEL"]
        provider_name = context.config.provider or lea["detect_provider"](model)
        total_usage = lea["Usage"]()
        messages: list[dict[str, Any]] = [{"role": "user", "content": context.task}]
        last_lean_check_ok = False

        store.update_run(context.run_id, "running")
        store.touch_session(context.session_id, "running")
        log_status(
            context,
            f"Starting Lea with provider={provider_name}, model={model}, max_turns={context.config.max_turns or 'unlimited'}",
            status="running",
            provider=provider_name,
            model=model,
            max_turns=context.config.max_turns,
        )

        with working_directory(context.config.lea_root):
            system = lea["load_system_prompt"]("default")
            turn = 0
            while True:
                turn += 1
                if context.config.max_turns and turn > context.config.max_turns:
                    final_text = "Error: max turns reached without completing the proof."
                    store.add_message(context.session_id, "system", final_text, context.run_id)
                    store.update_run(
                        context.run_id,
                        "max_turns",
                        final_text=final_text,
                        input_tokens=total_usage.input_tokens,
                        output_tokens=total_usage.output_tokens,
                    )
                    store.touch_session(context.session_id, "max_turns")
                    emit(context.events, "message", {"role": "system", "content": final_text})
                    emit(context.events, "done", {"status": "max_turns"})
                    return

                log_status(context, f"Turn {turn}: calling model", status="calling_model", turn=turn)
                assistant_parts: list[dict[str, Any]] = []
                current_text = ""
                tool_calls: list[dict[str, Any]] = []

                for event in lea["stream"](
                    model,
                    system,
                    messages,
                    lea["TOOLS_SCHEMA"],
                    provider_name,
                ):
                    if isinstance(event, lea["TextDelta"]):
                        current_text += event.text
                        emit(context.events, "assistant_delta", {"text": event.text})
                    elif isinstance(event, lea["ToolCall"]):
                        if current_text:
                            assistant_parts.append({"type": "text", "text": current_text})
                            current_text = ""
                        tool_calls.append(
                            {
                                "name": event.name,
                                "args": event.args,
                                "id": None,
                                "raw_part": event.raw_part,
                            }
                        )
                        log_status(
                            context,
                            f"Turn {turn}: model requested {event.name}",
                            status="tool_call",
                            turn=turn,
                            tool=event.name,
                            args=event.args,
                        )
                    elif isinstance(event, lea["_ToolMeta"]):
                        if tool_calls:
                            tool_calls[-1]["id"] = event.tool_use_id
                    elif isinstance(event, lea["Done"]):
                        total_usage.input_tokens += event.usage.input_tokens
                        total_usage.output_tokens += event.usage.output_tokens

                    if current_text:
                        assistant_parts.append({"type": "text", "text": current_text})

                for tool_call in tool_calls:
                    assistant_parts.append(
                        {
                            "type": "tool_call",
                            "name": tool_call["name"],
                            "args": tool_call["args"],
                            "id": tool_call["id"],
                            "raw_part": tool_call.get("raw_part"),
                        }
                    )

                messages.append({"role": "assistant", "content": assistant_parts})

                assistant_text = "".join(
                    part["text"] for part in assistant_parts if part.get("type") == "text"
                ).strip()
                if assistant_text:
                    message = store.add_message(
                        context.session_id,
                        "assistant",
                        assistant_text,
                        context.run_id,
                    )
                    emit(context.events, "message", message)

                if not tool_calls:
                    final_text = assistant_text or "(no response)"
                    status = "success" if last_lean_check_ok else "failed"
                    store.update_run(
                        context.run_id,
                        status,
                        final_text=final_text,
                        input_tokens=total_usage.input_tokens,
                        output_tokens=total_usage.output_tokens,
                    )
                    store.touch_session(context.session_id, status)
                    emit(
                        context.events,
                        "done",
                        {
                            "status": status,
                            "input_tokens": total_usage.input_tokens,
                            "output_tokens": total_usage.output_tokens,
                        },
                    )
                    return

                tool_results: list[dict[str, Any]] = []
                for tool_call in tool_calls:
                    handler = lea["TOOL_HANDLERS"].get(tool_call["name"])
                    if not handler:
                        result = f"Error: unknown tool '{tool_call['name']}'"
                    else:
                        try:
                            result = handler(tool_call["args"])
                        except Exception as exc:
                            result = (
                                f"Error: tool '{tool_call['name']}' raised "
                                f"{type(exc).__name__}: {exc}"
                            )

                    if tool_call["name"] == "lean_check":
                        last_lean_check_ok = result.startswith("OK")

                    _snapshot_if_lean_file(
                        tool_name=tool_call["name"],
                        args=tool_call["args"],
                        result=result,
                        context=context,
                    )

                    log_status(
                        context,
                        f"Turn {turn}: {tool_call['name']} returned {result[:120]}",
                        status="tool_result",
                        turn=turn,
                        tool=tool_call["name"],
                        preview=result[:500],
                    )

                    tool_result = {
                        "type": "tool_result",
                        "tool_name": tool_call["name"],
                        "content": result,
                    }
                    if tool_call["id"]:
                        tool_result["tool_use_id"] = tool_call["id"]
                        tool_result["tool_call_id"] = tool_call["id"]
                    tool_results.append(tool_result)

                messages.append({"role": "user", "content": tool_results})
    except Exception as exc:
        message = f"{type(exc).__name__}: {exc}"
        store.add_message(context.session_id, "system", message, context.run_id)
        store.update_run(context.run_id, "failed", final_text=message)
        store.touch_session(context.session_id, "failed")
        emit(context.events, "error", {"message": message})
        emit(context.events, "done", {"status": "failed"})
    finally:
        active_run_lock.release()
