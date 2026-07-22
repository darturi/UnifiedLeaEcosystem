"""Concurrent children (E2) — real thread overlap, a concurrency cap, failure isolation.

E1 made one child stream live; E2 runs a turn's MANY children at once, each on its own
thread with an isolated context copy, merging their events. These pin:

  * `run_children_concurrently` truly OVERLAPS its children — two children that must meet
    at a `threading.Barrier` both pass it (they'd deadlock if run serially), and their
    progress interleaves up through the one generator;
  * `max_children` is a hard cap — with one slot the same two children CANNOT both reach
    the barrier, so they run one-at-a-time (the laptop-safety guard, B1/B3);
  * a child that raises is isolated into its own error render — its sibling still
    completes cleanly;
  * every child still records a typed result (for the coordinator's SubagentFinished).

Run:  uv run python -m tests.subagents.test_subagent_parallel
Exits 0 if every check passes, 1 otherwise.
"""

import tempfile
import threading
from pathlib import Path

import lea.agent as agent
from lea.config import LeaConfig
from lea.events import CheckResult, Finished, SubagentStarted, SubagentFinished, ToolResulted
from lea.providers import TextDelta, ToolCall, Done, _ToolMeta, Usage
from lea.runctx import run_context
from lea import subagents
from lea.subagents import prepare_spawn, run_children_concurrently, drain_results

_FAILURES: list[str] = []


def check(name: str, cond: bool) -> None:
    print(f"  ok   {name}" if cond else f"  FAIL {name}")
    if not cond:
        _FAILURES.append(name)


def _cfg(**over):
    base = dict(model="m", max_turns=None,
                tools=["read_file", "write_file", "lean_check", "spawn_subagent"])
    base.update(over)
    return LeaConfig(**base)


def _barrier_child(barrier: threading.Barrier):
    """A child that must RENDEZVOUS with a sibling at `barrier` to make progress. If both
    children run concurrently they meet and pass (→ a clean 'ok' candidate); if they are
    serialized the wait times out and the child finishes 'SOLO' with no candidate. So the
    verdict encodes whether real overlap happened."""
    def fake(config, messages, *, namespace=None, session_id=None, working_dir=None,
             should_stop=None, gate=None, depth=0):
        overlapped = True
        try:
            barrier.wait(timeout=2.0)
        except threading.BrokenBarrierError:
            overlapped = False
        if overlapped:
            cand = Path(working_dir) / "C.lean"
            cand.write_text("theorem c : True := by trivial\n")
            yield CheckResult(str(cand), "ok", None)
            yield Finished("completed", "overlapped", 1, session_id or "c", config.model,
                           Usage(1, 1), 0.0, {"messages": []})
        else:
            yield Finished("completed", "SOLO", 1, session_id or "c", config.model,
                           Usage(1, 1), 0.0, {"messages": []})
    return fake


def _drive(gen):
    prog = []
    try:
        while True:
            prog.append(next(gen))
    except StopIteration as stop:
        return prog, stop.value


def test_children_truly_overlap(monkeypatch):
    barrier = threading.Barrier(2)
    monkeypatch.setattr(agent, "run_events", _barrier_child(barrier))
    with tempfile.TemporaryDirectory() as d:
        with run_context(depth=0, config=_cfg(), working_dir=str(Path(d).resolve()), run_key="s"):
            token = subagents.begin_results_scope()
            plans = [prepare_spawn({"description": f"c{i}", "prompt": "go"}) for i in range(2)]
            prog, renders = _drive(run_children_concurrently(plans, max_children=2))
            drained = drain_results()
            subagents.end_results_scope(token)

    check("both children returned a render", len(renders) == 2)
    check("progress streamed from BOTH children",
          {p.result_id for p in prog} == set(renders.keys()) and len(prog) >= 2)
    check("both children recorded a typed result", len(drained) == 2)
    check("both OVERLAPPED (passed the barrier → clean candidate)",
          all(r.check_status == "ok" for r in drained))


