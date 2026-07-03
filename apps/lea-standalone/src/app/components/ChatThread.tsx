import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, PanelLeftOpen } from 'lucide-react';
import { sessionExportUrl } from '../lib/api';
import type {
  ApprovalDecision,
  ApprovalRecord,
  ChatMessage,
  CodeStep,
  PendingApproval,
  SessionSummary,
  StatusEvent,
  TimelineItem,
} from '../lib/api';
import { MarkdownMessage } from './MarkdownMessage';
import { ModelPicker } from './ModelPicker';
import { OriginBadge } from './OriginBadge';
import { buildTimeline } from '../lib/timeline.mjs';
import {
  deriveCodeStepProofStatus,
  deriveRunCompletionStatus,
  hasSorryLikeCheckDetail,
  latestCodeStep,
} from '../lib/proofDisplay.mjs';
import { useProofSession } from '../stores/proofSession';
import { useModel } from '../stores/model';

type MergedNode =
  | { kind: 'message'; key: string; runId: string | null; seqKey: number; message: ChatMessage }
  | { kind: 'code'; key: string; runId: string | null; seqKey: number; step: CodeStep; codeIndex: number }
  | { kind: 'approval'; key: string; runId: string | null; seqKey: number; approval: ApprovalRecord };

export function ChatThread({
  title,
  sidebarCollapsed,
  onExpandSidebar,
  session,
  onSelectStep,
  onDecide,
  draft,
  onDraftChange,
  onSubmit,
  onInterrupt,
  onOpenSettings,
  canvasCollapsed,
  onToggleCanvas,
}: {
  title: string;
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
  session?: SessionSummary;
  onSelectStep: (codeIndex: number) => void;
  onDecide: (decision: ApprovalDecision) => void;
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  onInterrupt: () => void;
  onOpenSettings?: () => void;
  canvasCollapsed: boolean;
  onToggleCanvas: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  // R4: model picker state + key-missing nudge from the model store.
  const model = useModel((s) => s.model);
  const modelCatalog = useModel((s) => s.modelCatalog);
  const modelFeatured = useModel((s) => s.modelFeatured);
  const keyMissing = useModel((s) => s.keyMissing);
  const onModelChange = useModel((s) => s.changeModel);
  // R1a/R1b/R1c: read shared proof-session state straight from the store (no props).
  const editedPath = useProofSession((s) => s.editedPath);
  // SafeVerify result surfaced from Edit mode as a box above the composer.
  const verifySurface = useProofSession((s) => s.verifySurface);
  const setVerifySurface = useProofSession((s) => s.setVerifySurface);
  const [verifyCollapsed, setVerifyCollapsed] = useState(false);
  // A fresh result re-opens the box (expanded).
  useEffect(() => {
    setVerifyCollapsed(false);
  }, [verifySurface]);

  // Push the SafeVerify output into the composer as a fix-it prompt, then focus so
  // the user can add context or just send. Appends if the draft already has text.
  const sendVerifyToDraft = () => {
    if (!verifySurface) return;
    const head =
      verifySurface.status === 'ok'
        ? 'SafeVerify passed, but here is the output:'
        : `SafeVerify reported "${verifySurface.status}" on this proof:`;
    const prompt = `${head}\n\n${verifySurface.detail ?? ''}\n\nPlease fix the proof so it passes SafeVerify.`.trim();
    onDraftChange(draft.trim() ? `${draft.trim()}\n\n${prompt}` : prompt);
    setVerifySurface(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const error = useProofSession((s) => s.error);
  const activeCodeIndex = useProofSession((s) => s.codeIndex);
  const messages = useProofSession((s) => s.messages);
  const codeSteps = useProofSession((s) => s.codeSteps);
  const statusEvents = useProofSession((s) => s.statusEvents);
  // R1c-2b: run lifecycle + approvals from the store.
  const runStatus = useProofSession((s) => s.runStatus);
  const runStatusById = useProofSession((s) => s.runStatusById);
  const runResultKindById = useProofSession((s) => s.runResultKindById);
  const isRunning = useProofSession((s) => s.isRunning);
  const currentRunId = useProofSession((s) => s.currentRunId);
  const approvals = useProofSession((s) => s.approvals);
  const approvalBusy = useProofSession((s) => s.approvalBusy);
  // R1c-2a: the timeline is derived here from store messages + codeSteps.
  const { items } = useMemo<{ items: TimelineItem[] }>(
    () => (buildTimeline as any)({ messages, codeSteps }) as { items: TimelineItem[] },
    [messages, codeSteps],
  );

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
  }, [autoScroll, scrollToBottom, items, statusEvents, approvals, error]);

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
  // order). After a *finished* run that completed a checked artifact, we drop the
  // appropriate outcome card. The card is keyed on the run's outcome, never on a
  // message — so it lands once and stays (M16).
  const runGroups = useMemo(() => {
    const nodes: MergedNode[] = [];
    for (const it of items) {
      if (it.kind === 'message') {
        nodes.push({
          kind: 'message',
          key: it.key,
          runId: it.message.run_id ?? null,
          seqKey: it.message.seq ?? Number.MAX_SAFE_INTEGER,
          message: it.message,
        });
      } else {
        nodes.push({
          kind: 'code',
          key: it.key,
          runId: it.step.run_id ?? null,
          seqKey: it.step.seq ?? Number.MAX_SAFE_INTEGER,
          step: it.step,
          codeIndex: it.codeIndex,
        });
      }
    }
    for (const a of approvals) {
      nodes.push({
        kind: 'approval',
        key: `a:${a.approval_id}`,
        runId: a.run_id ?? null,
        seqKey: typeof a.seq === 'number' ? a.seq : Number.MAX_SAFE_INTEGER,
        approval: a,
      });
    }
    nodes.sort((x, y) => x.seqKey - y.seqKey || x.key.localeCompare(y.key));
    const groups: { runId: string | null; nodes: MergedNode[] }[] = [];
    for (const node of nodes) {
      const last = groups[groups.length - 1];
      if (last && last.runId === node.runId) last.nodes.push(node);
      else groups.push({ runId: node.runId, nodes: [node] });
    }
    return groups;
  }, [items, approvals]);

  const latestProofStatus = useMemo(
    () => deriveCodeStepProofStatus(latestCodeStep(codeSteps)),
    [codeSteps],
  );
  const latestRunOutcome = useMemo(
    () => {
      const values = Object.values(runStatusById);
      return values.length ? values[values.length - 1] : undefined;
    },
    [runStatusById],
  );
  const latestRunResultKind = useMemo(
    () => {
      const values = Object.values(runResultKindById);
      return values.length ? values[values.length - 1] : undefined;
    },
    [runResultKindById],
  );
  const headChip = isRunning
    ? { cls: 'run', text: '● proving' }
    : latestProofStatus === 'stubbed'
    ? { cls: 'run', text: '○ stubbed' }
    : latestRunOutcome === 'disproved' && latestProofStatus === 'proved'
    ? { cls: 'warn', text: '⊘ disproved' }
    : (latestRunOutcome === 'proved' || latestRunOutcome === 'success') &&
        latestRunResultKind === 'defined' &&
        latestProofStatus === 'proved'
    ? { cls: 'ok', text: '✓ defined' }
    : (latestRunOutcome === 'proved' || latestRunOutcome === 'success') && latestProofStatus === 'proved'
    ? { cls: 'ok', text: '✓ proved' }
    : runStatus === 'needs_review' || latestRunOutcome === 'needs_review'
    ? { cls: 'run', text: '○ review' }
    : runStatus === 'failed' || runStatus === 'max_turns'
    ? { cls: 'fail', text: '✕ unproved' }
    : runStatus === 'cancelled'
    ? { cls: 'fail', text: '◼ stopped' }
    : null;

  // M18: show "Lea is thinking…" whenever a run is live and Lea isn't currently
  // streaming text (the gap after submit + between turns while a tool runs) and
  // we're not paused on an approval. The live bubble (live:true) means text is
  // already flowing, so the indicator yields to it.
  const hasPendingApproval = approvals.some((a) => !a.decision);
  const thinking =
    isRunning &&
    !hasPendingApproval &&
    !items.some((i) => i.kind === 'message' && i.message.live);

  // M17: the tool Lea is currently running (all tools), scoped to the active run
  // so a prior run's last tool never leaks in. Drives the activity label.
  const activity = useMemo(() => {
    if (!thinking) return null;
    for (let i = statusEvents.length - 1; i >= 0; i -= 1) {
      const s = statusEvents[i];
      if (currentRunId && s.run_id && s.run_id !== currentRunId) continue;
      if (s.status === 'tool_call' || s.status === 'lean_check') return activityLabel(s);
    }
    return null;
  }, [thinking, statusEvents, currentRunId]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isRunning && draft.trim()) onSubmit();
    }
  };

  const renderNode = (node: MergedNode) => {
    if (node.kind === 'approval') {
      return (
        <ApprovalCard
          key={node.key}
          approval={node.approval}
          decision={node.approval.decision}
          busy={approvalBusy}
          onDecide={onDecide}
        />
      );
    }
    if (node.kind === 'message') {
      const m = node.message;
      if (m.role === 'user') {
        return (
          <div className="msg" key={node.key}>
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
        <div className="msg assistant" key={node.key}>
          <div className="role">
            <span className="avatar lea">L</span> Lea
          </div>
          <MarkdownMessage content={m.content} />
        </div>
      );
    }
    const step = node.step;
    const tools = step.turn != null ? toolsByTurn.get(step.turn) || [] : [];
    return (
      <button
        key={node.key}
        className={`step ${node.codeIndex === activeCodeIndex ? 'active' : ''}`}
        onClick={() => onSelectStep(node.codeIndex)}
      >
        <div className="step-head">
          <span className="step-num">{node.codeIndex + 1}</span>
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
        {sidebarCollapsed && (
          <button className="icon-btn" onClick={onExpandSidebar} title="Open sidebar">
            <PanelLeftOpen size={15} />
          </button>
        )}
        <span className="ttl">{title}</span>
        {headChip && <span className={`chip ${headChip.cls}`}>{headChip.text}</span>}
        <OriginBadge origin={session?.origin} originUrl={session?.origin_url} />
        <span className="head-spacer" />
        {/* Download this session's files as a zip (#14). Loose sessions only — a
            project session's files download from the project's Filesystem tab. Shown
            once the session has written at least one file (else export would 404). */}
        {session && !session.project_id && codeSteps.length > 0 && (
          <a
            className="head-download"
            href={sessionExportUrl(session.id)}
            download
            title="Download this session's files as a zip"
          >
            <Download size={13} /> Download
          </a>
        )}
        <ModelPicker
          value={model || ''}
          onChange={onModelChange}
          catalog={modelCatalog}
          featured={modelFeatured}
        />
        {/* Only a "Show canvas" affordance when the canvas is hidden — when it's
            open the Canvas's own × closes it, so a second toggle here is redundant. */}
        {canvasCollapsed && (
          <button className="canvas-toggle" onClick={onToggleCanvas}>
            ◧ Show canvas
          </button>
        )}
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
            const codeNodes = group.nodes.filter(
              (n): n is Extract<MergedNode, { kind: 'code' }> => n.kind === 'code',
            );
            const codeStepList = codeNodes.map((n) => n.step);
            const steps = codeStepList.length;
            const resultKind = group.runId ? runResultKindById[group.runId] : undefined;
            const completion = deriveRunCompletionStatus(status, codeStepList, resultKind);
            return (
              <Fragment key={group.runId ?? `g${gi}`}>
                {group.nodes.map(renderNode)}
                {finished && completion === 'proved' && <ProvedCard steps={steps} session={session} />}
                {finished && completion === 'defined' && <DefinedCard steps={steps} session={session} />}
                {finished && completion === 'disproved' && <DisprovedCard steps={steps} session={session} />}
                {finished && completion === 'needs_review' && <NeedsReviewCard />}
                {finished && completion === 'stubbed' && <StubCard steps={steps} session={session} />}
                {finished && (completion === 'failed' || completion === 'max_turns') && (
                  <FailedCard status={completion} />
                )}
              </Fragment>
            );
          })}

          {thinking && (
            <div className="thinking">
              <span className="avatar lea">L</span>
              <span>{activity ? activity : 'Lea is thinking'}</span>
              <span className="dots">
                <i />
                <i />
                <i />
              </span>
            </div>
          )}

          {error && <div className="err-banner">{error}</div>}
        </div>
      </div>

      <div className="composer">
        {keyMissing && (
          <div className="key-nudge">
            <span>
              👋 To start proving, add your model preference and API key.
            </span>
            <button className="key-nudge-btn" onClick={onOpenSettings}>
              Open Settings
            </button>
          </div>
        )}
        {editedPath && (
          <div className="edit-badge">
            ✎ You edited <code>{editedPath.split('/').pop()}</code> — describe your change so Lea
            picks up where you left off.
          </div>
        )}
        {verifySurface && (
          <div className={`verify-box ${verifySurface.status === 'ok' ? 'ok' : 'bad'}`}>
            <div className="verify-box-head">
              <span className="verify-box-title">
                🛡 SafeVerify {verifySurface.status === 'ok' ? '✓ passed' : verifySurface.status}
              </span>
              <span className="verify-box-spacer" />
              {verifySurface.detail && (
                <button
                  className="verify-box-icon"
                  onClick={() => setVerifyCollapsed((c) => !c)}
                  title={verifyCollapsed ? 'Expand' : 'Collapse'}
                >
                  {verifyCollapsed ? '▸' : '▾'}
                </button>
              )}
              <button
                className="verify-box-icon"
                onClick={() => setVerifySurface(null)}
                title="Dismiss"
              >
                ✕
              </button>
            </div>
            {!verifyCollapsed && verifySurface.detail && (
              <pre className="verify-box-detail">{verifySurface.detail}</pre>
            )}
            {verifySurface.status !== 'ok' && (
              <div className="verify-box-actions">
                <button className="verify-box-fix" onClick={sendVerifyToDraft}>
                  ↑ Send to Lea to fix
                </button>
              </div>
            )}
          </div>
        )}
        <div className="composer-inner">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              editedPath
                ? 'What did you change? A short note helps Lea pick up where you left off.'
                : 'Ask a follow-up, or state a theorem to prove…'
            }
            rows={1}
          />
          <div className="crow">
            <span className="mode" title="Lea routes the request automatically">⚙ auto</span>
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
    const stubbed = ok && hasSorryLikeCheckDetail(event.check_detail);
    return (
      <span className="tool">
        <span className="tname">lean_check</span>
        <span className={`tstat ${stubbed ? 'stub' : ok ? 'ok' : 'err'}`}>
          {stubbed ? '✓ 0 errors · sorry' : ok ? '✓ 0 errors' : '✗ errors'}
        </span>
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

// The "proof is done" milestone — keyed on the run's 'proved' outcome, not on a
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

function DefinedCard({ steps, session }: { steps: number; session?: SessionSummary }) {
  return (
    <div className="final">
      <div className="fhead">✓ Definition created — 0 errors</div>
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

function DisprovedCard({ steps, session }: { steps: number; session?: SessionSummary }) {
  return (
    <div className="final disproof">
      <div className="fhead">⊘ Counterexample found — the original statement was disproven, not proven</div>
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

function NeedsReviewCard() {
  return (
    <div className="final stub">
      <div className="fhead">○ Checked artifact needs review — Lea could not classify it as proof or disproof</div>
    </div>
  );
}

function StubCard({ steps, session }: { steps: number; session?: SessionSummary }) {
  return (
    <div className="final stub">
      <div className="fhead">✓ Stub checked — 0 errors, proof still contains sorry</div>
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
  decision,
  busy,
  onDecide,
}: {
  approval: PendingApproval;
  decision?: string | null;
  busy: boolean;
  onDecide: (decision: ApprovalDecision) => void;
}) {
  const preview = approvalPreview(approval);
  const resolved = !!decision;
  return (
    <div className={`approval ${resolved ? 'resolved' : ''}`}>
      <div className="ahead">
        🛡{' '}
        {resolved
          ? decisionHeadline(decision as string, approval.tool_name)
          : `Approve ${approval.tool_name}?`}
      </div>
      {preview && <div className="acode">{preview}</div>}
      {resolved ? (
        <span
          className="resolved-tag"
          style={decision === 'deny' ? { color: 'var(--red)' } : undefined}
        >
          {decisionTag(decision as string)}
        </span>
      ) : (
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
      )}
    </div>
  );
}

function decisionHeadline(decision: string, tool: string): string {
  if (decision === 'allow') return `Allowed ${tool} once`;
  if (decision === 'always_session') return `Always allowing ${tool} this session`;
  if (decision === 'deny') return `Denied ${tool}`;
  return `${tool} — resolved`;
}

function decisionTag(decision: string): string {
  if (decision === 'allow') return '✓ you allowed this once';
  if (decision === 'always_session') return '✓ you allowed this for the session';
  if (decision === 'deny') return '⛔ you denied this';
  return 'resolved';
}

// Absolute proof paths are long and noisy. Show only what matters: the path
// relative to the session repo (everything after `proofs/<session-id>/`).
function shortPath(p: string): string {
  const m = p.match(/[/\\]proofs[/\\][^/\\]+[/\\](.+)$/);
  return m ? m[1].replace(/\\/g, '/') : p;
}

function approvalPreview(approval: PendingApproval): string {
  const args = approval.args || {};
  if (approval.tool_name === 'bash' && typeof args.command === 'string') return args.command;
  const path = typeof args.path === 'string' ? shortPath(args.path) : '';
  const content =
    typeof args.content === 'string'
      ? args.content
      : typeof args.new_string === 'string'
      ? args.new_string
      : '';
  if (path || content) return [path, content].filter(Boolean).join('\n\n');
  return JSON.stringify(args, null, 2);
}

// Friendly "what Lea is doing" label for a tool_call / lean_check status event,
// covering every tool (M17).
const TOOL_ACTIVITY: Record<string, string> = {
  search_mathlib: '🔍 Searching Mathlib',
  bash: '💻 Running a shell command',
  read_file: '📖 Reading a file',
  write_file: '✎ Writing the proof',
  edit_file: '✎ Editing the proof',
  lean_check: '⚙ Checking with Lean',
};

function activityLabel(event: StatusEvent): string {
  if (event.status === 'lean_check') return TOOL_ACTIVITY.lean_check;
  const name = (event.message || '').replace(/^Running\s+/, '').trim();
  return TOOL_ACTIVITY[name] || `⚙ Running ${name || 'a tool'}`;
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
