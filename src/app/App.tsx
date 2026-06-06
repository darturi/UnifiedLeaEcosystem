import { useEffect, useMemo, useRef, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { SessionList } from './components/SessionList';
import { ChatInterface } from './components/ChatInterface';
import { CodeViewer } from './components/CodeViewer';
import { StatsPage } from './components/StatsPage';
import { SettingsPage } from './components/SettingsPage';
import { timelineStepCount } from './stepTimeline.mjs';
import {
  ChatMessage,
  CodeStep,
  ApprovalDecision,
  PendingApproval,
  SessionSummary,
  SessionDetail,
  StatusEvent,
  createRun,
  getSession,
  listSessions,
  submitApproval,
} from './api';

export default function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [codeSteps, setCodeSteps] = useState<CodeStep[]>([]);
  const [isPaused, setIsPaused] = useState(false);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [activeTimelineStepIndex, setActiveTimelineStepIndex] = useState<number | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [currentRunId, setCurrentRunId] = useState<string>();
  const [pendingApproval, setPendingApproval] = useState<PendingApproval>();
  const [isSubmittingApproval, setIsSubmittingApproval] = useState(false);
  const [approvalError, setApprovalError] = useState<string>();
  const [error, setError] = useState<string>();
  const [statusEvents, setStatusEvents] = useState<StatusEvent[]>([]);
  const [view, setView] = useState<'main' | 'stats' | 'settings'>('main');
  const eventSourceRef = useRef<EventSource | null>(null);
  const codeStepCountRef = useRef(0);
  const activeTimelineStepIndexRef = useRef<number | null>(null);

  const setActiveTimelineStep = (stepIndex: number | null) => {
    activeTimelineStepIndexRef.current = stepIndex;
    setActiveTimelineStepIndex(stepIndex);
  };

  const terminalMessageIdForDetail = (
    detail: { messages: ChatMessage[]; status?: string },
  ) => {
    if (!detail.status || detail.status === 'running') {
      return null;
    }
    const terminalMessage = [...detail.messages]
      .reverse()
      .find((message) => message.role === 'assistant' || message.role === 'system');
    return terminalMessage?.id ?? null;
  };

  const lastTimelineStepIndex = (detail: { messages: ChatMessage[]; code_steps: CodeStep[]; status?: string }) => {
    const count = timelineStepCount({
      messages: detail.messages,
      codeSteps: detail.code_steps,
      terminalMessageId: terminalMessageIdForDetail(detail),
    });
    return Math.max(0, count - 1);
  };

  const refreshSessions = async () => {
    const loaded = await listSessions();
    setSessions(loaded);
    return loaded;
  };

  useEffect(() => {
    const restoreInitialSession = async () => {
      const loaded = await refreshSessions();
      const savedSessionId = window.localStorage.getItem('lea:selectedSessionId');
      const savedSession = savedSessionId
        ? loaded.find((session) => session.id === savedSessionId)
        : undefined;
      const activeSession = loaded.find((session) => session.status === 'running');
      const sessionToRestore = savedSession || activeSession;
      if (sessionToRestore) {
        await loadSession(sessionToRestore.id);
      }
    };
    restoreInitialSession().catch((err) => setError(err.message));
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  const applySessionDetail = (detail: SessionDetail) => {
    setSelectedSessionId(detail.id);
    setMessages(detail.messages);
    setCodeSteps(detail.code_steps);
    setStatusEvents(detail.status_events || []);
    codeStepCountRef.current = detail.code_steps.length;
    setCurrentStepIndex(lastTimelineStepIndex(detail));
    setActiveTimelineStep(null);
    setCurrentRunId(detail.active_run?.id);
    setPendingApproval(detail.active_run?.pending_approval || undefined);
    setIsRunning(Boolean(detail.active_run));
    setApprovalError(undefined);
  };

  const loadSession = async (sessionId: string) => {
    const detail = await getSession(sessionId);
    applySessionDetail(detail);
    window.localStorage.setItem('lea:selectedSessionId', detail.id);
  };

  const reconcileSession = async (sessionId: string) => {
    const detail = await getSession(sessionId);
    applySessionDetail(detail);
  };

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId),
    [sessions, selectedSessionId],
  );

  const title = selectedSession?.title || 'New theorem session';
  const selectedTerminalMessageId = useMemo(() => {
    if (isRunning || !selectedSession?.status || selectedSession.status === 'running') {
      return null;
    }
    const terminalMessage = [...messages]
      .reverse()
      .find((message) => message.role === 'assistant' || message.role === 'system');
    return terminalMessage?.id ?? null;
  }, [isRunning, messages, selectedSession?.status]);
  const currentTimelineStepCount = useMemo(
    () =>
      timelineStepCount({
        messages,
        codeSteps,
        terminalMessageId: selectedTerminalMessageId,
      }),
    [messages, codeSteps, selectedTerminalMessageId],
  );

  const appendMessage = (message: ChatMessage) => {
    setMessages((current) => {
      if (current.some((item) => item.id === message.id)) {
        return current;
      }
      return [...current, message];
    });
  };

  const handleSubmit = async (content: string): Promise<boolean> => {
    setError(undefined);
    setApprovalError(undefined);
    setPendingApproval(undefined);
    eventSourceRef.current?.close();

    try {
      const run = await createRun(content, selectedSessionId);
      setSelectedSessionId(run.session_id);
      setCurrentRunId(run.run_id);
      appendMessage(run.message);
      setStatusEvents([
        {
          id: `submitted-${run.run_id}`,
          session_id: run.session_id,
          run_id: run.run_id,
          step_number: null,
          status: 'submitted',
          message: 'Submitted theorem to backend.',
          created_at: new Date().toISOString(),
        },
      ]);
      setActiveTimelineStep(null);
      setIsRunning(true);

      const nextSessions = await refreshSessions();
      if (!selectedSessionId && nextSessions.length === 1) {
        setSelectedSessionId(run.session_id);
      }

      const source = new EventSource(`/api/runs/${run.run_id}/events`);
      eventSourceRef.current = source;

      let liveAssistantId = `live-${run.run_id}`;
      source.addEventListener('assistant_delta', (event) => {
        const payload = JSON.parse((event as MessageEvent).data);
        setMessages((current) => {
          const existing = current.find((message) => message.id === liveAssistantId);
          if (existing) {
            return current.map((message) =>
              message.id === liveAssistantId
                ? { ...message, content: message.content + payload.text }
                : message,
            );
          }
          const assistantStepCount = current.filter(
            (message) =>
              message.role === 'assistant' &&
              !message.is_live_terminal_summary,
          ).length;
          setActiveTimelineStep(assistantStepCount);
          return [
            ...current,
            {
              id: liveAssistantId,
              session_id: run.session_id,
              run_id: run.run_id,
              role: 'assistant',
              content: payload.text,
              created_at: new Date().toISOString(),
              live_started_after_assistant_steps: assistantStepCount,
              live_started_after_code_steps: codeStepCountRef.current,
            },
          ];
        });
      });

      source.addEventListener('message', (event) => {
        const payload = JSON.parse((event as MessageEvent).data) as ChatMessage;
        setMessages((current) => {
          const liveMessage = current.find((message) => message.id === liveAssistantId);
          const shouldReplaceLive =
            payload.role === 'assistant' &&
            !!liveMessage &&
            (payload.content.includes(liveMessage.content) ||
              liveMessage.content.includes(payload.content));
          const withoutLive =
            shouldReplaceLive
              ? current.filter((message) => message.id !== liveAssistantId)
              : current;
          if (withoutLive.some((message) => message.id === payload.id)) {
            return withoutLive;
          }
          return [
            ...withoutLive,
            shouldReplaceLive && liveMessage
              ? {
                  ...payload,
                  live_started_after_assistant_steps: liveMessage.live_started_after_assistant_steps,
                  live_started_after_code_steps: liveMessage.live_started_after_code_steps,
                }
              : payload,
          ];
        });
      });

      source.addEventListener('code_step', (event) => {
        const payload = JSON.parse((event as MessageEvent).data) as CodeStep;
        setCodeSteps((current) => {
          if (current.some((step) => step.id === payload.id)) {
            return current;
          }
          const next = [...current, payload];
          codeStepCountRef.current = next.length;
          setCurrentStepIndex(payload.step_number - 1);
          setActiveTimelineStep(payload.step_number - 1);
          return next;
        });
      });

      source.addEventListener('status', (event) => {
        const payload = JSON.parse((event as MessageEvent).data);
        const payloadStepNumber =
          Number.isInteger(payload.step_number) && payload.step_number > 0
            ? payload.step_number
            : null;
        const activeStepNumber =
          activeTimelineStepIndexRef.current === null
            ? null
            : activeTimelineStepIndexRef.current + 1;
        setStatusEvents((current) => [
          ...current,
          {
            id: payload.id || `${run.run_id}-${current.length}-${Date.now()}`,
            session_id: payload.session_id || run.session_id,
            run_id: payload.run_id || run.run_id,
            step_number: payloadStepNumber || activeStepNumber,
            status: payload.status || null,
            message: payload.message || payload.status || 'Lea status update',
            created_at: payload.created_at || new Date().toISOString(),
          },
        ]);
      });

      source.addEventListener('approval_requested', (event) => {
        const payload = JSON.parse((event as MessageEvent).data) as PendingApproval;
        setPendingApproval(payload);
        setApprovalError(undefined);
      });

      source.addEventListener('approval_resolved', (event) => {
        const payload = JSON.parse((event as MessageEvent).data) as {
          approval_id?: string;
        };
        setPendingApproval((current) =>
          current?.approval_id === payload.approval_id ? undefined : current,
        );
        setApprovalError(undefined);
      });

      source.addEventListener('error', (event) => {
        const data = (event as MessageEvent).data;
        if (data) {
          const payload = JSON.parse(data);
          setError(payload.message || 'Lea reported an error.');
        }
      });

      source.addEventListener('done', async () => {
        eventSourceRef.current = null;
        source.close();
        setIsRunning(false);
        setCurrentRunId(undefined);
        setPendingApproval(undefined);
        setApprovalError(undefined);
        setActiveTimelineStep(null);
        await reconcileSession(run.session_id);
        await refreshSessions();
      });

      source.onerror = async () => {
        if (eventSourceRef.current !== source || source.readyState === EventSource.CLOSED) {
          return;
        }
        eventSourceRef.current = null;
        source.close();
        setIsRunning(false);
        setCurrentRunId(undefined);
        setPendingApproval(undefined);
        setActiveTimelineStep(null);
        reconcileSession(run.session_id).catch(() => undefined);
        setError('Lost connection to the Lea backend.');
      };
      return true;
    } catch (err) {
      setIsRunning(false);
      setCurrentRunId(undefined);
      setError(err instanceof Error ? err.message : 'Unable to start Lea.');
      return false;
    }
  };

  const handleSubmitApproval = async (
    decision: ApprovalDecision,
    feedback?: string,
  ): Promise<void> => {
    if (!currentRunId || !pendingApproval || isSubmittingApproval) {
      return;
    }
    setIsSubmittingApproval(true);
    setApprovalError(undefined);
    try {
      await submitApproval(
        currentRunId,
        pendingApproval.approval_id,
        decision,
        decision === 'reject' ? feedback : undefined,
      );
      setPendingApproval(undefined);
    } catch (err) {
      setApprovalError(err instanceof Error ? err.message : 'Unable to submit approval.');
    } finally {
      setIsSubmittingApproval(false);
    }
  };

  if (view === 'stats') {
    return <StatsPage onBack={() => setView('main')} />;
  }
  if (view === 'settings') {
    return <SettingsPage onBack={() => setView('main')} />;
  }

  return (
    <div className="size-full">
      <PanelGroup direction="horizontal">
        <Panel defaultSize={20} minSize={15} maxSize={30}>
          <SessionList
            sessions={sessions}
            selectedSessionId={selectedSessionId}
            onSelectSession={(id) => loadSession(id).catch((err) => setError(err.message))}
            onNewSession={() => {
              setSelectedSessionId(undefined);
              setMessages([]);
              setCodeSteps([]);
              codeStepCountRef.current = 0;
              setStatusEvents([]);
              setCurrentStepIndex(0);
              setActiveTimelineStep(null);
              setCurrentRunId(undefined);
              setPendingApproval(undefined);
              setApprovalError(undefined);
              setIsRunning(false);
              window.localStorage.removeItem('lea:selectedSessionId');
              setError(undefined);
            }}
          />
        </Panel>

        <PanelResizeHandle className="w-1 bg-border hover:bg-primary transition-colors" />

        <Panel defaultSize={50} minSize={30}>
          <ChatInterface
            error={error}
            isPaused={isPaused}
            isRunning={isRunning}
            messages={messages}
            codeSteps={codeSteps}
            sessionStatus={selectedSession?.status}
            statusEvents={statusEvents}
            onSubmit={handleSubmit}
            onSubmitApproval={handleSubmitApproval}
            onStepSelect={setCurrentStepIndex}
            onTogglePause={() => setIsPaused(!isPaused)}
            onOpenStats={() => setView('stats')}
            onOpenSettings={() => setView('settings')}
            theoremName={title}
            currentStepIndex={currentStepIndex}
            activeTimelineStepIndex={activeTimelineStepIndex}
            pendingApproval={pendingApproval}
            isSubmittingApproval={isSubmittingApproval}
            approvalError={approvalError}
          />
        </Panel>

        <PanelResizeHandle className="w-1 bg-border hover:bg-primary transition-colors" />

        <Panel defaultSize={30} minSize={20} maxSize={50}>
          <CodeViewer
            codeSteps={codeSteps}
            timelineStepCount={Math.max(
              currentTimelineStepCount,
              activeTimelineStepIndex === null ? 0 : activeTimelineStepIndex + 1,
            )}
            isPaused={isPaused}
            isRunning={isRunning}
            currentStepIndex={currentStepIndex}
            onStepChange={setCurrentStepIndex}
          />
        </Panel>
      </PanelGroup>
    </div>
  );
}
