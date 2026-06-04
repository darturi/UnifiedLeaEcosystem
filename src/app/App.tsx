import { useEffect, useMemo, useRef, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { SessionList } from './components/SessionList';
import { ChatInterface } from './components/ChatInterface';
import { CodeViewer } from './components/CodeViewer';
import {
  ChatMessage,
  CodeStep,
  SessionSummary,
  createRun,
  getSession,
  listSessions,
} from './api';

interface StatusLogItem {
  id: string;
  message: string;
  created_at: string;
}

export default function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [codeSteps, setCodeSteps] = useState<CodeStep[]>([]);
  const [isPaused, setIsPaused] = useState(false);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string>();
  const [statusLog, setStatusLog] = useState<StatusLogItem[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);

  const refreshSessions = async () => {
    const loaded = await listSessions();
    setSessions(loaded);
    return loaded;
  };

  useEffect(() => {
    refreshSessions().catch((err) => setError(err.message));
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  const loadSession = async (sessionId: string) => {
    const detail = await getSession(sessionId);
    setSelectedSessionId(detail.id);
    setMessages(detail.messages);
    setCodeSteps(detail.code_steps);
    setCurrentStepIndex(Math.max(0, detail.code_steps.length - 1));
  };

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId),
    [sessions, selectedSessionId],
  );

  const title = selectedSession?.title || 'New theorem session';

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
    eventSourceRef.current?.close();

    try {
      const run = await createRun(content, selectedSessionId);
      setSelectedSessionId(run.session_id);
      appendMessage(run.message);
      setStatusLog([
        {
          id: `submitted-${run.run_id}`,
          message: 'Submitted theorem to backend.',
          created_at: new Date().toISOString(),
        },
      ]);
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
          return [
            ...current,
            {
              id: liveAssistantId,
              session_id: run.session_id,
              run_id: run.run_id,
              role: 'assistant',
              content: payload.text,
              created_at: new Date().toISOString(),
            },
          ];
        });
      });

      source.addEventListener('message', (event) => {
        const payload = JSON.parse((event as MessageEvent).data) as ChatMessage;
        setMessages((current) => {
          const withoutLive = current.filter((message) => message.id !== liveAssistantId);
          if (withoutLive.some((message) => message.id === payload.id)) {
            return withoutLive;
          }
          return [...withoutLive, payload];
        });
      });

      source.addEventListener('code_step', (event) => {
        const payload = JSON.parse((event as MessageEvent).data) as CodeStep;
        setCodeSteps((current) => {
          if (current.some((step) => step.id === payload.id)) {
            return current;
          }
          const next = [...current, payload];
          setCurrentStepIndex(next.length - 1);
          return next;
        });
      });

      source.addEventListener('status', (event) => {
        const payload = JSON.parse((event as MessageEvent).data);
        setStatusLog((current) => [
          ...current.slice(-9),
          {
            id: `${run.run_id}-${current.length}-${Date.now()}`,
            message: payload.message || payload.status || 'Lea status update',
            created_at: new Date().toISOString(),
          },
        ]);
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
        await refreshSessions();
      });

      source.onerror = () => {
        if (eventSourceRef.current !== source || source.readyState === EventSource.CLOSED) {
          return;
        }
        eventSourceRef.current = null;
        source.close();
        setIsRunning(false);
        setError('Lost connection to the Lea backend.');
      };
      return true;
    } catch (err) {
      setIsRunning(false);
      setError(err instanceof Error ? err.message : 'Unable to start Lea.');
      return false;
    }
  };

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
              setStatusLog([]);
              setCurrentStepIndex(0);
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
            statusLog={statusLog}
            onSubmit={handleSubmit}
            onTogglePause={() => setIsPaused(!isPaused)}
            theoremName={title}
            currentStepIndex={currentStepIndex}
          />
        </Panel>

        <PanelResizeHandle className="w-1 bg-border hover:bg-primary transition-colors" />

        <Panel defaultSize={30} minSize={20} maxSize={50}>
          <CodeViewer
            codeSteps={codeSteps}
            isPaused={isPaused}
            currentStepIndex={currentStepIndex}
            onStepChange={setCurrentStepIndex}
          />
        </Panel>
      </PanelGroup>
    </div>
  );
}
