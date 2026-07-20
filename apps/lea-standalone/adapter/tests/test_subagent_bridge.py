"""Bridge sub-agent handling (v2.3 item 24): enablement + SubagentFinished → child session.

These pin the adapter side of sub-agents, without a live prover run:

  * `_with_subagents` adds the opt-in `spawn_subagent` onto the coordinator's default
    toolset (and nothing else changes);
  * `_text_from_content` flattens both a plain string and a provider block list to prose;
  * `_materialize_subagent` creates a CHILD session (parent_id / role / spawned_at_turn),
    replays the child transcript into the child's own timeline, and stores the candidate
    as a code_step so the child's DERIVED status is its lean_check verdict;
  * a missing/unreadable candidate is tolerated (child still lands, just unchecked);
  * the child transcript never lands on the PARENT's timeline.
"""

from pathlib import Path
from queue import Queue

from lea.interface import (
    AssistantTextDelta,
    CheckResult,
    FileChanged,
    Finished,
    SubagentFinished,
    ToolCalled,
    TurnStarted,
)
from lea.providers import Usage

from app import bridge, db, store
from app.config import LeaConfig


def _ok_recheck(monkeypatch):
    """Stub the canonical-path re-verification so promotion tests need no Lean env."""
    monkeypatch.setattr(bridge, "_lean_check_file", lambda path: CheckResult(path, "ok", None))


def _drain(q: Queue) -> list[dict]:
    items = []
    while not q.empty():
        items.append(q.get_nowait())
    return items


def _fresh_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()


_OK_CANDIDATE = "import Mathlib\ntheorem t : True := by trivial\n"


def _finished(candidate_path=None, check_status="ok", check_detail=None,
              summary="parity / infinite descent works", transcript=None):
    return SubagentFinished(
        result_id="proof-candidate-abc123",
        subagent_type="proof-candidate",
        candidate_path=candidate_path,
        check_status=check_status,
        check_detail=check_detail,
        stop_reason="completed",
        summary=summary,
        transcript=transcript if transcript is not None else [
            {"role": "user", "content": "Prove it via infinite descent."},
            {"role": "assistant", "content": "Trying descent…"},
            {"role": "assistant", "content": [{"type": "text", "text": "It compiles."},
                                              {"type": "tool_call", "name": "lean_check"}]},
        ],
    )


# --- enablement ---------------------------------------------------------------

def test_with_subagents_adds_spawn_to_default_toolset():
    cfg = LeaConfig(model="gemini/test", max_turns=3)
    out = bridge._with_subagents(cfg)
    assert out.tools is not None
    assert "spawn_subagent" in out.tools
    # the six built-ins are still there, spawn_subagent appended
    assert {"read_file", "write_file", "edit_file", "lean_check", "bash", "search_mathlib"} <= set(out.tools)
    assert out.tools[-1] == "spawn_subagent"
    # nothing else about the config changed
    assert out.model == cfg.model and out.max_turns == cfg.max_turns


# --- text flattening ----------------------------------------------------------

def test_text_from_content_handles_string_and_blocks():
    assert bridge._text_from_content("hello") == "hello"
    blocks = [{"type": "text", "text": "line one"}, {"type": "tool_call", "name": "x"},
              {"type": "text", "text": "line two"}]
    assert bridge._text_from_content(blocks) == "line one\nline two"
    assert bridge._text_from_content(None) == ""
    assert bridge._text_from_content([{"type": "tool_call", "name": "x"}]) == ""


def test_child_title_prefers_task_over_error_summary():
    # A max-turns / errored child's summary is an error nudge — the title must come from
    # the delegated task instead (regression from the first live spawn).
    ev = _finished(
        summary="Error: max turns reached without completing the proof",
        transcript=[
            {"role": "user", "content": "Search block imprimitivity lemmas\n\nYou are a scout."},
            {"role": "assistant", "content": "searching Mathlib…"},
        ],
    )
    assert bridge._subagent_child_title(ev) == "Search block imprimitivity lemmas"


# --- materialization ----------------------------------------------------------

