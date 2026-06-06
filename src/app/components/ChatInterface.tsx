import { useMemo, useState } from 'react';
import { Send, Pause, Play, BarChart3, Loader2 } from 'lucide-react';
import { ApprovalDecision, ChatMessage, CodeStep, PendingApproval, SessionStatus, StatusEvent } from '../api';
import { buildStepTimeline, codeStepFallbackContent } from '../stepTimeline.mjs';
import { MarkdownMessage } from './MarkdownMessage';
import { TheoremApprovalPanel } from './TheoremApprovalPanel';

export function ChatInterface({
  error,
  isPaused,
  isRunning,
  messages,
  codeSteps,
  statusEvents,
  sessionStatus,
  onSubmit,
  onStepSelect,
  onTogglePause,
  onOpenStats,
  onSubmitApproval,
  theoremName,
  currentStepIndex,
  activeTimelineStepIndex,
  pendingApproval,
  isSubmittingApproval,
  approvalError,
}: {
  error?: string;
  isPaused: boolean;
  isRunning: boolean;
  pendingApproval?: PendingApproval;
  isSubmittingApproval: boolean;
  approvalError?: string;
  messages: ChatMessage[];
  codeSteps: CodeStep[];
  sessionStatus?: SessionStatus;
  statusEvents: StatusEvent[];
  onSubmit: (content: string) => Promise<boolean>;
  onSubmitApproval: (decision: ApprovalDecision, feedback?: string) => Promise<void>;
  onStepSelect: (stepIndex: number) => void;
  onTogglePause: () => void;
  onOpenStats: () => void;
  theoremName: string;
  currentStepIndex: number;
  activeTimelineStepIndex: number | null;
}) {
  const [input, setInput] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const terminalMessageId = useMemo(() => {
    if (isRunning || !sessionStatus || sessionStatus === 'running') {
      return null;
    }
    const terminalMessage = [...messages]
      .reverse()
      .find((message) => message.role === 'assistant' || message.role === 'system');
    return terminalMessage?.id ?? null;
  }, [isRunning, messages, sessionStatus]);
  const timeline = useMemo(
    () =>
      buildStepTimeline({
        messages,
        codeSteps,
        statusEvents,
        terminalMessageId,
      }),
    [messages, codeSteps, statusEvents, terminalMessageId],
  );
  const highlightedStepIndex =
    isRunning && activeTimelineStepIndex !== null
      ? activeTimelineStepIndex
      : currentStepIndex;

  const submitInput = async () => {
    const content = input.trim();
    if (!content || isRunning || isSubmitting) {
      return;
    }
    setIsSubmitting(true);
    const succeeded = await onSubmit(content);
    if (succeeded) {
      setInput('');
    }
    setIsSubmitting(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await submitInput();
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submitInput();
    }
  };

  const renderLogList = (logs: StatusEvent[]) => {
    if (logs.length === 0) {
      return null;
    }
    return (
      <div className="min-w-0 text-xs leading-relaxed text-muted-foreground md:max-w-[34%] md:pt-9">
        <div className="mb-1 font-semibold uppercase tracking-wide text-muted-foreground/80">
          Activity
        </div>
        <div className="space-y-1">
          {logs.map((item) => (
            <div key={item.id} className="break-words">
              <span className="tabular-nums opacity-80">
                {new Date(item.created_at).toLocaleTimeString()}
              </span>
              <span> - {item.message}</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const terminalClass =
    sessionStatus === 'success'
      ? 'border border-green-500/30 bg-green-500/15 text-foreground'
      : sessionStatus === 'failed' || sessionStatus === 'max_turns'
      ? 'border border-destructive/30 bg-destructive/10 text-foreground'
      : 'bg-muted text-muted-foreground';

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="p-4 border-b border-border flex items-center justify-between gap-3">
        <div className="min-w-0 flex items-center gap-3">
          <h2 className="truncate text-foreground">{theoremName}</h2>
          {isRunning && (
            <div className="flex shrink-0 items-center gap-2 rounded-md bg-accent px-2 py-1 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Lea is working
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onTogglePause}
            className={[
              'flex items-center gap-2 rounded-md bg-secondary px-3 py-2',
              'text-secondary-foreground transition-opacity hover:opacity-90',
            ].join(' ')}
          >
            {isPaused ? (
              <>
                <Play className="w-4 h-4" />
                Resume
              </>
            ) : (
              <>
                <Pause className="w-4 h-4" />
                Pause
              </>
            )}
          </button>
          <button
            onClick={onOpenStats}
            className={[
              'flex items-center gap-2 rounded-md bg-secondary px-3 py-2',
              'text-secondary-foreground transition-opacity hover:opacity-90',
            ].join(' ')}
          >
            <BarChart3 className="w-4 h-4" />
            Statistics
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="h-full flex items-center justify-center text-center text-muted-foreground">
            Enter a theorem or natural-language proof task to start Lea.
          </div>
        )}

        {timeline.userAndSystemMessages.map((message: ChatMessage) => {
          const isUser = message.role === 'user';
          const isSystem = message.role === 'system';
          const baseMessageClass = isUser
            ? 'bg-primary text-primary-foreground'
            : isSystem
            ? 'bg-accent text-accent-foreground'
            : 'bg-muted text-muted-foreground';

          return (
            <div
              key={message.id}
              className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] rounded-lg p-4 transition-all ${baseMessageClass}`}
              >
                {isUser ? (
                  <p className="whitespace-pre-wrap">{message.content}</p>
                ) : (
                  <MarkdownMessage content={message.content} />
                )}
                <p className="text-xs opacity-70 mt-2">
                  {new Date(message.created_at).toLocaleTimeString()}
                </p>
              </div>
            </div>
          );
        })}

        {timeline.globalLogs.length > 0 && (
          <div className="rounded-md bg-accent/70 p-3 text-xs leading-relaxed text-muted-foreground">
            <div className="mb-1 font-semibold uppercase tracking-wide text-foreground/70">
              Run setup
            </div>
            <div className="space-y-1">
              {timeline.globalLogs.map((item: StatusEvent) => (
                <div key={item.id}>
                  {new Date(item.created_at).toLocaleTimeString()} - {item.message}
                </div>
              ))}
            </div>
          </div>
        )}

        {pendingApproval && (
          <TheoremApprovalPanel
            approval={pendingApproval}
            isSubmitting={isSubmittingApproval}
            error={approvalError}
            onSubmit={onSubmitApproval}
          />
        )}

        {timeline.stepItems.map((item) => {
          const stepIndex = item.stepIndex;
          const step = item.codeStep;
          const message = item.message;
          const isSelectableStep = stepIndex < timeline.stepItems.length;
          const isActiveStep = stepIndex === highlightedStepIndex;
          const activeStepClass = isActiveStep
            ? 'ring-2 ring-foreground ring-offset-2 ring-offset-background bg-muted/80'
            : '';
          const selectableStepClass = isSelectableStep
            ? 'cursor-pointer hover:ring-2 hover:ring-foreground/40'
            : '';
          const content =
            message?.content ||
            (step ? codeStepFallbackContent(step) : 'Lea is preparing this step.');
          const createdAt = message?.created_at || step?.created_at || new Date().toISOString();

          return (
            <div key={item.id} className="flex justify-start">
              <div
                className="flex w-full flex-col gap-2 md:flex-row md:items-start"
              >
                <div
                  className={`max-w-[80%] rounded-lg bg-muted p-4 text-muted-foreground transition-all md:max-w-[66%] ${activeStepClass} ${selectableStepClass}`}
                  onClick={() => {
                    if (isSelectableStep) {
                      onStepSelect(stepIndex);
                    }
                  }}
                >
                  <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-foreground/70">
                    <span>Step {item.stepNumber}</span>
                    {isRunning && isActiveStep && (
                      <Loader2 className="ml-2 inline h-3.5 w-3.5 animate-spin align-[-2px]" />
                    )}
                  </div>
                  <MarkdownMessage content={content} />
                  <p className="text-xs opacity-70 mt-2">
                    {new Date(createdAt).toLocaleTimeString()}
                  </p>
                </div>
                {renderLogList(item.logs)}
              </div>
            </div>
          );
        })}

        {timeline.terminalMessages.map((message: ChatMessage) => {
          const isSystem = message.role === 'system';
          const baseMessageClass = isSystem
            ? 'bg-accent text-accent-foreground'
            : terminalClass;

          return (
            <div key={message.id} className="flex justify-start">
              <div className={`max-w-[80%] rounded-lg p-4 transition-all ${baseMessageClass}`}>
                <MarkdownMessage content={message.content} />
                <p className="text-xs opacity-70 mt-2">
                  {new Date(message.created_at).toLocaleTimeString()}
                </p>
              </div>
            </div>
          );
        })}

        {isSubmitting && !isRunning && (
          <div className="text-sm text-muted-foreground">
            Submitting to Lea...
          </div>
        )}

        {error && (
          <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}
      </div>

      <div className="p-4 border-t border-border">
        <form onSubmit={handleSubmit} className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="Enter your theorem in LaTeX or natural language..."
            rows={2}
            className={[
              'max-h-32 min-h-12 flex-1 resize-none overflow-y-auto whitespace-pre-wrap',
              'rounded-md border border-border bg-input-background px-4 py-2',
              'focus:outline-none focus:ring-2 focus:ring-ring',
            ].join(' ')}
          />
          <button
            type="submit"
            disabled={isRunning || isSubmitting}
            className={[
              'flex items-center gap-2 rounded-md bg-primary px-4 py-2',
              'text-primary-foreground transition-opacity hover:opacity-90',
              'disabled:cursor-not-allowed disabled:opacity-50',
            ].join(' ')}
          >
            <Send className="w-4 h-4" />
            {isSubmitting ? 'Sending' : 'Send'}
          </button>
        </form>
      </div>
    </div>
  );
}