def test_max_children_caps_concurrency(monkeypatch):
    # Same two barrier children, but ONE slot: they can't both reach the barrier, so it
    # breaks and each runs SOLO. Proves the cap actually serializes.
    barrier = threading.Barrier(2)
    monkeypatch.setattr(agent, "run_events", _barrier_child(barrier))
    with tempfile.TemporaryDirectory() as d:
        with run_context(depth=0, config=_cfg(), working_dir=str(Path(d).resolve()), run_key="s"):
            token = subagents.begin_results_scope()
            plans = [prepare_spawn({"description": f"c{i}", "prompt": "go"}) for i in range(2)]
            _prog, renders = _drive(run_children_concurrently(plans, max_children=1))
            drained = drain_results()
            subagents.end_results_scope(token)
    check("both children still returned a render under the cap", len(renders) == 2)
    check("neither overlapped (barrier broke → no candidate)",
          all(r.check_status is None for r in drained))
    check("both summaries are SOLO", all(r.summary == "SOLO" for r in drained))


def test_a_failing_child_is_isolated(monkeypatch):
    def fake(config, messages, *, namespace=None, session_id=None, working_dir=None,
             should_stop=None, gate=None, depth=0):
        # the FIRST child (its scratch dir ends in '-0'... but ids are random) — decide by
        # a marker in the task instead: the prompt says 'BOOM' → raise.
        task = messages[0]["content"] if messages else ""
        if "BOOM" in task:
            raise RuntimeError("kaboom")
        cand = Path(working_dir) / "C.lean"
        cand.write_text("theorem c : True := by trivial\n")
        yield CheckResult(str(cand), "ok", None)
        yield Finished("completed", "fine", 1, session_id or "c", config.model,
                       Usage(1, 1), 0.0, {"messages": []})

    monkeypatch.setattr(agent, "run_events", fake)
    with tempfile.TemporaryDirectory() as d:
        with run_context(depth=0, config=_cfg(), working_dir=str(Path(d).resolve()), run_key="s"):
            token = subagents.begin_results_scope()
            bad = prepare_spawn({"description": "bad", "prompt": "BOOM please"})
            good = prepare_spawn({"description": "good", "prompt": "prove it"})
            _prog, renders = _drive(run_children_concurrently([bad, good], max_children=2))
            drained = drain_results()
            subagents.end_results_scope(token)
    by_id = {r.result_id: r for r in drained}
    check("both children produced a result (the failure didn't kill the sibling)", len(drained) == 2)
    check("the failing child rendered an error", "Error" in renders[bad.result_id])
    check("the failing child's result reason is 'error'", by_id[bad.result_id].stop_reason == "error")
    check("the healthy sibling still completed cleanly", by_id[good.result_id].check_status == "ok")


def test_loop_runs_two_spawns_in_one_turn_concurrently():
    # The REAL coordinator loop: a turn issues TWO spawn_subagent calls. They must run
    # concurrently — the barrier children only pass if they overlap — and the loop must
    # emit two Started + two Finished and complete.
    barrier = threading.Barrier(2)
    real_run_events = agent.run_events
    saved_stream, saved_prompt = agent.stream, agent.load_system_prompt
    tmp = tempfile.TemporaryDirectory()
    state = {"n": 0}

    def coordinator_stream(model, system, messages, tools, model_kwargs=None, streaming=True):
        if "classify the mathematical outcome" in system:
            yield TextDelta("PROVED")
            yield Done(Usage(2, 1), 0.0001)
            return
        state["n"] += 1
        if state["n"] == 1:
            yield TextDelta("Delegating two lemmas. ")
            yield ToolCall("spawn_subagent", {"description": "L1", "prompt": "prove L1"})
            yield _ToolMeta("call_a")
            yield ToolCall("spawn_subagent", {"description": "L2", "prompt": "prove L2"})
            yield _ToolMeta("call_b")
            yield Done(Usage(100, 40), 0.003)
        else:
            yield TextDelta("Both done.")
            yield Done(Usage(20, 10), 0.001)

    try:
        agent.stream = coordinator_stream
        agent.load_system_prompt = lambda variant, skills=None, workspace=None, namespace=None: "SYS"
        agent.run_events = _barrier_child(barrier)  # children resolve THIS (late import)
        events = list(real_run_events(
            _cfg(), [{"role": "user", "content": "prove it"}],
            session_id="coord", working_dir=str(Path(tmp.name).resolve()),
        ))
    finally:
        agent.run_events = real_run_events
        agent.stream, agent.load_system_prompt = saved_stream, saved_prompt
        tmp.cleanup()

    started = [e for e in events if isinstance(e, SubagentStarted)]
    finished = [e for e in events if isinstance(e, SubagentFinished)]
    check("two children were announced (Started)", len(started) == 2)
    check("two children finished", len(finished) == 2)
    check("both spawns OVERLAPPED in the one turn (clean candidates)",
          all(f.check_status == "ok" for f in finished))
    check("the run completed", any(isinstance(e, Finished) and e.reason == "completed" for e in events))


