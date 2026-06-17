#!/usr/bin/env python3
"""Test the in-process LSP daemon approach against the cold-spawn baseline.

Spawns ONE `lake env lean --server` in FQB, opens multiple Main.lean files
through it in sequence, times each open->diagnostics-done cycle.

Baseline (cold-spawn `lake env lean`, measured earlier):
    GreenTao  (1 import)  : 65.6 s
    BanachStone (3 imports): 88.3 s
    Burnside   (6 imports) : 79.4 s

Expectation with LSP daemon:
    1st open: ~baseline (server has to load oleans first time)
    2nd+    : ~elaboration only (~1-5 s), Mathlib cached in server memory
"""
from __future__ import annotations
import json, os, subprocess, sys, threading, time
from pathlib import Path
from queue import Queue, Empty

FQB = Path("/scratch/spp9399/lean/lea-prover-og/lea-prover/FormalQualBench")
SEQ = [
    ("BanachStoneTheorem",       "cold: 3 topology imports"),
    ("GreenTaoTheorem",          "cold-ish: 1 new light import"),
    ("BanachStoneTheorem",       "warm: same as #1"),
    ("BurnsidePrimeDegreeTheorem", "cold-ish: 6 group-theory imports"),
    ("GreenTaoTheorem",          "warm: same as #2"),
]

# Phase 2: simulate the agent rewriting just the proof body of an already-open
# file. Each entry is (label, new_full_file_content). We send these as
# textDocument/didChange notifications to the SAME document opened in phase 1.
BS_HEADER = """import Mathlib.Topology.ContinuousMap.Algebra
import Mathlib.Topology.ContinuousMap.Compact
import Mathlib.Analysis.Normed.Operator.LinearIsometry

namespace BanachStoneTheorem

/-- Banach-Stone theorem for real-valued continuous functions on compact Hausdorff spaces. -/
theorem MainTheorem (X Y : Type*) [TopologicalSpace X] [CompactSpace X] [T2Space X]
    [TopologicalSpace Y] [CompactSpace Y] [T2Space Y]
    (e : C(X, ℝ) ≃ₗᵢ[ℝ] C(Y, ℝ)) :
    Nonempty (X ≃ₜ Y) := by
"""
BS_FOOTER = "\n\nend BanachStoneTheorem\n"

CHANGES = [
    ("change 1: by sorry (orig)",         BS_HEADER + "  sorry"        + BS_FOOTER),
    ("change 2: by exact ⟨default⟩",     BS_HEADER + "  exact ⟨default⟩" + BS_FOOTER),
    ("change 3: back to sorry",           BS_HEADER + "  sorry"        + BS_FOOTER),
    ("change 4: by trivial (error)",      BS_HEADER + "  trivial"      + BS_FOOTER),
    ("change 5: back to sorry again",     BS_HEADER + "  sorry"        + BS_FOOTER),
]

def encode(msg):
    body = json.dumps(msg).encode("utf-8")
    return f"Content-Length: {len(body)}\r\n\r\n".encode() + body

def reader(stream, q):
    while True:
        headers = {}
        while True:
            line = stream.readline()
            if not line:
                q.put(None); return
            s = line.decode("utf-8").strip()
            if s == "":
                break
            k, _, v = s.partition(":")
            headers[k.strip().lower()] = v.strip()
        n = int(headers.get("content-length", 0))
        body = stream.read(n).decode("utf-8")
        try:
            q.put(json.loads(body))
        except json.JSONDecodeError:
            pass

def drain_stderr(stream):
    for line in iter(stream.readline, b""):
        sys.stderr.write(f"[lean stderr] {line.decode().rstrip()}\n")
        sys.stderr.flush()