def test_materialize_creates_child_with_tree_fields(tmp_path, monkeypatch):
    _fresh_db(tmp_path, monkeypatch)
    parent = store.create_session("Prove sqrt2 irrational")
    ev = _finished()
    child = bridge._materialize_subagent(
        ev, parent_session_id=parent["id"], project_id=None, turn=4, repo=tmp_path,
    )
    assert child["parent_id"] == parent["id"]
    assert child["role"] == "proof-candidate"
    assert child["spawned_at_turn"] == 4
    # title comes from the delegated task (first user message), not the summary
    assert child["title"] == "Prove it via infinite descent."


def test_materialize_replays_transcript_as_child_messages(tmp_path, monkeypatch):
    _fresh_db(tmp_path, monkeypatch)
    parent = store.create_session("root")
    child = bridge._materialize_subagent(
        _finished(), parent_session_id=parent["id"], project_id=None, turn=1, repo=tmp_path,
    )
    detail = store.session_detail(child["id"])
    contents = [m["content"] for m in detail["messages"]]
    assert "Prove it via infinite descent." in contents   # the user task
    assert "Trying descent…" in contents                  # an assistant step
    assert "It compiles." in contents                     # text pulled from a block list
    # The PARENT timeline is untouched — the child transcript is the child's, not a
    # coordinator code_step.
    parent_detail = store.session_detail(parent["id"])
    assert parent_detail["messages"] == []
    assert parent_detail["code_steps"] == []


def test_materialize_stores_candidate_and_derives_status(tmp_path, monkeypatch):
    _fresh_db(tmp_path, monkeypatch)
    parent = store.create_session("root")
    # the candidate lives in the child's scratch under the run's working tree
    scratch = tmp_path / ".lea" / "tmp" / "run" / "agent"
    scratch.mkdir(parents=True)
    (scratch / "Sqrt2.lean").write_text(_OK_CANDIDATE)
    ev = _finished(candidate_path=".lea/tmp/run/agent/Sqrt2.lean", check_status="ok")
    child = bridge._materialize_subagent(
        ev, parent_session_id=parent["id"], project_id=None, turn=2, repo=tmp_path,
    )
    detail = store.session_detail(child["id"])
    assert len(detail["code_steps"]) == 1
    step = detail["code_steps"][0]
    assert step["code"] == _OK_CANDIDATE
    assert step["check_status"] == "ok"
    # the child's derived session status reflects the candidate's verdict, not 'empty'
    assert detail["status"] in ("ok", "proved", "defined")


def test_materialize_tolerates_missing_candidate(tmp_path, monkeypatch):
    _fresh_db(tmp_path, monkeypatch)
    parent = store.create_session("root")
    ev = _finished(candidate_path=".lea/tmp/run/agent/gone.lean", check_status="error",
                   check_detail="boom")
    child = bridge._materialize_subagent(
        ev, parent_session_id=parent["id"], project_id=None, turn=1, repo=tmp_path,
    )
    detail = store.session_detail(child["id"])
    assert detail["code_steps"] == []          # unreadable candidate → no code step
    assert len(detail["messages"]) >= 1        # but the child still landed with its transcript


# --- end-to-end through the real bridge loop ----------------------------------

