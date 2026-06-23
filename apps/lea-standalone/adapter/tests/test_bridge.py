"""D1·bridge: the in-process prover seam (bridge.run_lea).

Instead of normalizing an HTTP SSE stream, the bridge consumes the prover's typed
events directly. These tests drive `run_lea` with a *fake* `run_events` generator
(no model, no Lean) that writes a real `.lean` file into the session's git repo
and yields a realistic event sequence, then assert the bridge's side effects: a
git commit, a code_step pointing at it with the back-filled verdict, narration
flushed into messages, the run persisted with usage, and the SSE events emitted in
order — ending with `done`.
"""

import time
from pathlib import Path
from queue import Queue
from threading import Event, Thread

from lea.interface import (
    AssistantTextDelta,
    CheckResult,
    FileChanged,
    Finished,
    ToolApprovalRequested,
    ToolCalled,
    ToolResulted,
    TurnStarted,
    UsageUpdated,
)
from lea.providers import Usage

from app import bridge, db, projects, store
from app.config import LeaConfig


def _drain(q: Queue) -> list[dict]:
    items = []
    while not q.empty():
        items.append(q.get_nowait())
    return items


def _context(tmp_path, monkeypatch, task="Prove True"):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    session = store.create_session(task)
    run = store.create_run(session["id"], "gemini/test", None, 3)
    config = LeaConfig(model="gemini/test", max_turns=3, lea_root=tmp_path)
    queue: Queue = Queue()
    ctx = bridge.RunnerContext(
        session_id=session["id"], run_id=run["id"], task=task, config=config, events=queue,
    )
    return ctx, queue


def _fake_run_events(events):
    """Build a fake run_events that writes a file into working_dir then replays
    `events` (a callable taking the absolute proof path, returning the sequence)."""

    def fake(config, messages, *, namespace=None, session_id=None, working_dir=None, should_stop=None, gate=None):
        proof = Path(working_dir) / "Lea" / "Misc" / "proof.lean"
        proof.parent.mkdir(parents=True, exist_ok=True)
        proof.write_text("import Mathlib\n\ntheorem t : True := by trivial\n")
        yield from events(str(proof))

    return fake


def test_happy_path_commits_steps_and_persists_run(tmp_path, monkeypatch):
    ctx, queue = _context(tmp_path, monkeypatch)

    def script(proof_path):
        yield TurnStarted(1)
        yield AssistantTextDelta("Let me try ")
        yield AssistantTextDelta("trivial.")
        yield ToolCalled("write_file", {"path": proof_path})
        yield FileChanged(proof_path)
        yield UsageUpdated(10, 5, 0.01)
        yield ToolCalled("lean_check", {"path": proof_path})
        yield CheckResult(proof_path, "ok", None)
        yield Finished("completed", "Done — it compiles.", 1, ctx.session_id,
                       "gemini/test", Usage(input_tokens=10, output_tokens=5), 0.01, {})

    monkeypatch.setattr(bridge, "run_events", _fake_run_events(script))

    bridge.run_lea(ctx)

    detail = store.session_detail(ctx.session_id)

    # exactly one curated code step, pointing at a real commit, verdict back-filled
    assert len(detail["code_steps"]) == 1
    step = detail["code_steps"][0]
    assert step["path"] == "Lea/Misc/proof.lean"
    assert step["author"] == "agent" and step["turn"] == 1
    assert len(step["commit_sha"]) == 40
    assert step["check_status"] == "ok"

    # the SHA resolves to the file the fake wrote (git owns the content)
    gs = bridge.GitStore(tmp_path / "workspace" / "proofs")
    assert "theorem t : True" in gs.snapshot(ctx.session_id, step["commit_sha"], step["path"])

    # narration + terminal text landed as assistant messages
    contents = [m["content"] for m in detail["messages"] if m["role"] == "assistant"]
    assert "Let me try trivial." in contents
    assert "Done — it compiles." in contents

    # session status derives to the checked run outcome.
    assert detail["status"] == "proved"

    # run persisted: proved + usage + a per-turn breakdown row
    run = store.get_run(ctx.run_id)
    assert run["status"] == "proved"
    assert run["input_tokens"] == 10 and run["output_tokens"] == 5
    assert abs(run["cost_usd"] - 0.01) < 1e-9
    assert [r["label"] for r in detail["usage_breakdown"]] == ["Turn 1"]

    # the SSE stream carried the live events and ended with done(proved)
    types = [item["type"] for item in _drain(queue)]
    assert "assistant_delta" in types
    assert types.count("code_step") == 2  # write, then verdict back-fill
    assert "message" in types
    assert types[-1] == "done"