def test_loop_parallelizes_two_readonly_tools():
    # E3: a turn issuing two INDEPENDENT read_file calls runs them through the concurrent
    # read-only path — both results must come back correct and IN ORDER (the provider
    # matches tool_results to calls). Correctness through the parallel branch; the overlap
    # mechanism itself is proven by the barrier test above.
    saved_stream, saved_prompt = agent.stream, agent.load_system_prompt
    tmp = tempfile.TemporaryDirectory()
    fa = Path(tmp.name) / "a.txt"
    fb = Path(tmp.name) / "b.txt"
    fa.write_text("ALPHA-CONTENT")
    fb.write_text("BETA-CONTENT")
    state = {"n": 0}

    def coordinator_stream(model, system, messages, tools, model_kwargs=None, streaming=True):
        if "classify the mathematical outcome" in system:
            yield TextDelta("PROVED")
            yield Done(Usage(2, 1), 0.0001)
            return
        state["n"] += 1
        if state["n"] == 1:
            yield ToolCall("read_file", {"path": str(fa)})
            yield _ToolMeta("ra")
            yield ToolCall("read_file", {"path": str(fb)})
            yield _ToolMeta("rb")
            yield Done(Usage(100, 40), 0.003)
        else:
            yield TextDelta("Read both.")
            yield Done(Usage(20, 10), 0.001)

    try:
        agent.stream = coordinator_stream
        agent.load_system_prompt = lambda variant, skills=None, workspace=None, namespace=None: "SYS"
        events = list(agent.run_events(
            _cfg(tools=["read_file"]), [{"role": "user", "content": "read them"}],
            session_id="c", working_dir=str(Path(tmp.name).resolve()),
        ))
    finally:
        agent.stream, agent.load_system_prompt = saved_stream, saved_prompt
        tmp.cleanup()

    reads = [e for e in events if isinstance(e, ToolResulted) and e.name == "read_file"]
    check("both read_file calls produced a result", len(reads) == 2)
    check("first result is file a (order preserved)", "ALPHA-CONTENT" in reads[0].content)
    check("second result is file b (order preserved)", "BETA-CONTENT" in reads[1].content)


# --- standalone runner ---------------------------------------------------------

class _MonkeyPatch:
    def __init__(self):
        self._undo = []

    def setattr(self, obj, name, value):
        self._undo.append((obj, name, getattr(obj, name)))
        setattr(obj, name, value)

    def undo(self):
        for obj, name, old in reversed(self._undo):
            setattr(obj, name, old)
        self._undo.clear()


def main():
    print("subagent concurrency tests (E2):")
    for fn in (test_children_truly_overlap, test_max_children_caps_concurrency,
               test_a_failing_child_is_isolated):
        mp = _MonkeyPatch()
        try:
            fn(mp)
        finally:
            mp.undo()
    test_loop_runs_two_spawns_in_one_turn_concurrently()
    test_loop_parallelizes_two_readonly_tools()
    print()
    if _FAILURES:
        print(f"FAILED ({len(_FAILURES)}): {', '.join(_FAILURES)}")
        raise SystemExit(1)
    print("All subagent concurrency tests passed (E2).")
    raise SystemExit(0)


if __name__ == "__main__":
    main()