def test_run_lea_materializes_child_and_emits_sse(tmp_path, monkeypatch):
    # Drive the real run_lea event loop with a fake prover that delegates to a child.
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    session = store.create_session("Prove sqrt2 irrational")
    run = store.create_run(session["id"], "gemini/test", None, 3)
    cfg = LeaConfig(model="gemini/test", max_turns=3, lea_root=tmp_path)
    queue: Queue = Queue()
    ctx = bridge.RunnerContext(
        session_id=session["id"], run_id=run["id"],
        task="Prove sqrt2 irrational", config=cfg, events=queue,
    )

    def fake(config, messages, *, namespace=None, session_id=None, working_dir=None,
             should_stop=None, gate=None):
        # the child writes its candidate into its scratch under the run's working tree
        scratch = Path(working_dir) / ".lea" / "tmp" / "run" / "agent"
        scratch.mkdir(parents=True, exist_ok=True)
        (scratch / "Sqrt2.lean").write_text(_OK_CANDIDATE)
        yield TurnStarted(1)
        yield AssistantTextDelta("I'll delegate a candidate.")
        yield SubagentFinished(
            result_id="proof-candidate-xyz", subagent_type="proof-candidate",
            candidate_path=".lea/tmp/run/agent/Sqrt2.lean", check_status="ok", check_detail=None,
            stop_reason="completed", summary="parity approach compiles",
            transcript=[{"role": "user", "content": "prove it"},
                        {"role": "assistant", "content": "done, it compiles"}],
        )
        yield Finished("completed", "A candidate compiled.", 1, ctx.session_id,
                       "gemini/test", Usage(input_tokens=5, output_tokens=3), 0.0, {})

    _ok_recheck(monkeypatch)  # the coordinator delegated + wrote nothing → promotion fires
    monkeypatch.setattr(bridge, "run_events", fake)
    bridge.run_lea(ctx)

    # a child session was created under the coordinator, with its verdict-derived status
    kids = store.list_child_sessions(session["id"])
    assert len(kids) == 1
    child = kids[0]
    assert child["parent_id"] == session["id"] and child["role"] == "proof-candidate"
    cdetail = store.session_detail(child["id"])
    assert cdetail["code_steps"] and cdetail["code_steps"][0]["check_status"] == "ok"
    assert any("done, it compiles" in m["content"] for m in cdetail["messages"])

    # collation promoted the winning candidate onto the PARENT session (item 25): the
    # coordinator delegated and wrote no proof itself, so the winner fills the gap.
    pdetail = store.session_detail(session["id"])
    promoted = [s for s in pdetail["code_steps"] if s["path"] == "Lea/Misc/Sqrt2.lean"]
    assert len(promoted) == 1 and promoted[0]["check_status"] == "ok"
    assert pdetail["status"] == "proved"                       # derived from the promoted proof

    # the SSE stream carried a subagent_finished event + a promoted status
    events = _drain(queue)
    subagent_events = [e for e in events if e["type"] == "subagent_finished"]
    assert len(subagent_events) == 1
    assert subagent_events[0]["payload"]["child_id"] == child["id"]
    assert subagent_events[0]["payload"]["parent_id"] == session["id"]
    assert subagent_events[0]["payload"]["check_status"] == "ok"
    assert any(e["type"] == "status" and e["payload"].get("status") == "promoted" for e in events)


def test_promote_winner_writes_canonical_reverifies_and_links_provenance(tmp_path, monkeypatch):
    import sqlite3

    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    _ok_recheck(monkeypatch)
    session = store.create_session("root")
    run = store.create_run(session["id"], "gemini/test", None, 3)
    repo = tmp_path / "repo"
    scratch = repo / ".lea" / "tmp" / "run" / "agent"
    scratch.mkdir(parents=True)
    (scratch / "Win.lean").write_text(_OK_CANDIDATE)
    ev = _finished(candidate_path=".lea/tmp/run/agent/Win.lean", check_status="ok")

    step = bridge._promote_winner(
        [ev], session_id=session["id"], run_id=run["id"],
        repo=repo, namespace=None, turn=2, events=Queue(),
    )
    assert step is not None
    # winner bytes written to the canonical proofs dir (loose → Lea/Misc)
    assert (repo / "Lea" / "Misc" / "Win.lean").read_text() == _OK_CANDIDATE
    assert step["path"] == "Lea/Misc/Win.lean" and step["check_status"] == "ok"
    # recorded on the PARENT session, deriving it 'proved'
    detail = store.session_detail(session["id"])
    assert detail["status"] == "proved"
    # provenance links the promoted step back to the child result (item 25)
    with sqlite3.connect(tmp_path / "test.sqlite3") as conn:
        data = conn.execute(
            "select data from timeline where path = 'Lea/Misc/Win.lean'"
        ).fetchone()[0]
    assert ev.result_id in data and "promoted_from" in data