def test_disproof_result_persists_and_streams_distinct_outcome(tmp_path, monkeypatch):
    ctx, queue = _context(tmp_path, monkeypatch, task="Find a counterexample")

    def script(proof_path):
        yield TurnStarted(1)
        yield ToolCalled("write_file", {"path": proof_path})
        yield FileChanged(proof_path)
        yield ToolCalled("lean_check", {"path": proof_path})
        yield CheckResult(proof_path, "ok", None)
        yield Finished(
            "completed",
            "Counterexample verified.",
            1,
            ctx.session_id,
            "gemini/test",
            Usage(input_tokens=10, output_tokens=5),
            0.01,
            {},
            result_kind="disproved",
            result_detail="DISPROVED",
        )

    monkeypatch.setattr(bridge, "run_events", _fake_run_events(script))

    bridge.run_lea(ctx)

    detail = store.session_detail(ctx.session_id)
    run = store.get_run(ctx.run_id)
    assert run["status"] == "disproved"
    assert run["result_kind"] == "disproved"
    assert run["result_detail"] == "DISPROVED"
    assert detail["status"] == "disproved"

    items = _drain(queue)
    assert items[-1]["type"] == "done"
    assert items[-1]["payload"]["status"] == "disproved"
    assert items[-1]["payload"]["result_kind"] == "disproved"


def test_project_run_uses_shared_repo_namespace_and_context(tmp_path, monkeypatch):
    # Q2 (D23/D24/D25/D32/D33): a project session writes the shared project repo, the
    # prompt gets the project namespace, the composed context message leads the
    # messages, and an asset write becomes a graph signal (not a canvas snapshot).
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    proofs_root = tmp_path / "workspace" / "proofs"
    project = projects.provision_project("Epsilon", proofs_root, description="ε–δ")
    session = store.create_session("prove foo", project_id=project["id"])
    run = store.create_run(session["id"], "gemini/test", None, 3, project_id=project["id"])
    config = LeaConfig(model="gemini/test", max_turns=3, lea_root=tmp_path)
    queue: Queue = Queue()
    ctx = bridge.RunnerContext(
        session_id=session["id"], run_id=run["id"], task="prove foo", config=config, events=queue,
    )
    captured: dict = {}

    def fake(config, messages, *, namespace=None, session_id=None, working_dir=None, should_stop=None, gate=None):
        captured["namespace"] = namespace
        captured["working_dir"] = working_dir
        captured["messages"] = list(messages)
        # A proof written directly in the project dir (importable as Lea.Epsilon.Foo).
        proof = Path(working_dir) / "Foo.lean"
        proof.write_text("import Mathlib\nnamespace Lea.Epsilon\ntheorem foo : True := by trivial\nend Lea.Epsilon\n")
        yield TurnStarted(1)
        yield ToolCalled("write_file", {"path": str(proof)})
        yield FileChanged(str(proof))
        yield CheckResult(str(proof), "ok", None)
        # The agent also revises the blueprint — an asset write (D33).
        bp = Path(working_dir) / ".lea" / "blueprint.md"
        bp.write_text("# Blueprint — Epsilon\n\n## foo\n- kind: theorem\n- lean: `Lea.Epsilon.foo`\n")
        yield ToolCalled("edit_file", {"path": str(bp)})
        yield ToolResulted("edit_file", "ok", "ok")
        yield Finished("completed", "Proved.", 1, session_id, "gemini/test",
                       Usage(input_tokens=1, output_tokens=1), 0.0, {})

    monkeypatch.setattr(bridge, "run_events", fake)
    bridge.run_lea(ctx)

    # D32/D24: the prompt namespace + working dir point at the project repo.
    assert captured["namespace"] == "Lea.Epsilon"
    assert captured["working_dir"].replace("\\", "/").endswith("/proofs/Lea/Epsilon")
    # D25: the composed project-context message leads the messages.
    first = captured["messages"][0]
    assert first["content"].startswith(projects.CONTEXT_MARKER)
    assert "## Project Instructions" in first["content"] and "Lea.Epsilon" in first["content"]

    # D24: the proof committed to the SHARED project repo, not proofs/<session-id>.
    detail = store.session_detail(session["id"])
    steps = detail["code_steps"]
    assert len(steps) == 1 and steps[0]["path"] == "Foo.lean"
    assert not (proofs_root / session["id"]).exists()  # no loose per-session repo
    gs = bridge.GitStore(proofs_root / "Lea")
    assert "theorem foo" in gs.snapshot("Epsilon", steps[0]["commit_sha"], "Foo.lean")

    # D33: the asset write emitted a project_updated signal and NO extra code_step.
    events = _drain(queue)
    updated = [e for e in events if e["type"] == "project_updated"]
    assert len(updated) == 1
    assert updated[0]["payload"]["path"] == ".lea/blueprint.md"
    assert updated[0]["payload"]["project_id"] == project["id"]
    assert sum(1 for e in events if e["type"] == "code_step") == 2  # proof write + verdict only


