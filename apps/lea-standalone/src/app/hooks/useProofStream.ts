import { useEffect, useRef } from 'react';
import {
  getSession,
  type ChatMessage,
  type CodeStep,
  type PendingApproval,
  type RunStatus,
  type SessionDetail,
  type StatusEvent,
} from '../lib/api';
import { useProofSession } from '../stores/proofSession';
import { useSessions } from '../stores/sessions';
import { sortCodeSteps } from '../lib/timeline.mjs';
import { mainFileIndex } from '../lib/canvasFiles.mjs';

// SSE reattach backoff (v2.3 item 14). A browser EventSource cannot read an HTTP
// status — a 409 (server at capacity / a run driven elsewhere) surfaces only as
// `onerror`, identical to a dropped connection. Without a delay+cap the reattach
// loop becomes an unthrottled request storm the moment the server can 409, which
// is exactly the blocker for raising LEA_MAX_CONCURRENT_RUNS. Exponential backoff
// with jitter (1s→2s→4s…, capped at 15s) over a bounded number of attempts mirrors
// the Overleaf companion's already-proven retry loop.
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const RECONNECT_MAX_ATTEMPTS = 20;

// Decorrelated-ish jitter: full exponential value minus up to 25%, so a fleet of
// tabs that all dropped at once don't resynchronize onto the same retry tick.
function reconnectDelay(attempt: number): number {
  const exp = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (attempt - 1));
  return exp * 0.75 + Math.random() * exp * 0.25;
}

/**
 * useProofStream — owns the run EventSource lifecycle (v2.0.1 R2).
 *
 * Subscribes to a run's SSE stream and writes every event into the proofSession
 * store, applies a fetched session detail, and reconciles after a run ends. The
 * session-list/selection bits it can't own (those live in App's `useState`) are
 * passed in. Everything it writes goes through `useProofSession.getState()`, so
 * there are no stale-closure hazards in the async event handlers.
 *
 * Returns the imperative entry points App drives: `attachStream` (start
 * streaming a run), `applyDetail` (hydrate from a session detail), and
 * `closeStream` (tear down before a session switch / new session).
 */
