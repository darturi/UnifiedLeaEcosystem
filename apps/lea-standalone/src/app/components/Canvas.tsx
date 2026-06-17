import { useEffect, useMemo, useState } from 'react';
import type { CodeStep, SafeVerifyStatus } from '../api';
import { diffForStep } from '../codeDiff';
import { highlightLine } from '../leanHighlight.mjs';

export interface CheckOutcome {
  status: string;
  detail?: string | null;
}

// The right-hand canvas: navigable, syntax-highlighted Lean snapshots with a
// per-step verdict, plus direct editing → lean_check and SafeVerify on the
// latest snapshot. Network calls are delegated to the parent (which owns the
// session id + state) via onSaveAndCheck / onVerify.
export function Canvas({
  codeSteps,
  index,
  onIndexChange,
  isRunning,
  onClose,
  onSaveAndCheck,
  onVerify,
}: {
  codeSteps: CodeStep[];
  index: number;
  onIndexChange: (index: number) => void;
  isRunning: boolean;
  onClose: () => void;
  onSaveAndCheck: (content: string) => Promise<CheckOutcome>;
  onVerify: () => Promise<CheckOutcome>;
}) {
  const total = codeSteps.length;
  const safeIndex = Math.min(Math.max(index, 0), Math.max(total - 1, 0));
  const step = codeSteps[safeIndex];
  const isLatest = safeIndex === total - 1;

  const [editing, setEditing] = useState(false);
  const [draftCode, setDraftCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [foot, setFoot] = useState<{ kind: 'idle' | 'ok' | 'bad'; text: string } | null>(null);
  const [verify, setVerify] = useState<{ status: SafeVerifyStatus; detail?: string | null } | null>(null);

  // Leaving the step or starting a run cancels an in-progress edit.
  useEffect(() => {
    setEditing(false);
    setFoot(null);
    setVerify(null);
  }, [safeIndex, step?.id]);
  useEffect(() => {
    if (isRunning) setEditing(false);
  }, [isRunning]);

  const rows = useMemo(() => {
    if (!step) return [];
    // diffForStep returns unchanged/added/removed; the current file is the
    // non-removed rows, with 'added' lines tinted green like the mockup.
    return diffForStep(codeSteps, safeIndex).filter((r: any) => r.kind !== 'removed');
  }, [codeSteps, safeIndex, step]);

  const beginEdit = () => {
    setDraftCode(step?.code ?? '');
    setFoot(null);
    setEditing(true);
  };

  const runCheck = async () => {
    setBusy(true);
    setFoot({ kind: 'idle', text: 'running lean_check…' });
    try {
      const result = await onSaveAndCheck(draftCode);
      if (result.status === 'ok') {
        setEditing(false);
        setFoot({ kind: 'ok', text: 'lean_check: 0 errors · your manual check' });
      } else {
        setFoot({ kind: 'bad', text: result.detail || 'lean_check reported errors' });
      }
    } catch (err) {
      setFoot({ kind: 'bad', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const runVerify = async () => {
    setBusy(true);
    setVerify({ status: 'running' });
    try {
      const result = await onVerify();
      setVerify({ status: result.status as SafeVerifyStatus, detail: result.detail });
    } catch (err) {
      setVerify({ status: 'error', detail: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const verdict = editing
    ? { cls: 'idle', text: '● editing — unsaved' }
    : step?.check_status === 'ok'
    ? { cls: 'ok', text: '✓ compiles' }
    : step?.check_status === 'error'
    ? { cls: 'err', text: '✗ errors' }
    : { cls: 'idle', text: '○ not checked' };

  return (
    <section className="canvas">
      <div className="canvas-head">
        <span className="file">{step ? step.path : 'no file yet'}</span>
        <span className="head-spacer" />
        {step && isLatest && !isRunning && (
          editing ? (
            <button className="cv-btn" onClick={() => setEditing(false)} disabled={busy}>
              ✕ Cancel
            </button>
          ) : (
            <button className="cv-btn" onClick={beginEdit}>
              ✎ Edit
            </button>
          )
        )}
        {editing && (
          <button className="cv-btn run" onClick={runCheck} disabled={busy}>
            ▶ Run lean_check
          </button>
        )}
        <button className="x" onClick={onClose} title="Hide canvas">
          ✕
        </button>
      </div>

      {editing && (
        <div className="edit-hint">
          ✎ You're editing this file directly. Run <code>lean_check</code> to verify — Lea picks up
          from whatever you leave here.
        </div>
      )}

      {total > 0 && (
        <div className="stepper">
          <button className="nav" onClick={() => onIndexChange(safeIndex - 1)} disabled={safeIndex === 0 || editing}>
            ‹
          </button>
          <button
            className="nav"
            onClick={() => onIndexChange(safeIndex + 1)}
            disabled={safeIndex === total - 1 || editing}
          >
            ›
          </button>
          <span className="label">
            Step {safeIndex + 1} of {total}
            {step?.turn ? <span className="stepname"> · turn {step.turn}</span> : null}
            {step?.author === 'user' ? <span className="stepname"> · your edit</span> : null}
          </span>
          <span className="spacer" />
          <span className={`verdict ${verdict.cls}`}>{verdict.text}</span>
        </div>
      )}

      {!step ? (
        <div className="canvas-empty">Lean code will appear here as Lea edits files.</div>
      ) : (
        <div className="code-wrap">
          {editing ? (
            <pre
              className="code editing"
              contentEditable
              suppressContentEditableWarning
              onInput={(e) => setDraftCode((e.target as HTMLElement).innerText)}
            >
              {step.code}
            </pre>
          ) : (
            <pre className="code">
              {rows.map((row: any, i: number) => (
                <div key={i} className={`ln ${row.kind === 'added' ? 'add' : ''}`}>
                  <span className="gut">{row.newLineNumber ?? ''}</span>
                  <span className="src">
                    {highlightLine(row.line).map((s: any, j: number) =>
                      s.cls ? (
                        <span key={j} className={s.cls}>
                          {s.text}
                        </span>
                      ) : (
                        <span key={j}>{s.text}</span>
                      ),
                    )}
                    {row.line === '' ? ' ' : ''}
                  </span>
                </div>
              ))}
            </pre>
          )}
        </div>
      )}

      <div className="canvas-foot">
        {foot ? (
          foot.kind === 'ok' ? (
            <span className="badge compile">✓ {foot.text}</span>
          ) : foot.kind === 'bad' ? (
            <span className="err-detail">{foot.text}</span>
          ) : (
            <span>{foot.text}</span>
          )
        ) : step?.check_status === 'ok' ? (
          <span className="badge compile">✓ lean_check: 0 errors</span>
        ) : step?.check_status === 'error' ? (
          <span className="err-detail">{step.check_detail || 'lean_check: errors'}</span>
        ) : (
          <span className="badge idle">○ not checked yet</span>
        )}

        {verify ? (
          verify.status === 'running' ? (
            <span className="badge idle">🛡 SafeVerify…</span>
          ) : verify.status === 'ok' ? (
            <span className="badge sv">🛡 SafeVerify ✓</span>
          ) : (
            <span className="badge bad" title={verify.detail || ''}>
              🛡 SafeVerify {verify.status}
            </span>
          )
        ) : (
          step &&
          isLatest &&
          !editing &&
          !isRunning &&
          step.check_status === 'ok' && (
            <button className="cv-btn" onClick={runVerify} disabled={busy}>
              🛡 Run SafeVerify
            </button>
          )
        )}
      </div>
    </section>
  );
}