def _policy_recording_fake(received: dict):
    """A fake run_events that records the prompt_variant + gate it was handed,
    then finishes cleanly. Lets us assert the autonomous policy without a model."""

    def fake(config, messages, *, namespace=None, session_id=None, working_dir=None, should_stop=None, gate=None):
        received["prompt_variant"] = config.prompt_variant
        received["gate"] = gate
        yield TurnStarted(1)
        yield Finished("assistant", "ok", 1, session_id, "gemini/test",
                       Usage(input_tokens=1, output_tokens=1), 0.0, {"messages": []})

    return fake


def test_autonomous_run_disables_gate_and_uses_default_variant(tmp_path, monkeypatch):
    # Overleaf path: an autonomous run must reach the prover with NO gate (no
    # approval prompts) and the non-interactive `default` prompt variant (no
    # plan-then-pause) — so it formalizes with zero human interaction.
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    session = store.create_session("Prove A")
    run = store.create_run(session["id"], "gemini/test", None, 3, autonomous=True)
    config = LeaConfig(model="gemini/test", max_turns=3, lea_root=tmp_path,
                       prompt_variant="interactive")
    ctx = bridge.RunnerContext(session_id=session["id"], run_id=run["id"], task="Prove A",
                               config=config, events=Queue(), autonomous=True)

    received: dict = {}
    monkeypatch.setattr(bridge, "run_events", _policy_recording_fake(received))
    bridge.run_lea(ctx)

    assert received["gate"] is None
    assert received["prompt_variant"] == "default"
    # the run row persisted the flag (it must survive create → events HTTP hops)
    assert bool(store.get_run(run["id"])["autonomous"]) is True


def test_interactive_run_keeps_gate_and_config_variant(tmp_path, monkeypatch):
    # UI path (default): the gate is wired and the configured prompt variant is
    # left untouched — current behavior is preserved.
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    session = store.create_session("Prove A")
    run = store.create_run(session["id"], "gemini/test", None, 3)  # autonomous defaults False
    config = LeaConfig(model="gemini/test", max_turns=3, lea_root=tmp_path,
                       prompt_variant="interactive")
    ctx = bridge.RunnerContext(session_id=session["id"], run_id=run["id"], task="Prove A",
                               config=config, events=Queue())  # autonomous defaults False

    received: dict = {}
    monkeypatch.setattr(bridge, "run_events", _policy_recording_fake(received))
    bridge.run_lea(ctx)

    assert callable(received["gate"])
    assert received["prompt_variant"] == "interactive"
    assert bool(store.get_run(run["id"])["autonomous"]) is False


