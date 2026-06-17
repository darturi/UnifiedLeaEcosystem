import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ApprovalDecision,
  ChatMessage,
  CodeStep,
  PendingApproval,
  RunStatus,
  SessionSummary,
  SessionStatus,
  StatusEvent,
} from '../api';
import { MarkdownMessage } from './MarkdownMessage';

type TimelineItem =
  | { kind: 'message'; key: string; message: ChatMessage }
  | { kind: 'code'; key: string; step: CodeStep; codeIndex: number };

export function ChatThread({
  title,
  model,
  session,
  runStatus,
  runStatusById,
  isRunning,
  items,
  statusEvents,
  activeCodeIndex,
  onSelectStep,
  pendingApproval,
  approvalBusy,
  onDecide,
  error,
  draft,
  onDraftChange,
  onSubmit,
  onInterrupt,
  canvasCollapsed,
  onToggleCanvas,
}: {
  title: string;
  model?: string;
  session?: SessionSummary;
  runStatus?: RunStatus;
  runStatusById: Record<string, string>;
  isRunning: boolean;
  items: TimelineItem[];
  statusEvents: StatusEvent[];
  activeCodeIndex: number;
  onSelectStep: (codeIndex: number) => void;
  pendingApproval?: PendingApproval;
  approvalBusy: boolean;
  onDecide: (decision: ApprovalDecision) => void;
  error?: string;
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  onInterrupt: () => void;
  canvasCollapsed: boolean;
  onToggleCanvas: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // M8: grow the composer with its content up to a cap, then scroll inside.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [draft]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight <= 60);
  }, []);
  useEffect(() => {
    if (autoScroll) requestAnimationFrame(scrollToBottom);
  }, [autoScroll, scrollToBottom, items, statusEvents, pendingApproval, error]);

  // tool chips for a step come from that turn's tool_call / lean_check status events.
  const toolsByTurn = useMemo(() => {
    const map = new Map<number, StatusEvent[]>();
    for (const event of statusEvents) {
      if (event.turn == null) continue;
      if (event.status !== 'tool_call' && event.status !== 'lean_check') continue;
      if (!map.has(event.turn)) map.set(event.turn, []);
      map.get(event.turn)!.push(event);
    }
    return map;
  }, [statusEvents]);

  // M11: a write's intent narration is also stamped on its code step's summary.
  // Fold it into the step card instead of showing it twice.
  const foldedNarration = useMemo(() => {
    const set = new Set<string>();
    for (const item of items) {
      if (item.kind === 'code' && item.step.summary) {
        set.add(`${item.step.run_id || ''}|${item.step.summary.trim()}`);
      }
    }
    return set;
  }, [items]);

  // Split the thread into contiguous per-run blocks (runs are sequential in seq
  // order). After a *finished* run that completed a proof (status 'success'), we
  // drop the green milestone card; a failed run gets a red one. The card is keyed
  // on the run's outcome, never on a message — so it lands once and stays (M16).
  const runGroups = useMemo(() => {
    const groups: { runId: string | null; items: TimelineItem[] }[] = [];
    for (const item of items) {
      const rid = item.kind === 'message' ? item.message.run_id ?? null : item.step.run_id ?? null;
      const last = groups[groups.length - 1];
      if (last && last.runId === rid) last.items.push(item);
      else groups.push({ runId: rid, items: [item] });
    }
    return groups;
  }, [items]);

  const sessionProved = useMemo(
    () => Object.values(runStatusById).includes('success'),
    [runStatusById],
  );
  const headChip = isRunning
    ? { cls: 'run', text: '● proving' }
    : sessionProved
    ? { cls: 'ok', text: '✓ proved' }
    : runStatus === 'failed' || runStatus === 'max_turns'
    ? { cls: 'fail', text: '✕ unproved' }
    : runStatus === 'cancelled'
    ? { cls: 'fail', text: '◼ stopped' }
    : null;

  // M18: show "Lea is thinking…" whenever a run is live and Lea isn't currently
  // streaming text (the gap after submit + between turns while a tool runs) and
  // we're not paused on an approval. The live bubble (live:true) means text is
  // already flowing, so the indicator yields to it.
  const thinking =
    isRunning &&
    !pendingApproval &&
    !items.some((i) => i.kind === 'message' && i.message.live);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isRunning && draft.trim()) onSubmit();
    }
  };

  const renderItem = (item: TimelineItem) => {
    if (item.kind === 'message') {
      const m = item.message;
      if (m.role === 'user') {
        return (
          <div className="msg" key={item.key}>
            <div className="role">
              <span className="avatar you">Y</span> You
            </div>
            <div className="user-bubble">{m.content}</div>
          </div>
        );
      }
      // Folded into its step card (M11) — don't render it as prose too.
      if (foldedNarration.has(`${m.run_id || ''}|${m.content.trim()}`)) return null;
      return (
        <div className="msg assistant" key={item.key}>
          <div className="role">
            <span className="avatar lea">L</span> Lea
          </div>
          <MarkdownMessage content={m.content} />
        </div>
      );
    }
    const step = item.step;
    const tools = step.turn != null ? toolsByTurn.get(step.turn) || [] : [];
    return (
      <button
        key={item.key}
        className={`step ${item.codeIndex === activeCodeIndex ? 'active' : ''}`}
        onClick={() => onSelectStep(item.codeIndex)}
      >
        <div className="step-head">
          <span className="step-num">{item.codeIndex + 1}</span>
          <span className="step-title">{stepTitle(step)}</span>
          <span className="step-jump">view snapshot →</span>
        </div>
        {(step.summary || tools.length > 0) && (
          <div className="step-body">
            {step.summary && <p>{step.summary}</p>}
            {tools.length > 0 && (
              <div className="step-tools">
                <span className="tlabel">worked via</span>
                {tools.map((t, i) => (
                  <ToolChip key={i} event={t} />
                ))}
              </div>
            )}
          </div>
        )}
      </button>
    );
  };

  return (
    <main className="chat">
      <div className="pane-head">
        <span className="ttl">{title}</span>
        {headChip && <span className={`chip ${headChip.cls}`}>{headChip.text}</span>}
        <span className="head-spacer" />
        {model && <span className="chip model">{model}</span>}
        <button className="canvas-toggle" onClick={onToggleCanvas}>
          ◧ {canvasCollapsed ? 'Show canvas' : 'Canvas'}
        </button>
      </div>

      <div className="thread" ref={scrollRef} onScroll={onScroll}>
        <div className="thread-inner">
          {items.length === 0 && !error && (
            <div className="thread-empty">
              Enter a theorem or natural-language proof task to start Lea.
            </div>
          )}

          {runGroups.map((group, gi) => {
            const isLastGroup = gi === runGroups.length - 1;
            const finished = !(isRunning && isLastGroup);
            const status = group.runId ? runStatusById[group.runId] : undefined;
            const steps = group.items.filter((i) => i.kind === 'code').length;
            return (
              <Fragment key={group.runId ?? `g${gi}`}>
                {group.items.map(renderItem)}
                {finished && status === 'success' && <ProvedCard steps={steps} session={session} />}
                {finished && (status === 'failed' || status === 'max_turns') && (
                  <FailedCard status={status} />
                )}
              </Fragment>
            );
          })}

          {thinking && (
            <div className="thinking">
              <span className="avatar lea">L</span>
              <span>Lea is thinking</span>
              <span className="dots">
                <i />
                <i />
                <i />
              </span>
            </div>
          )}

          {pendingApproval && (
            <ApprovalCard approval={pendingApproval} busy={approvalBusy} onDecide={onDecide} />
          )}

          {error && <div className="err-banner">{error}</div>}
        </div>
      </div>

      <div className="composer">
        <div className="composer-inner">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a follow-up, or state a theorem to prove…"
            rows={1}
          />
          <div className="crow">
            <span className="mode" title="Lea routes the request automatically">⚙ auto</span>
            {model && <span className="mode">{model}</span>}
            {isRunning ? (
              <button className="send stop" onClick={onInterrupt} title="Stop the run">
                ◼
              </button>
            ) : (
              <button className="send" onClick={onSubmit} disabled={!draft.trim()} title="Send">
                ↑
              </button>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function ToolChip({ event }: { event: StatusEvent }) {
  if (event.status === 'lean_check') {
    const ok = event.check_status === 'ok';
    return (
      <span className="tool">
        <span className="tname">lean_check</span>
        <span className={`tstat ${ok ? 'ok' : 'err'}`}>{ok ? '✓ 0 errors' : '✗ errors'}</span>
      </span>
    );
  }
  const name = (event.message || '').replace(/^Running\s+/, '') || 'tool';
  return (
    <span className="tool">
      <span className="tname">{name}</span>
    </span>
  );
}

// The "proof is done" milestone — keyed on the run's 'success' outcome, not on a
// message. Shows once, after the run that completed the proof.
function ProvedCard({ steps, session }: { steps: number; session?: SessionSummary }) {
  return (
    <div className="final">
      <div className="fhead">✓ Proved — 0 errors, 0 sorry</div>
      {session && (
        <div className="meta">
          <span>{steps} steps</span>
          {session.total_tokens ? <span>{formatTokens(session.total_tokens)} tokens</span> : null}
          {session.cost_usd ? <span>${session.cost_usd.toFixed(3)}</span> : null}
          {session.duration_seconds ? <span>{session.duration_seconds}s</span> : null}
        </div>
      )}
    </div>
  );
}

function FailedCard({ status }: { status: string }) {
  const label =
    status === 'max_turns' ? 'Stopped — hit the turn limit without finishing' : 'Did not complete';
  return (
    <div className="final bad">
      <div className="fhead">✕ {label}</div>
    </div>
  );
}

function ApprovalCard({
  approval,
  busy,
  onDecide,
}: {
  approval: PendingApproval;
  busy: boolean;
  onDecide: (decision: ApprovalDecision) => void;
}) {
  const preview = approvalPreview(approval);
  return (
    <div className="approval">
      <div className="ahead">🛡 Approve {approval.tool_name}?</div>
      {preview && <div className="acode">{preview}</div>}
      <div className="actions">
        <button className="btn accept" disabled={busy} onClick={() => onDecide('allow')}>
          Allow once
        </button>
        <button className="btn session" disabled={busy} onClick={() => onDecide('always_session')}>
          Always this session
        </button>
        <button className="btn reject" disabled={busy} onClick={() => onDecide('deny')}>
          Deny
        </button>
      </div>
    </div>
  );
}

function approvalPreview(approval: PendingApproval): string {
  const args = approval.args || {};
  if (approval.tool_name === 'bash' && typeof args.command === 'string') return args.command;
  const path = typeof args.path === 'string' ? args.path : '';
  const content =
    typeof args.content === 'string'
      ? args.content
      : typeof args.new_string === 'string'
      ? args.new_string
      : '';
  if (path || content) return [path, content].filter(Boolean).join('\n\n');
  return JSON.stringify(args, null, 2);
}

function stepTitle(step: CodeStep): string {
  // A short, generic label; the model's intent (step.summary) is the card body.
  const file = step.path.split('/').pop() || step.path;
  if (step.author === 'user') return `You edited ${file}`;
  return `Wrote ${file}`;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
