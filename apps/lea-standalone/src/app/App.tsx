import { useEffect, useMemo, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatThread } from './components/ChatThread';
import { Canvas, type CheckOutcome } from './components/Canvas';
import { StatsPage } from './components/StatsPage';
import { SettingsPage } from './components/SettingsPage';
import { sortCodeSteps } from './lib/timeline.mjs';
import { pickInitialSession, stripSessionParam } from './sessionDeepLink.mjs';
import { useProofSession } from './stores/proofSession';
import { useSessions } from './stores/sessions';
import { useModel } from './stores/model';
import { useProofStream } from './hooks/useProofStream';
import { useLayout } from './hooks/useLayout';
import {
  type ApprovalDecision,
  type ChatMessage,
  type CodeStep,
  type PendingApproval,
  type RunStatus,
  type SessionDetail,
  type StatusEvent,
  createRun,
  getSession,
  interruptRun,
  leanCheckSession,
  submitApproval,
  verifySession,
  writeSessionFile,
} from './lib/api';

const SELECTED_SESSION_KEY = 'lea:selectedSessionId';

export default function App() {
  // Session list + selection now live in the sessions store (R3).
  const sessions = useSessions((s) => s.sessions);
  const selectedSessionId = useSessions((s) => s.selectedSessionId);
  const setSelectedSessionId = useSessions((s) => s.setSelectedSessionId);
  const refreshSessions = useSessions((s) => s.refreshSessions);
  // messages + statusEvents (chat thread content) now live in the proofSession
  // store (R1c-2a): App writes them; ChatThread reads them + derives the timeline.
  const setMessages = useProofSession((s) => s.setMessages);
  const setStatusEvents = useProofSession((s) => s.setStatusEvents);
  // codeSteps + codeIndex (canvas snapshots + stepper) now live in the
  // proofSession store (R1c): App writes them; Canvas reads them directly.
  const codeSteps = useProofSession((s) => s.codeSteps);
  const setCodeSteps = useProofSession((s) => s.setCodeSteps);
  const setCodeIndex = useProofSession((s) => s.setCodeIndex);
  // Run lifecycle + approvals (M13/M16) now live in the proofSession store
  // (R1c-2b): App drives them; ChatThread/Canvas read them directly. App still
  // reads several here for its handlers (guards, the run to act on, pending
  // approval). runStatusById is write-only from App.
  const isRunning = useProofSession((s) => s.isRunning);
  const setIsRunning = useProofSession((s) => s.setIsRunning);
  const currentRunId = useProofSession((s) => s.currentRunId);
  const setCurrentRunId = useProofSession((s) => s.setCurrentRunId);
  const runStatus = useProofSession((s) => s.runStatus);
  const setRunStatus = useProofSession((s) => s.setRunStatus);
  const setRunStatusById = useProofSession((s) => s.setRunStatusById);
  const approvals = useProofSession((s) => s.approvals);
  const setApprovals = useProofSession((s) => s.setApprovals);
  const approvalBusy = useProofSession((s) => s.approvalBusy);
  const setApprovalBusy = useProofSession((s) => s.setApprovalBusy);
  // error (chat error banner) now lives in the proofSession store (R1b); App
  // sets it, ChatThread reads it.
  const setError = useProofSession((s) => s.setError);
  const [draft, setDraft] = useState('');
  // View/render UI state (page, sidebar/canvas collapse, canvas resize) lives in
  // the useLayout hook now (R5).
  const {
    view,
    setView,
    canvasCollapsed,
    setCanvasCollapsed,
    sidebarCollapsed,
    setSidebarCollapsed,
    canvasWidth,
    dragging,
    setDragging,
    mainAreaRef,
  } = useLayout();
  // editedPath (M20 canvas-edit nudge) now lives in the proofSession store
  // (v2.0.1 R1a): App sets it; ChatThread reads it straight from the store.
  const setEditedPath = useProofSession((s) => s.setEditedPath);
  // safeVerify (persisted SafeVerify verdict, survives reload via
  // session_detail.safe_verify; M24) now lives in the proofSession store (R1b);
  // App sets it, Canvas reads it.
  const setSafeVerify = useProofSession((s) => s.setSafeVerify);
  // Model state (active model, catalog, featured, key-missing) lives in the model
  // store (R4); ChatThread reads it directly. App only kicks off the startup load
  // (in the restore effect) + re-sync on returning from Settings.

  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedSessionId),
    [sessions, selectedSessionId],
  );
  const title = selectedSession?.title || 'New theorem session';

  const sortedCode = useMemo(() => sortCodeSteps(codeSteps), [codeSteps]);
  const pendingApproval = approvals.find((a) => !a.decision);

  // The run EventSource lifecycle + session-detail hydration live in a hook now
  // (R2); it reads the proofSession + sessions stores directly.
  const { attachStream, applyDetail, reconcile, closeStream } = useProofStream();

  useEffect(() => {
    const restore = async () => {
      const loaded = await refreshSessions();
      useModel.getState().syncFromSettings();
      useModel.getState().loadCatalog();
      // The Overleaf extension's "View in Lea UI" action opens <ui>/?session=<id>;
      // that deep-link takes precedence over the last-opened session.
      const { sessionId: initialSessionId, source } = pickInitialSession({
        search: window.location.search,
        savedId: window.localStorage.getItem(SELECTED_SESSION_KEY),
        sessions: loaded,
      });
      if (source === 'deep-link') {
        // Strip the param so a later reload falls back to the saved-session restore.
        const cleaned = stripSessionParam(window.location.search);
        window.history.replaceState(
          {},
          '',
          `${window.location.pathname}${cleaned}${window.location.hash}`,
        );
      }
      if (initialSessionId) {
        try {
          await loadSession(initialSessionId);
        } catch (err) {
          // A stale saved id is unexpected (it was just found in the list); a bad
          // deep-link id is plausible — in that case leave the user on a fresh
          // session rather than surfacing an error.
          if (source !== 'deep-link') throw err;
        }
      }
    };
    restore().catch((err) => setError(err instanceof Error ? err.message : String(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe once to the session-list feed. Each `sessions_changed` event just
  // re-fetches the list; this only swaps the sidebar array and never touches the
  // open session's detail/streaming state (selection is keyed by id), so it can't
  // clobber a live run or steal focus. The browser EventSource auto-reconnects if
  // the capped server stream recycles. A session started anywhere — including an
  // Overleaf-driven formalization the companion creates via POST /api/runs —
  // appears live without a manual refresh.
  useEffect(() => {
    const source = new EventSource('/api/sessions/events');
    source.addEventListener('sessions_changed', () => {
      refreshSessions().catch(() => {});
    });
    return () => source.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadSession = async (sessionId: string) => {
    closeStream();
    const detail = await getSession(sessionId);
    applyDetail(detail);
    window.localStorage.setItem(SELECTED_SESSION_KEY, detail.id);
  };

  const resetForNewSession = () => {
    closeStream();
    setSelectedSessionId(undefined);
    setMessages([]);
    setCodeSteps([]);
    setStatusEvents([]);
    setCodeIndex(0);
    setIsRunning(false);
    setCurrentRunId(undefined);
    setRunStatus(undefined);
    setRunStatusById({});
    setApprovals([]);
    setApprovalBusy(false);
    setError(undefined);
    setDraft('');
    setEditedPath(undefined);
    setSafeVerify(null);
    window.localStorage.removeItem(SELECTED_SESSION_KEY);
  };

  const handleSubmit = async () => {
    const content = draft.trim();
    if (!content || isRunning) return;
    setError(undefined);
    setEditedPath(undefined);
    setApprovals((prev) => prev.filter((a) => a.decision));
    try {
      const run = await createRun(content, selectedSessionId);
      setSelectedSessionId(run.session_id);
      setCurrentRunId(run.run_id);
      setRunStatus('running');
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
    setEditedPath(path); // after reconcile (which clears it) — surface the nudge
    setSafeVerify(null); // the edit invalidates any prior SafeVerify verdict
    return result;
  };

  const handleVerify = async (): Promise<CheckOutcome> => {
    const path = sortedCode[sortedCode.length - 1]?.path;
    if (!selectedSessionId) return { status: 'error', detail: 'No session.' };
    const result = await verifySession(selectedSessionId, path);
    setSafeVerify({ status: result.status, detail: result.detail });
    return result;
  };

  if (view === 'stats') return <StatsPage onBack={() => setView('main')} />;
  if (view === 'settings')
    return (
      <SettingsPage
        onBack={() => {
          setView('main');
          // re-sync model + key state after the user may have added a key
          useModel.getState().syncFromSettings();
        }}
      />
    );

  return (
    <div className="lea-app">
      <div className={`app ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
        <Sidebar
          runningSessionId={isRunning ? selectedSessionId : undefined}
          onSelectSession={(id) =>
            loadSession(id).catch((err) => setError(err instanceof Error ? err.message : String(err)))
          }
          onNewSession={resetForNewSession}
          onOpenSettings={() => setView('settings')}
          onOpenStats={() => setView('stats')}
          onCollapse={() => setSidebarCollapsed(true)}
        />

        <div
          ref={mainAreaRef}
          className={`main-area ${canvasCollapsed ? 'canvas-collapsed' : ''}`}
          style={{ gridTemplateColumns: canvasCollapsed ? '1fr 0' : `minmax(0,1fr) ${canvasWidth}%` }}
        >
          <ChatThread
            title={title}
            sidebarCollapsed={sidebarCollapsed}
            onExpandSidebar={() => setSidebarCollapsed(false)}
            session={selectedSession}
            onSelectStep={selectStep}
            onDecide={handleDecide}
            onOpenSettings={() => setView('settings')}
            draft={draft}
            onDraftChange={setDraft}
            onSubmit={handleSubmit}
            onInterrupt={handleInterrupt}
            canvasCollapsed={canvasCollapsed}
            onToggleCanvas={() => setCanvasCollapsed((v) => !v)}
          />

          {!canvasCollapsed && (
            <div
              className={`col-resizer ${dragging ? 'dragging' : ''}`}
              style={{ right: `${canvasWidth}%` }}
              onMouseDown={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              title="Drag to resize"
            />
          )}

          <Canvas
            onClose={() => setCanvasCollapsed(true)}
            onSaveAndCheck={handleSaveAndCheck}
            onVerify={handleVerify}
          />
        </div>
      </div>
    </div>
  );
}