def main():
    print(f"[lsp_test] spawning `lake env lean --server` in {FQB}", flush=True)
    t_spawn = time.time()
    proc = subprocess.Popen(
        ["lake", "env", "lean", "--server"],
        cwd=str(FQB),
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        bufsize=0,
    )
    q = Queue()
    threading.Thread(target=reader, args=(proc.stdout, q), daemon=True).start()
    threading.Thread(target=drain_stderr, args=(proc.stderr,), daemon=True).start()
    print(f"[lsp_test] spawned (pid={proc.pid})", flush=True)

    msg_id = [0]
    def nxt():
        msg_id[0] += 1; return msg_id[0]

    # ---- initialize handshake ----
    t = time.time()
    proc.stdin.write(encode({
        "jsonrpc": "2.0", "id": nxt(), "method": "initialize",
        "params": {
            "processId": os.getpid(),
            "rootUri": FQB.as_uri(),
            "capabilities": {"textDocument": {"publishDiagnostics": {}}},
        }
    }))
    proc.stdin.flush()
    while True:
        m = q.get(timeout=120)
        if m is None:
            print("[lsp_test] server died during initialize"); return
        if m.get("id") == 1:
            break
    proc.stdin.write(encode({"jsonrpc": "2.0", "method": "initialized", "params": {}}))
    proc.stdin.flush()
    print(f"[lsp_test] handshake done in {time.time()-t:.2f}s", flush=True)

    timings = []  # phase 1 skipped this run
    # ---- Phase 2: didChange test on BanachStone ----
    bs_path = FQB / "FormalQualBench" / "BanachStoneTheorem" / "Main.lean"
    bs_uri = bs_path.as_uri()
    print("\n[lsp_test] === phase 2: didChange test (keep BanachStone open, mutate body) ===", flush=True)
    # (re-)open with the initial sorry content
    proc.stdin.write(encode({
        "jsonrpc": "2.0", "method": "textDocument/didOpen",
        "params": {"textDocument": {
            "uri": bs_uri, "languageId": "lean4", "version": 100,
            "text": BS_HEADER + "  sorry" + BS_FOOTER
        }}
    }))
    proc.stdin.flush()
    # drain initial elaboration
    t0 = time.time()
    while time.time() - t0 < 600:
        try:
            m = q.get(timeout=2)
        except Empty:
            continue
        if m is None: print("[lsp_test] server died"); return
        if m.get("method") == "$/lean/fileProgress":
            p = m.get("params", {})
            if p.get("textDocument", {}).get("uri") == bs_uri and not p.get("processing"):
                print(f"  initial didOpen completed in {time.time()-t0:.2f}s", flush=True)
                break

    change_timings = []
    OBSERVE_WINDOW = 15.0  # seconds to listen for messages after each didChange
    for j, (label, new_text) in enumerate(CHANGES, 1):
        version = 100 + j
        # drain stale notifications from previous iteration
        drained = 0
        while True:
            try:
                q.get_nowait()
                drained += 1
            except Empty:
                break
        print(f"\n[lsp_test] didChange #{j}: {label}  (drained {drained} stale)", flush=True)

        t0 = time.time()
        proc.stdin.write(encode({
            "jsonrpc": "2.0", "method": "textDocument/didChange",
            "params": {
                "textDocument": {"uri": bs_uri, "version": version},
                "contentChanges": [{"text": new_text}],
            }
        }))
        proc.stdin.flush()

        # Collect all messages for OBSERVE_WINDOW seconds, log timeline.
        # Report time-to-first-publishDiagnostics as the headline metric.
        first_diag_t = None
        first_diag_count = None
        deadline = t0 + OBSERVE_WINDOW
        while time.time() < deadline:
            try:
                m = q.get(timeout=0.5)
            except Empty:
                continue
            if m is None:
                print("[lsp_test] server died"); return
            method = m.get("method")
            params = m.get("params", {})
            elapsed = time.time() - t0
            if method == "textDocument/publishDiagnostics" and params.get("uri") == bs_uri:
                dc = len(params.get("diagnostics", []))
                msgs = [d.get("message", "")[:60] for d in params.get("diagnostics", [])]
                print(f"  [{elapsed:6.2f}s] publishDiagnostics: {dc} diags  {msgs}", flush=True)
                if first_diag_t is None:
                    first_diag_t = elapsed
                    first_diag_count = dc
            elif method == "$/lean/fileProgress" and params.get("textDocument", {}).get("uri") == bs_uri:
                pgs = params.get("processing", [])
                print(f"  [{elapsed:6.2f}s] fileProgress: {len(pgs)} ranges processing", flush=True)
            elif method:
                # other notifications — log briefly
                print(f"  [{elapsed:6.2f}s] {method}", flush=True)

        change_timings.append((j, label, first_diag_t, first_diag_count))
        print(f"  -> first-diagnostic at {first_diag_t}s, count={first_diag_count}", flush=True)

    # close BS doc
    proc.stdin.write(encode({
        "jsonrpc": "2.0", "method": "textDocument/didClose",
        "params": {"textDocument": {"uri": bs_uri}}
    }))
    proc.stdin.flush()

    # ---- shutdown ----
    proc.stdin.write(encode({"jsonrpc": "2.0", "id": nxt(), "method": "shutdown"}))
    proc.stdin.flush()
    time.sleep(0.5)
    proc.stdin.write(encode({"jsonrpc": "2.0", "method": "exit"}))
    proc.stdin.flush()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()

    total = time.time() - t_spawn
    print(f"\n[lsp_test] --- summary (total wall: {total:.1f}s) ---", flush=True)
    print("Phase 1 (didOpen/didClose per file):", flush=True)
    print(f"{'#':>2} {'problem':<32} {'label':<36} {'time(s)':>8}", flush=True)
    for i, name, label, t, dc in timings:
        print(f"{i:>2} {name:<32} {label:<36} {t:>8.2f}", flush=True)
    print("\nPhase 2 (didChange on already-open BanachStone) — time-to-first-publishDiagnostics:", flush=True)
    print(f"{'#':>2} {'label':<40} {'first_diag_s':>14} {'#diag':>6}", flush=True)
    for j, label, t, dc in change_timings:
        tstr = f"{t:.2f}" if t is not None else "—"
        dstr = str(dc) if dc is not None else "—"
        print(f"{j:>2} {label:<40} {tstr:>14} {dstr:>6}", flush=True)
    print("\nbaseline (cold-spawn `lake env lean`) for reference:", flush=True)
    print("  BanachStone=88.3s  GreenTao=65.6s  Burnside=79.4s", flush=True)

if __name__ == "__main__":
    main()