def test_done_emitted_and_run_failed_on_exception(tmp_path, monkeypatch):
    ctx, queue = _context(tmp_path, monkeypatch)

    def boom(config, messages, *, namespace=None, session_id=None, working_dir=None, gate=None):
        yield TurnStarted(1)
        raise RuntimeError("model exploded")

    monkeypatch.setattr(bridge, "run_events", boom)

    bridge.run_lea(ctx)

    items = _drain(queue)
    types = [i["type"] for i in items]
    assert "run_error" in types
    assert types[-1] == "done"
    assert items[-1]["payload"]["status"] == "failed"
    assert store.get_run(ctx.run_id)["status"] == "failed"


def _recording_fake(received: list, transcript_messages: list):
    """A fake run_events that records the `messages` it was handed, then Finishes
    with a given transcript (so the bridge persists it for the next activation)."""

    def fake(config, messages, *, namespace=None, session_id=None, working_dir=None, should_stop=None, gate=None):
        received.append(messages)
        yield TurnStarted(1)
        yield Finished("completed", "done", 1, session_id, "gemini/test",
                       Usage(input_tokens=1, output_tokens=1), 0.0,
                       {"messages": transcript_messages})

    return fake


def test_first_run_seeds_only_the_new_user_turn(tmp_path, monkeypatch):
    ctx, _ = _context(tmp_path, monkeypatch, task="Prove A")
    received: list = []
    monkeypatch.setattr(bridge, "run_events",
                        _recording_fake(received, [{"role": "user", "content": "Prove A"}]))

    bridge.run_lea(ctx)

    # a cold first run gets no prior transcript — just the new user turn
    assert received == [[{"role": "user", "content": "Prove A"}]]
    # ...and its transcript is persisted for next time
    assert store.latest_transcript_for_session(ctx.session_id) == [{"role": "user", "content": "Prove A"}]