def test_promote_winner_skips_when_no_clean_candidate(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    _ok_recheck(monkeypatch)  # recheck would pass, but an error candidate isn't promotable
    session = store.create_session("root")
    run = store.create_run(session["id"], "gemini/test", None, 3)
    ev = _finished(candidate_path=".lea/tmp/run/agent/Bad.lean", check_status="error",
                   check_detail="boom")
    step = bridge._promote_winner(
        [ev], session_id=session["id"], run_id=run["id"],
        repo=tmp_path / "repo", namespace=None, turn=1, events=Queue(),
    )
    assert step is None
    assert store.session_detail(session["id"])["code_steps"] == []


def test_promote_winner_skips_when_reverify_fails(tmp_path, monkeypatch):
    # the child's candidate compiled in scratch, but it does NOT re-verify at the
    # canonical path → nothing is promoted (never record an unchecked 'ok').
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    monkeypatch.setattr(bridge, "_lean_check_file", lambda p: CheckResult(p, "error", "moved-module boom"))
    session = store.create_session("root")
    run = store.create_run(session["id"], "gemini/test", None, 3)
    repo = tmp_path / "repo"
    scratch = repo / ".lea" / "tmp" / "run" / "agent"
    scratch.mkdir(parents=True)
    (scratch / "Win.lean").write_text(_OK_CANDIDATE)
    ev = _finished(candidate_path=".lea/tmp/run/agent/Win.lean", check_status="ok")
    step = bridge._promote_winner(
        [ev], session_id=session["id"], run_id=run["id"],
        repo=repo, namespace=None, turn=1, events=Queue(),
    )
    assert step is None
    assert store.session_detail(session["id"])["code_steps"] == []


def test_run_lea_does_not_promote_over_a_clean_coordinator_proof(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    _ok_recheck(monkeypatch)
    session = store.create_session("Prove it")
    run = store.create_run(session["id"], "gemini/test", None, 3)
    cfg = LeaConfig(model="gemini/test", max_turns=3, lea_root=tmp_path)
    ctx = bridge.RunnerContext(
        session_id=session["id"], run_id=run["id"], task="Prove it", config=cfg, events=Queue(),
    )

    def fake(config, messages, *, namespace=None, session_id=None, working_dir=None,
             should_stop=None, gate=None):
        proof = Path(working_dir) / "Lea" / "Misc" / "Main.lean"
        proof.parent.mkdir(parents=True, exist_ok=True)
        proof.write_text(_OK_CANDIDATE)
        scratch = Path(working_dir) / ".lea" / "tmp" / "run" / "agent"
        scratch.mkdir(parents=True, exist_ok=True)
        (scratch / "Cand.lean").write_text(_OK_CANDIDATE)
        yield TurnStarted(1)
        yield ToolCalled("write_file", {"path": str(proof)})
        yield FileChanged(str(proof))
        yield ToolCalled("lean_check", {"path": str(proof)})
        yield CheckResult(str(proof), "ok", None)   # coordinator produced a clean proof
        yield SubagentFinished(
            result_id="pc-1", subagent_type="proof-candidate",
            candidate_path=".lea/tmp/run/agent/Cand.lean", check_status="ok", check_detail=None,
            stop_reason="completed", summary="also compiles", transcript=[],
        )
        yield Finished("completed", "Proved it.", 1, ctx.session_id, "gemini/test",
                       Usage(input_tokens=1, output_tokens=1), 0.0, {})

    monkeypatch.setattr(bridge, "run_events", fake)
    bridge.run_lea(ctx)

    # only the coordinator's own proof — the child candidate is NOT promoted over it
    detail = store.session_detail(session["id"])
    assert [s["path"] for s in detail["code_steps"]] == ["Lea/Misc/Main.lean"]


def test_autonomous_run_does_not_enable_subagents(tmp_path, monkeypatch):
    # Overleaf/autonomous runs stay single-agent — spawn_subagent is not added.
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()
    session = store.create_session("auto")
    run = store.create_run(session["id"], "gemini/test", None, 3)
    cfg = LeaConfig(model="gemini/test", max_turns=3, lea_root=tmp_path)
    seen_tools = {}
    ctx = bridge.RunnerContext(
        session_id=session["id"], run_id=run["id"], task="auto",
        config=cfg, events=Queue(), autonomous=True,
    )

    def fake(config, messages, *, namespace=None, session_id=None, working_dir=None,
             should_stop=None, gate=None):
        seen_tools["tools"] = config.tools
        yield Finished("completed", "done", 1, ctx.session_id, "gemini/test",
                       Usage(input_tokens=1, output_tokens=1), 0.0, {})

    monkeypatch.setattr(bridge, "run_events", fake)
    bridge.run_lea(ctx)
    # autonomous keeps the prover default (None) — no spawn_subagent forced on
    assert seen_tools["tools"] is None
