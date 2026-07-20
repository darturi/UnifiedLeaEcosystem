"""The rejoinable run-event broker (v2.3).

The broker replaces the old per-connection queue so a reconnect / session switch
rejoins the LIVE stream instead of a dead 'passive view'. These pin the pure
semantics the endpoint's subscription relies on: monotonic seq, cursor replay,
close-on-done, and the module registry's create/get/drop.
"""

import threading

from app import runbroker
from app.runbroker import RunBroker


def _fresh():
    runbroker._brokers.clear()


def test_put_assigns_monotonic_seq_and_preserves_order():
    b = RunBroker("r1")
    b.put({"type": "message", "payload": {"id": "m1"}})
    b.put({"type": "code_step", "payload": {"id": "c1"}})
    seqs = [e["seq"] for e in b.events_after(0)]
    types = [e["type"] for e in b.events_after(0)]
    assert seqs == [1, 2]
    assert types == ["message", "code_step"]


def test_events_after_is_a_cursor_replay():
    b = RunBroker("r1")
    for i in range(3):
        b.put({"type": "assistant_delta", "payload": {"text": str(i)}})
    # A fresh subscriber (cursor 0) replays everything; a resuming one skips what it saw.
    assert [e["payload"]["text"] for e in b.events_after(0)] == ["0", "1", "2"]
    assert [e["payload"]["text"] for e in b.events_after(1)] == ["1", "2"]
    assert b.events_after(3) == []


def test_late_subscriber_replays_the_whole_buffer():
    # The reattach guarantee: events published before a connection exists are still
    # delivered to it — the exact gap the old passive view left.
    b = RunBroker("r1")
    b.put({"type": "approval_requested", "payload": {"approval_id": "a1"}})
    b.put({"type": "message", "payload": {"id": "m1"}})
    replayed = b.events_after(0)  # a connection that only just arrived
    assert [e["type"] for e in replayed] == ["approval_requested", "message"]


def test_done_closes_the_broker_and_drops_late_events():
    b = RunBroker("r1")
    b.put({"type": "message", "payload": {"id": "m1"}})
    assert not b.closed
    b.put({"type": "done", "payload": {"status": "proved"}})
    assert b.closed
    b.put({"type": "message", "payload": {"id": "late"}})  # after done → ignored
    types = [e["type"] for e in b.events_after(0)]
    assert types == ["message", "done"]  # the late one never landed


def test_registry_create_get_drop():
    _fresh()
    assert runbroker.get("r1") is None
    b = runbroker.create("r1")
    assert runbroker.get("r1") is b
    # create replaces (e.g. a superseded run reusing… actually a fresh run id, but the
    # contract is last-writer-wins for a given id).
    b2 = runbroker.create("r1")
    assert runbroker.get("r1") is b2 and b2 is not b
    runbroker.drop("r1")
    assert runbroker.get("r1") is None
    runbroker.drop("r1")  # idempotent


def test_put_is_thread_safe_under_concurrent_publishers():
    # The driver publishes from a worker thread while the endpoint reads from the loop
    # thread; seqs must stay unique and contiguous even if two threads race put().
    b = RunBroker("r1")

    def spam():
        for _ in range(200):
            b.put({"type": "assistant_delta", "payload": {}})

    threads = [threading.Thread(target=spam) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    seqs = [e["seq"] for e in b.events_after(0)]
    assert seqs == list(range(1, 801)), "seqs must be unique and contiguous under contention"
