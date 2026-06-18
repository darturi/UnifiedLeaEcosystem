import { useEffect, useMemo, useRef, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatThread } from './components/ChatThread';
import { Canvas, type CheckOutcome } from './components/Canvas';
import { StatsPage } from './components/StatsPage';
import { SettingsPage } from './components/SettingsPage';
import { buildTimeline, sortCodeSteps } from './timeline.mjs';
import {
  type ApprovalDecision,
  type ChatMessage,
  type CodeStep,
  type PendingApproval,
  type RunStatus,
  type SessionDetail,
  type SessionSummary,
  type StatusEvent,
  createRun,
  getSession,
  getSettings,
  interruptRun,
  leanCheckSession,
  listSessions,
  submitApproval,
  verifySession,
  writeSessionFile,
} from './api';

const SELECTED_SESSION_KEY = 'lea:selectedSessionId';

export default function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [codeSteps, setCodeSteps] = useState<CodeStep[]>([]);
  const [statusEvents, setStatusEvents] = useState<StatusEvent[]>([]);
  const [codeIndex, setCodeIndex] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [currentRunId, setCurrentRunId] = useState<string>();
  const [runStatus, setRunStatus] = useState<RunStatus>();
  const [pendingApproval, setPendingApproval] = useState<PendingApproval>();
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState('');
  const [view, setView] = useState<'main' | 'stats' | 'settings'>('main');
  const [canvasCollapsed, setCanvasCollapsed] = useState(false);
  const [model, setModel] = useState<string>();
  // run_id -> final/active status, so the thread can place the "Proved" milestone
  // after the run that actually completed (M16). Filled on reload + live `done`.
  const [runStatusById, setRunStatusById] = useState<Record<string, string>>({});

  const eventSourceRef = useRef<EventSource | null>(null);
  const runStatusRef = useRef<RunStatus>();
  runStatusRef.current = runStatus;

  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedSessionId),
    [sessions, selectedSessionId],
  );
  const title = selectedSession?.title || 'New theorem session';

  const { items } = useMemo(() => buildTimeline({ messages, codeSteps }), [messages, codeSteps]);
  const sortedCode = useMemo(() => sortCodeSteps(codeSteps), [codeSteps]);

  const refreshSessions = async () => {
    const loaded = await listSessions();
    setSessions(loaded);
    return loaded;
  };

  useEffect(() => {
    const restore = async () => {
      const loaded = await refreshSessions();
      getSettings()
        .then((s) => setModel(typeof s.model === 'string' ? s.model : undefined))
        .catch(() => {});
      const savedId = window.localStorage.getItem(SELECTED_SESSION_KEY);
      const saved = savedId ? loaded.find((s) => s.id === savedId) : undefined;
      if (saved) await loadSession(saved.id);
    };
    restore().catch((err) => setError(err instanceof Error ? err.message : String(err)));
    return () => eventSourceRef.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyDetail = (detail: SessionDetail) => {
    setSelectedSessionId(detail.id);
    setMessages(detail.messages);
    setCodeSteps(detail.code_steps);
    setStatusEvents(detail.status_events || []);
    setCodeIndex(Math.max(0, sortCodeSteps(detail.code_steps).length - 1));
    setError(undefined);
    const active = detail.active_run;
    setCurrentRunId(active?.id);
    setIsRunning(Boolean(active));
    setRunStatus((active?.status as RunStatus) || undefined);
    setPendingApproval(
      active?.pending_approval
        ? { ...active.pending_approval, session_id: detail.id, run_id: active.id }
        : undefined,
    );
    setApprovalBusy(false);
    const statuses: Record<string, string> = {};
    for (const r of detail.runs || []) statuses[r.id] = r.status;
    if (active) statuses[active.id] = active.status;
    setRunStatusById(statuses);
    if (active && (active.status === 'running' || active.status === 'pending')) {
      attachStream(active.id, detail.id);
    }
  };

  const loadSession = async (sessionId: string) => {
    eventSourceRef.current?.close();
    const detail = await getSession(sessionId);
    applyDetail(detail);
    window.localStorage.setItem(SELECTED_SESSION_KEY, detail.id);
  };

  const reconcile = async (sessionId: string) => {
    const detail = await getSession(sessionId);
    const finished = runStatusRef.current;
    applyDetail(detail);
    if (finished) setRunStatus(finished);
  };

  const resetForNewSession = () => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setSelectedSessionId(undefined);
    setMessages([]);
    setCodeSteps([]);
    setStatusEvents([]);
    setCodeIndex(0);
    setIsRunning(false);
    setCurrentRunId(undefined);
    setRunStatus(undefined);
    setPendingApproval(undefined);
    setApprovalBusy(false);
    setError(undefined);
    setDraft('');
    window.localStorage.removeItem(SELECTED_SESSION_KEY);
  };

  const attachStream = (runId: string, sessionId: string) => {
    eventSourceRef.current?.close();
    const source = new EventSource(`/api/runs/${runId}/events`);
    eventSourceRef.current = source;
    const liveId = `live-${runId}`;
    let sawDone = false;

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
      setCodeSteps((current) => {
        if (current.some((s) => s.id === payload.id)) {
          return current.map((s) => (s.id === payload.id ? { ...s, ...payload } : s));
        }
        const next = sortCodeSteps([...current, payload]);
        const idx = next.findIndex((s) => s.id === payload.id);
        if (idx >= 0) setCodeIndex(idx);
        return next;
      });
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
      setPendingApproval({ ...payload, session_id: sessionId, run_id: runId });
      setApprovalBusy(false);
    });

    source.addEventListener('approval_resolved', (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { approval_id?: string };
      setPendingApproval((current) =>
        current && current.approval_id === payload.approval_id ? undefined : current,
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
      let status: RunStatus = 'success';
      try {
        status = (JSON.parse((event as MessageEvent).data || '{}').status as RunStatus) || 'success';
      } catch {
        /* keep default */
      }
      setIsRunning(false);
      setRunStatus(status);
      runStatusRef.current = status;
      setRunStatusById((prev) => ({ ...prev, [runId]: status }));
      setCurrentRunId(undefined);
      setPendingApproval(undefined);
      setApprovalBusy(false);
      reconcile(sessionId)
        .then(() => refreshSessions())
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
        await refreshSessions();
        if (detail.active_run) setError('Lost connection to the Lea backend.');
      } catch {
        setError('Lost connection to the Lea backend.');
      }
    };
  };

  const handleSubmit = async () => {
    const content = draft.trim();
    if (!content || isRunning) return;
    setError(undefined);
    setPendingApproval(undefined);
    try {
      const run = await createRun(content, selectedSessionId);
      setSelectedSessionId(run.session_id);
      setCurrentRunId(run.run_id);
      setRunStatus('running');
      runStatusRef.current = 'running';
      setRunStatusById((prev) => ({ ...prev, [run.run_id]: 'running' }));
      setIsRunning(true);
      setMessages((current) => [...current, run.message]);
      setDraft('');
      window.localStorage.setItem(SELECTED_SESSION_KEY, run.session_id);
      await refreshSessions();
      attachStream(run.run_id, run.session_id);
    } catch (err) {
      setIsRunning(false);
      setCurrentRunId(undefined);
      setError(err instanceof Error ? err.message : 'Unable to start Lea.');
    }
  };

  const handleDecide = async (decision: ApprovalDecision) => {
    if (!currentRunId || !pendingApproval || approvalBusy) return;
    setApprovalBusy(true);
    try {
      await submitApproval(currentRunId, pendingApproval.approval_id, decision);
    } catch (err) {
      setApprovalBusy(false);
      setError(err instanceof Error ? err.message : 'Unable to submit decision.');
    }
  };

  const handleInterrupt = async () => {
    if (!currentRunId) return;
    try {
      await interruptRun(currentRunId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to interrupt the run.');
    }
  };

  const selectStep = (idx: number) => {
    setCodeIndex(idx);
    setCanvasCollapsed(false);
  };

  // Canvas editing → write the file, then lean_check; reconcile to pick up the
  // new user-authored code step. Returns the verdict for the canvas foot.
  const handleSaveAndCheck = async (content: string): Promise<CheckOutcome> => {
    const path = sortedCode[sortedCode.length - 1]?.path;
    if (!selectedSessionId || !path) return { status: 'error', detail: 'No file to edit.' };
    await writeSessionFile(selectedSessionId, path, content, 'Manual edit from the canvas.');
    const result = await leanCheckSession(selectedSessionId, path);
    await reconcile(selectedSessionId);
    await refreshSessions();
    return result;
  };

  const handleVerify = async (): Promise<CheckOutcome> => {
    const path = sortedCode[sortedCode.length - 1]?.path;
    if (!selectedSessionId) return { status: 'error', detail: 'No session.' };
    return verifySession(selectedSessionId, path);
  };

  if (view === 'stats') return <StatsPage onBack={() => setView('main')} />;
  if (view === 'settings') return <SettingsPage onBack={() => setView('main')} />;

  return (
    <div className="lea-app">
      <div className="app">
        <Sidebar
          sessions={sessions}
          selectedSessionId={selectedSessionId}
          runningSessionId={isRunning ? selectedSessionId : undefined}
          onSelectSession={(id) =>
            loadSession(id).catch((err) => setError(err instanceof Error ? err.message : String(err)))
          }
          onNewSession={resetForNewSession}
          onOpenSettings={() => setView('settings')}
          onOpenStats={() => setView('stats')}
        />

        <div className={`main-area ${canvasCollapsed ? 'canvas-collapsed' : ''}`}>
          <ChatThread
            title={title}
            model={model}
            session={selectedSession}
            runStatus={runStatus}
            runStatusById={runStatusById}
            isRunning={isRunning}
            currentRunId={currentRunId}
            items={items}
            statusEvents={statusEvents}
            activeCodeIndex={codeIndex}
            onSelectStep={selectStep}
            pendingApproval={pendingApproval}
            approvalBusy={approvalBusy}
            onDecide={handleDecide}
            error={error}
            draft={draft}
            onDraftChange={setDraft}
            onSubmit={handleSubmit}
            onInterrupt={handleInterrupt}
            canvasCollapsed={canvasCollapsed}
            onToggleCanvas={() => setCanvasCollapsed((v) => !v)}
          />

          <Canvas
            codeSteps={sortedCode}
            index={codeIndex}
            onIndexChange={setCodeIndex}
            isRunning={isRunning}
            onClose={() => setCanvasCollapsed(true)}
            onSaveAndCheck={handleSaveAndCheck}
            onVerify={handleVerify}
          />
        </div>
      </div>
    </div>
  );
}
