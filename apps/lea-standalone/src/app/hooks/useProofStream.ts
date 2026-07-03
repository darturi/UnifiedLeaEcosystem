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

  // Close the stream when App unmounts.
  useEffect(() => () => eventSourceRef.current?.close(), []);

  const closeStream = () => {
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

  const attachStream = (runId: string, sessionId: string) => {
    closeStream();
    const source = new EventSource(`/api/runs/${runId}/events`);
    eventSourceRef.current = source;
    const liveId = `live-${runId}`;
    let sawDone = false;
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
      const seq = lastSeqRef.current + 0.5 + approvalCounterRef.current * 1e-4;
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

    source.onerror = async () => {
      if (eventSourceRef.current !== source || source.readyState === EventSource.CLOSED) return;
      if (sawDone) {
        source.close();
        eventSourceRef.current = null;
        return;
      }
      source.close();
      eventSourceRef.current = null;
      setIsRunning(false);
      setCurrentRunId(undefined);
      try {
        const detail = await getSession(sessionId);
        applyDetail(detail);
        await useSessions.getState().refreshSessions();
        if (detail.active_run) setError('Lost connection to the Lea backend.');
      } catch {
        setError('Lost connection to the Lea backend.');
      }
    };
  };

  return { attachStream, applyDetail, reconcile, closeStream };
}