def test_followup_replays_prior_transcript(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    session = store.create_session("S")
    config = LeaConfig(model="gemini/test", max_turns=3, lea_root=tmp_path)

    # run 1 finishes with a structured transcript carrying a real tool exchange
    transcript1 = [
        {"role": "user", "content": "Prove A"},
        {"role": "assistant", "content": [
            {"type": "text", "text": "trying"},
            {"type": "tool_call", "name": "write_file", "args": {"path": "p.lean"}, "id": "c1"},
        ]},
        {"role": "user", "content": [
            {"type": "tool_result", "tool_name": "write_file", "content": "ok", "tool_call_id": "c1"},
        ]},
        {"role": "assistant", "content": [{"type": "text", "text": "done"}]},
    ]
    run1 = store.create_run(session["id"], "gemini/test", None, 3)
    rec1: list = []
    monkeypatch.setattr(bridge, "run_events", _recording_fake(rec1, transcript1))
    bridge.run_lea(bridge.RunnerContext(session["id"], run1["id"], "Prove A", config, Queue()))
    assert rec1[0] == [{"role": "user", "content": "Prove A"}]

    # run 2 (a follow-up) must receive run 1's full transcript + the new user turn,
    # with the tool_call/tool_result parts intact (no orphaned tool results)
    run2 = store.create_run(session["id"], "gemini/test", None, 3)
    rec2: list = []
    monkeypatch.setattr(bridge, "run_events", _recording_fake(rec2, []))
    bridge.run_lea(bridge.RunnerContext(session["id"], run2["id"], "Now prove B", config, Queue()))

    assert rec2[0] == transcript1 + [{"role": "user", "content": "Now prove B"}]


def test_interrupt_maps_finished_interrupted_to_cancelled(tmp_path, monkeypatch):
    ctx, queue = _context(tmp_path, monkeypatch)

    def interrupted(config, messages, *, namespace=None, session_id=None, working_dir=None, should_stop=None, gate=None):
        yield TurnStarted(1)
        yield Finished("interrupted", "Run interrupted by the user.", 1, session_id,
                       "gemini/test", Usage(input_tokens=2, output_tokens=1), 0.0, {"messages": []})

    monkeypatch.setattr(bridge, "run_events", interrupted)
    bridge.run_lea(ctx)

    assert store.get_run(ctx.run_id)["status"] == "cancelled"
    items = _drain(queue)
    assert items[-1]["type"] == "done"
    assert items[-1]["payload"]["status"] == "cancelled"


def test_request_stop_flag_reaches_the_run(tmp_path, monkeypatch):
    ctx, queue = _context(tmp_path, monkeypatch)
    # Stop was hit before the run loop got going — the endpoint pre-set the flag.
    bridge.request_stop(ctx.run_id)

    def stops_when_asked(config, messages, *, namespace=None, session_id=None, working_dir=None, should_stop=None, gate=None):
        # the agent honors should_stop at its turn boundary
        if should_stop():
            yield Finished("interrupted", "stopped", 0, session_id, "gemini/test",
                           Usage(input_tokens=0, output_tokens=0), 0.0, {"messages": []})
            return
        yield Finished("completed", "done", 1, session_id, "gemini/test",
                       Usage(input_tokens=1, output_tokens=1), 0.0, {"messages": []})

    monkeypatch.setattr(bridge, "run_events", stops_when_asked)
    bridge.run_lea(ctx)

    assert store.get_run(ctx.run_id)["status"] == "cancelled"
    # the flag is cleaned up once the run ends
    assert ctx.run_id not in bridge._stop_events


def test_gate_policy_gates_only_impactful_tools():
    bridge._session_allowlists.pop("sess-gate", None)
    gate = bridge._make_gate("sess-gate")
    # impactful tools are gated; read-only + lean_check are auto-allowed (D19)
    assert gate("bash", {}) and gate("write_file", {}) and gate("edit_file", {})
    assert not gate("read_file", {})
    assert not gate("search_mathlib", {})
    assert not gate("lean_check", {})
    # "always allow this session" exempts that one tool; others still prompt
    bridge._session_allowlists.setdefault("sess-gate", set()).add("bash")
    assert not gate("bash", {})
    assert gate("write_file", {})
    bridge._session_allowlists.pop("sess-gate", None)


def test_resolve_approval_matches_and_rejects_stale():
    bridge._pending_approvals["r1"] = {"approval_id": "a1", "event": Event(), "decision": None}
    try:
        assert not bridge.resolve_approval("r1", "WRONG", "allow")  # wrong approval id
        assert not bridge.resolve_approval("rX", "a1", "allow")     # unknown run
        assert bridge.resolve_approval("r1", "a1", "allow")
        pending = bridge._pending_approvals["r1"]
        assert pending["decision"] == "allow" and pending["event"].is_set()
    finally:
        bridge._pending_approvals.pop("r1", None)


def _gated_fake(received: dict, decision_sink: str = "decision"):
    """A fake run_events that gates one bash call, records the decision it gets
    back, then Finishes."""
    def fake(config, messages, *, namespace=None, session_id=None, working_dir=None, should_stop=None, gate=None):
        received[decision_sink] = yield ToolApprovalRequested("bash", {"command": "ls"})
        yield Finished("completed", "done", 1, session_id, "gemini/test",
                       Usage(input_tokens=1, output_tokens=1), 0.0, {"messages": []})
    return fake


def _run_in_thread_and_resolve(ctx, decision):
    """Run run_lea in a thread, wait for its pending approval, resolve it, join."""
    t = Thread(target=bridge.run_lea, args=(ctx,))
    t.start()
    approval_id = None
    for _ in range(200):  # up to ~4s
        pending = bridge._pending_approvals.get(ctx.run_id)
        if pending:
            approval_id = pending["approval_id"]
            break
        time.sleep(0.02)
    assert approval_id, "run never raised a pending approval"
    assert bridge.resolve_approval(ctx.run_id, approval_id, decision)
    t.join(timeout=5)
    assert not t.is_alive()


def test_approval_relay_allow(tmp_path, monkeypatch):
    ctx, queue = _context(tmp_path, monkeypatch)
    received: dict = {}
    monkeypatch.setattr(bridge, "run_events", _gated_fake(received))

    _run_in_thread_and_resolve(ctx, "allow")

    assert received["decision"] == "allow"  # the decision reached the generator
    assert store.get_run(ctx.run_id)["status"] == "proved"
    types = [i["type"] for i in _drain(queue)]
    assert "approval_requested" in types and "approval_resolved" in types


def test_approval_relay_always_session_updates_allowlist(tmp_path, monkeypatch):
    ctx, queue = _context(tmp_path, monkeypatch)
    bridge._session_allowlists.pop(ctx.session_id, None)
    received: dict = {}
    monkeypatch.setattr(bridge, "run_events", _gated_fake(received))

    _run_in_thread_and_resolve(ctx, "always_session")

    assert received["decision"] == "always_session"
    # the tool is now allow-listed for the rest of the session (D19)
    assert "bash" in bridge._session_allowlists.get(ctx.session_id, set())
    bridge._session_allowlists.pop(ctx.session_id, None)


def _seed_agent_then_user_edit(tmp_path, *, user_edit: bool):
    """A session where the agent wrote a proof; optionally the human then edited it
    out-of-run. Returns (session, run for a new activation)."""
    gs = bridge.GitStore(tmp_path / "workspace" / "proofs")
    session = store.create_session("Divergence")
    repo = gs.init_session(session["id"])
    proof = repo / "Lea" / "Misc" / "P.lean"
    proof.parent.mkdir(parents=True, exist_ok=True)
    proof.write_text("theorem p : True := by trivial\n")
    sha1 = gs.commit_write(session["id"], turn=1, author="agent", tool="write_file")
    run0 = store.create_run(session["id"], "m", None, 3)
    store.add_code_step(session["id"], run0["id"], "Lea/Misc/P.lean", commit_sha=sha1, author="agent", turn=1)
    if user_edit:
        proof.write_text("theorem p : True := by exact trivial\n")
        sha2 = gs.commit_write(session["id"], turn=None, author="user", tool="edit")
        store.add_code_step(session["id"], None, "Lea/Misc/P.lean", commit_sha=sha2, author="user")
        store.add_message(session["id"], "user", "used exact instead", None,
                          kind="edit_note", commit_sha=sha2)
    return session, store.create_run(session["id"], "m", None, 3)


def test_run_start_injects_divergence_diff(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    session, run = _seed_agent_then_user_edit(tmp_path, user_edit=True)
    config = LeaConfig(model="m", max_turns=3, lea_root=tmp_path)
    received: list = []
    monkeypatch.setattr(bridge, "run_events", _recording_fake(received, []))

    bridge.run_lea(bridge.RunnerContext(session["id"], run["id"], "keep going", config, Queue()))

    task_msg = received[0][-1]["content"]
    assert "human edited" in task_msg.lower()
    assert "exact trivial" in task_msg       # the diff (the human's added line)
    assert "used exact instead" in task_msg  # the linked edit note (D11)
    assert task_msg.endswith("keep going")   # the original task is preserved


def test_no_divergence_when_agent_state_is_current(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    session, run = _seed_agent_then_user_edit(tmp_path, user_edit=False)
    config = LeaConfig(model="m", max_turns=3, lea_root=tmp_path)
    received: list = []
    monkeypatch.setattr(bridge, "run_events", _recording_fake(received, []))

    bridge.run_lea(bridge.RunnerContext(session["id"], run["id"], "keep going", config, Queue()))

    # no edits since the agent's last write → the task is passed through untouched
    assert received[0][-1]["content"] == "keep going"


def test_second_concurrent_run_is_rejected(tmp_path, monkeypatch):
    ctx, queue = _context(tmp_path, monkeypatch)
    # hold the lock as if another run were active
    assert bridge.active_run_lock.acquire(blocking=False)
    try:
        bridge.run_lea(ctx)
    finally:
        bridge.active_run_lock.release()

    items = _drain(queue)
    types = [i["type"] for i in items]
    assert types == ["run_error", "done"]
    assert items[-1]["payload"]["status"] == "failed"