export function useProofStream() {
  const eventSourceRef = useRef<EventSource | null>(null);
  // Highest seq seen + a counter, so an approval (which has no server seq) can be
  // stamped with a synthetic seq just after the latest item — interleaving it
  // into the thread at the point it actually happened, before the step it gates.
  const lastSeqRef = useRef(0);
  const approvalCounterRef = useRef(0);
  // Item 14 backoff state: consecutive failed reattach attempts, keyed by run so a
  // session switch to a different run starts backoff fresh (rather than inheriting
  // the previous run's count) while consecutive failures for the SAME run keep
  // growing. Reset on a successful open. Plus the pending backoff timer, so a
  // session switch can cancel an in-flight reconnect.
  const reconnectRef = useRef<{ runId: string; count: number }>({ runId: '', count: 0 });
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Close the stream when App unmounts.
  useEffect(() => () => {
    if (reconnectTimerRef.current !== null) clearTimeout(reconnectTimerRef.current);
    eventSourceRef.current?.close();
  }, []);

  const closeStream = () => {
    // Cancel any pending backoff so a switched-away run can't reconnect underneath
    // the newly-opened session. Attempt count is left to reset on a real open (or
    // a fresh user-initiated attach that opens), so it survives across reattach
    // cycles and the backoff actually grows.
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    useProofSession.getState().setReconnecting(undefined);
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  };

  const applyDetail = (detail: SessionDetail) => {
    const {
      setMessages,
      setCodeSteps,
      setStatusEvents,
      setCodeIndex,
      setError,
      setCurrentRunId,
      setIsRunning,
      setRunStatus,
      setApprovals,
      setApprovalBusy,
      setRunStatusById,
      setRunResultKindById,
      setEditedPath,
      setSafeVerify,
      setVerifySurface,
      setGoalSurface,
    } = useProofSession.getState();
    useSessions.getState().setSelectedSessionId(detail.id);
    setMessages(detail.messages);
    setCodeSteps(detail.code_steps);
    setStatusEvents(detail.status_events || []);
    // Open on the main proof's latest snapshot, not the absolute last step — so a
    // session that ended on a throwaway `scratch` probe still shows the proof (#10).
    // (Live runs still auto-follow new steps below.)
    const sortedForOpen = sortCodeSteps(detail.code_steps);
    const openIndex = mainFileIndex(sortedForOpen);
    setCodeIndex(openIndex >= 0 ? openIndex : Math.max(0, sortedForOpen.length - 1));
    lastSeqRef.current = Math.max(
      0,
      ...detail.messages.map((m) => m.seq ?? 0),
      ...detail.code_steps.map((c) => c.seq ?? 0),
    );
    setError(undefined);
    const active = detail.active_run;
    setCurrentRunId(active?.id);
    setIsRunning(Boolean(active));
    setRunStatus((active?.status as RunStatus) || undefined);
    setApprovals(
      active?.pending_approval
        ? [
            {
              ...active.pending_approval,
              session_id: detail.id,
              run_id: active.id,
              decision: null,
              seq: lastSeqRef.current + 0.5,
            },
          ]
        : [],
    );
    setApprovalBusy(false);
    const statuses: Record<string, string> = {};
    const resultKinds: Record<string, string | null | undefined> = {};
    for (const r of detail.runs || []) {
      statuses[r.id] = r.status;
      resultKinds[r.id] = r.result_kind;
    }
    if (active) {
      statuses[active.id] = active.status;
      resultKinds[active.id] = active.result_kind;
    }
    setRunStatusById(statuses);
    setRunResultKindById(resultKinds);
    setEditedPath(undefined);
    setSafeVerify(detail.safe_verify || null);
    setVerifySurface(null);
    setGoalSurface(null);
    if (active && (active.status === 'running' || active.status === 'pending')) {
      attachStream(active.id, detail.id);
    }
  };

  const reconcile = async (sessionId: string) => {
    const detail = await getSession(sessionId);
    // The store is the live source of truth (no stale-closure issue), so read the
    // just-finished status straight from it and re-apply it after applyDetail
    // (which would otherwise clear it, since the run is no longer active).
    const finished = useProofSession.getState().runStatus;
    const currentRunId = useProofSession.getState().currentRunId;
    const finishedResultKind = currentRunId
      ? useProofSession.getState().runResultKindById[currentRunId]
      : undefined;
    applyDetail(detail);
    if (finished) useProofSession.getState().setRunStatus(finished);
    if (currentRunId && finishedResultKind) {
      useProofSession.getState().setRunResultKindById((prev) => ({
        ...prev,
        [currentRunId]: finishedResultKind,
      }));
    }
  };

  // Item 14: reconnect a dropped/erroring run stream with capped exponential
  // backoff instead of hammering. Re-fetches the session detail (the persisted
  // source of truth) and lets applyDetail reattach if the run is still live;
  // settles quietly if it finished while we were away; gives up with an error
  // banner past the attempt cap. Reads setters via getState() to stay stale-free.
  const scheduleReconnect = (runId: string, sessionId: string) => {
    const { setReconnecting, setError, setIsRunning, setCurrentRunId } =
      useProofSession.getState();
    const prev = reconnectRef.current;
    const attempt = prev.runId === runId ? prev.count + 1 : 1;
    reconnectRef.current = { runId, count: attempt };
    if (attempt > RECONNECT_MAX_ATTEMPTS) {
      reconnectRef.current = { runId: '', count: 0 };
      setReconnecting(undefined);
      setIsRunning(false);
      setCurrentRunId(undefined);
      setError('Lost connection to the Lea backend.');
      return;
    }
    setReconnecting(`Reconnecting to the live run… (attempt ${attempt}/${RECONNECT_MAX_ATTEMPTS})`);
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      getSession(sessionId)
        .then((detail) => {
          const active = detail.active_run;
          if (active && (active.status === 'running' || active.status === 'pending')) {
            // Still live → applyDetail reattaches; the new stream's onopen resets
            // the backoff. Attempt count is intentionally left to grow until then,
            // so a run held off by a 409 keeps backing off across cycles.
            applyDetail(detail);
          } else {
            // Finished (or vanished) while we were away → settle cleanly.
            reconnectRef.current = { runId: '', count: 0 };
            setReconnecting(undefined);
            applyDetail(detail);
            useSessions.getState().refreshSessions().catch(() => {});
          }
        })
        .catch(() => scheduleReconnect(runId, sessionId));
    }, reconnectDelay(attempt));
  };

  const attachStream = (runId: string, sessionId: string) => {
    closeStream();
    const source = new EventSource(`/api/runs/${runId}/events`);
    eventSourceRef.current = source;
    const liveId = `live-${runId}`;
    let sawDone = false;

    // A real open means any prior backoff succeeded: reset it and drop the
    // reconnecting chip, so a later drop starts fresh from the base delay.
    source.onopen = () => {
      reconnectRef.current = { runId, count: 0 };
      useProofSession.getState().setReconnecting(undefined);
    };
    const {
      setMessages,
      setCodeSteps,
      setCodeIndex,
      setStatusEvents,
      setApprovals,
      setApprovalBusy,
      setIsRunning,
      setRunStatus,
      setRunStatusById,
      setRunResultKindById,
      setCurrentRunId,
      setError,
    } = useProofSession.getState();

    source.addEventListener('assistant_delta', (event) => {
      const { text } = JSON.parse((event as MessageEvent).data) as { text: string };
      setMessages((current) => {
        const existing = current.find((m) => m.id === liveId);
        if (existing) {
          return current.map((m) => (m.id === liveId ? { ...m, content: m.content + text } : m));
        }
        return [
          ...current,
          {
            id: liveId,
            session_id: sessionId,
            run_id: runId,
            role: 'assistant',
            content: text,
            created_at: new Date().toISOString(),
            live: true,
          } as ChatMessage,
        ];
      });
    });

    source.addEventListener('message', (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as ChatMessage;
      if (typeof payload.seq === 'number') lastSeqRef.current = Math.max(lastSeqRef.current, payload.seq);
      setMessages((current) => {
        const live = current.find((m) => m.id === liveId);
        const replacesLive =
          payload.role === 'assistant' &&
          !!live &&
          (payload.content.includes(live.content) || live.content.includes(payload.content));
        const base = replacesLive ? current.filter((m) => m.id !== liveId) : current;
        if (base.some((m) => m.id === payload.id)) return base;
        return [...base, payload];
      });
    });

    source.addEventListener('code_step', (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as CodeStep;
      if (typeof payload.seq === 'number') lastSeqRef.current = Math.max(lastSeqRef.current, payload.seq);
      const current = useProofSession.getState().codeSteps;
      if (current.some((s) => s.id === payload.id)) {
        setCodeSteps(current.map((s) => (s.id === payload.id ? { ...s, ...payload } : s)));
      } else {
        const next = sortCodeSteps([...current, payload]);
        setCodeSteps(next);
        const idx = next.findIndex((s) => s.id === payload.id);
        if (idx >= 0) setCodeIndex(idx);
      }
    });

    source.addEventListener('status', (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as Partial<StatusEvent>;
      setStatusEvents((current) => [
        ...current,
        {
          id: payload.id || `${runId}-${current.length}-${Date.now()}`,
          session_id: payload.session_id || sessionId,
          run_id: payload.run_id || runId,
          status: payload.status || null,
          message: payload.message || payload.status || 'status update',
          turn: payload.turn ?? null,
          check_status: payload.check_status ?? null,
          check_detail: payload.check_detail ?? null,
          created_at: payload.created_at || new Date().toISOString(),
        },
      ]);
    });

    source.addEventListener('approval_requested', (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as PendingApproval;
      approvalCounterRef.current += 1;
      // The gate must sort BELOW everything currently rendered — it's the pending next
      // action. `lastSeqRef` alone lags: the gate fires on write_file *before* this turn's
      // assistant text / resulting code_step are persisted, so those land at higher DB
      // seqs and the gate (stamped only against the previous frontier) would render ABOVE
      // the last write box. Stamp against the true max seq across all known content.
      const state = useProofSession.getState();
      const maxKnown = Math.max(
        lastSeqRef.current,
        ...state.messages.map((m) => (typeof m.seq === 'number' ? m.seq : 0)),
        ...state.codeSteps.map((c) => (typeof c.seq === 'number' ? c.seq : 0)),
      );
      const seq = maxKnown + 0.5 + approvalCounterRef.current * 1e-4;
      setApprovals((prev) =>
        prev.some((a) => a.approval_id === payload.approval_id)
          ? prev
          : [...prev, { ...payload, session_id: sessionId, run_id: runId, decision: null, seq }],
      );
      setApprovalBusy(false);
    });

    source.addEventListener('approval_resolved', (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { approval_id?: string; decision?: string };
      setApprovals((prev) =>
        prev.map((a) =>
          a.approval_id === payload.approval_id ? { ...a, decision: payload.decision || 'resolved' } : a,
        ),
      );
      setApprovalBusy(false);
    });

    source.addEventListener('subagent_started', () => {
      // D1: a child sub-agent was just spawned and the adapter has persisted it as a
      // RUNNING child session (a running run row → derived status 'running'). Refresh so
      // it lands in the store: the sidebar's Sub-agents block and the parent thread's
      // spawn node render it live as 'exploring…' instead of nothing until it finishes.
      // Same session-list-is-the-source-of-truth path as subagent_finished.
      useSessions.getState().refreshSessions().catch(() => {});
    });

    source.addEventListener('subagent_progress', (event) => {
      // E1: a running child emitted one of its own steps. Fold it into that child's
      // ephemeral live state (rendered on its spawn-node row) so the user watches it
      // work — text streams, the current tool + latest check show. Visibility only; the
      // durable transcript still lands on finish.
      const data = (event as MessageEvent).data;
      if (!data) return;
      let p: { child_id?: string; kind?: string; text?: string; tool?: string; status?: string; turn?: number };
      try {
        p = JSON.parse(data);
      } catch {
        return;
      }
      const childId = p.child_id;
      if (!childId) return;
      useProofSession.getState().setSubagentProgress((prev) => {
        const cur = prev[childId] || { text: '' };
        let next = cur;
        if (p.kind === 'text') next = { ...cur, text: cur.text + (p.text || '') };
        else if (p.kind === 'turn') next = { ...cur, text: '', turn: p.turn, tool: undefined };
        else if (p.kind === 'tool') next = { ...cur, tool: p.tool };
        else if (p.kind === 'check') next = { ...cur, check: p.status, tool: undefined };
        else return prev;
        return { ...prev, [childId]: next };
      });
    });

    source.addEventListener('subagent_finished', (event) => {
      // A child sub-agent finished and the adapter has already persisted it as its own
      // session (item 24). Refresh the list so the child lands in the store — the
      // sidebar's Sub-agents block and the parent thread's spawn node both derive from
      // it. The session list is the source of truth; also drop the child's ephemeral live
      // state now the durable transcript takes over (E1).
      const data = (event as MessageEvent).data;
      if (data) {
        try {
          const childId = (JSON.parse(data) as { child_id?: string }).child_id;
          if (childId) {
            useProofSession.getState().setSubagentProgress((prev) => {
              if (!(childId in prev)) return prev;
              const next = { ...prev };
              delete next[childId];
              return next;
            });
          }
        } catch {
          /* ignore a malformed payload — the refresh below still runs */
        }
      }
      useSessions.getState().refreshSessions().catch(() => {});
    });

    source.addEventListener('run_error', (event) => {
      const data = (event as MessageEvent).data;
      if (!data) return;
      const payload = JSON.parse(data) as { message?: string };
      setError(payload.message || 'Lea reported an error.');
    });

    source.addEventListener('done', (event) => {
      sawDone = true;
      source.close();
      eventSourceRef.current = null;
      let status: RunStatus = 'proved';
      let resultKind: string | null | undefined;
      try {
        const payload = JSON.parse((event as MessageEvent).data || '{}');
        status = (payload.status as RunStatus) || 'proved';
        resultKind = payload.result_kind;
      } catch {
        /* keep default */
      }
      setIsRunning(false);
      setRunStatus(status);
      setRunStatusById((prev) => ({ ...prev, [runId]: status }));
      setRunResultKindById((prev) => ({ ...prev, [runId]: resultKind }));
      setCurrentRunId(undefined);
      setApprovals((prev) => prev.filter((a) => a.decision));
      setApprovalBusy(false);
      reconcile(sessionId)
        .then(() => useSessions.getState().refreshSessions())
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    });

    source.onerror = () => {
      // Ignore errors from a stream we've already replaced/closed, and the benign
      // error that follows a normal `done` close.
      if (eventSourceRef.current !== source) return;
      if (sawDone) {
        source.close();
        eventSourceRef.current = null;
        return;
      }
      // Both a transient drop (readyState CONNECTING, which the browser would
      // retry immediately and uncapped) and a hard close / 409 (readyState CLOSED,
      // which it would not retry at all) funnel through our own backoff: close the
      // native source and schedule a capped, jittered reattempt. isRunning stays
      // true — the run is still live server-side; the reconnecting chip is the
      // honest signal while we wait.
      source.close();
      eventSourceRef.current = null;
      scheduleReconnect(runId, sessionId);
    };
  };

  return { attachStream, applyDetail, reconcile, closeStream };
}
