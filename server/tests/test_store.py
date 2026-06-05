from app import db, store


def test_session_messages_and_code_steps_persist(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.sqlite3")
    db.init_db()

    session = store.create_session("Prove 2 + 2 = 4")
    run = store.create_run(session["id"], "gpt-4o", "openai", 3)
    message = store.add_message(session["id"], "user", "Prove 2 + 2 = 4", run["id"])
    step = store.add_code_step(
        session["id"],
        run["id"],
        "workspace/proofs/test.lean",
        "theorem t : 2 + 2 = 4 := by\n  norm_num",
        kind="no_code",
        summary="Turn 2: no tool calls and no Lean file changes.",
        turn=2,
    )
    status_event = store.add_status_event(
        session["id"],
        run["id"],
        "Captured Lean file update: workspace/proofs/test.lean",
        status="code_step",
        step_number=step["step_number"],
    )

    detail = store.session_detail(session["id"])

    assert detail is not None
    assert detail["messages"][0]["id"] == message["id"]
    assert detail["code_steps"][0]["id"] == step["id"]
    assert detail["code_steps"][0]["step_number"] == 1
    assert detail["code_steps"][0]["kind"] == "no_code"
    assert detail["code_steps"][0]["summary"].startswith("Turn 2")
    assert detail["code_steps"][0]["turn"] == 2
    assert detail["status_events"][0]["id"] == status_event["id"]
    assert detail["status_events"][0]["step_number"] == 1
    assert detail["status_events"][0]["status"] == "code_step"
