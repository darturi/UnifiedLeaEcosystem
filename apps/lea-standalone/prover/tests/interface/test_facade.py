"""Unit tests for A7: lea.interface is the prover's single public surface.

Pins the facade contract — the adapter imports everything it needs from
`lea.interface` (the three capabilities + every event type), and the re-exports
are the *same* objects as their source modules, not copies.

Run:  uv run python -m tests.interface.test_facade
"""

import sys

import lea.interface as interface
from lea import agent, events

_FAILURES: list[str] = []


def check(name: str, cond: bool) -> None:
    print(f"  ok   {name}" if cond else f"  FAIL {name}")
    if not cond:
        _FAILURES.append(name)


def test_all_names_resolve():
    for name in interface.__all__:
        check(f"__all__ '{name}' is importable", hasattr(interface, name))


def test_capabilities_present():
    check("run_events exported", interface.run_events is agent.run_events)
    check("check is callable", callable(interface.check))
    check("verify is callable", callable(interface.verify))
    check("check defined in interface", interface.check.__module__ == "lea.interface")
    check("verify defined in interface", interface.verify.__module__ == "lea.interface")


def test_events_are_same_classes():
    # re-exports must be the *same* classes, so isinstance() across the boundary works
    for name in ("AssistantTextDelta", "TurnStarted", "ToolCalled", "ToolResulted",
                 "ToolApprovalRequested", "UsageUpdated", "FileChanged", "CheckResult",
                 "VerifyResult", "Error", "Finished", "AgentEvent"):
        check(f"{name} is events.{name}", getattr(interface, name) is getattr(events, name))


def test_one_import_shape():
    # the documented adapter import works in one line. Alias on import so the
    # capability `check` doesn't shadow this module's check() accumulator.
    from lea.interface import (  # noqa: F401
        run_events as _run, check as _chk, verify as _vrf,
        FileChanged as _fc, CheckResult as _cr, VerifyResult as _vr,
    )
    check("one-line adapter import works",
          all(obj is not None for obj in (_run, _chk, _vrf, _fc, _cr, _vr)))


def test_tool_approval_exported():
    # the per-tool gate's control event (A8) is part of the public surface.
    check("ToolApprovalRequested exported", "ToolApprovalRequested" in interface.__all__)
    check("ToolApprovalRequested is events class",
          interface.ToolApprovalRequested is events.ToolApprovalRequested)


def main():
    print("interface facade (A7) tests:")
    test_all_names_resolve()
    test_capabilities_present()
    test_events_are_same_classes()
    test_one_import_shape()
    test_tool_approval_exported()
    print()
    if _FAILURES:
        print(f"FAILED ({len(_FAILURES)}): {', '.join(_FAILURES)}")
        sys.exit(1)
    print("All interface facade tests passed.")
    sys.exit(0)


if __name__ == "__main__":
    main()
