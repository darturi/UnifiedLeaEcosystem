import { useEffect, useMemo, useState } from 'react';
import type { CodeStep, SafeVerifyStatus } from '../lib/api';
import { diffForStep } from '../lib/codeDiff';
import { ensureHighlighter, highlightToLines, isHighlighterReady } from '../lib/leanHighlight.mjs';
import {
  deriveCodeStepProofStatus,
  hasSorryLikeCheckDetail,
  hasSorryLikeCode,
} from '../lib/proofDisplay.mjs';
import { sortCodeSteps } from '../lib/timeline.mjs';
import { distinctFiles, latestIndexForPath, mainFilePath } from '../lib/canvasFiles.mjs';
import { useProofSession } from '../stores/proofSession';

export interface CheckOutcome {
  status: string;
  detail?: string | null;
}

// The right-hand canvas: navigable, syntax-highlighted Lean snapshots with a
// per-step verdict, plus direct editing → lean_check and SafeVerify on the
// latest snapshot. Network calls are delegated to the parent (which owns the
// session id + state) via onSaveAndCheck / onVerify.
export function Canvas({
  onClose,
  onSaveAndCheck,
  onVerify,
}: {
  onClose: () => void;
  onSaveAndCheck: (content: string, path?: string) => Promise<CheckOutcome>;
  onVerify: (path?: string) => Promise<CheckOutcome>;
}) {
  // R1b/R1c: canvas state (verdict, snapshots, stepper position, run-active flag)
  // comes straight from the store now — no props from App.
  const persistedVerify = useProofSession((s) => s.safeVerify);
  const isRunning = useProofSession((s) => s.isRunning);
  const rawSteps = useProofSession((s) => s.codeSteps);
  const codeSteps = useMemo(() => sortCodeSteps(rawSteps), [rawSteps]);
  const index = useProofSession((s) => s.codeIndex);
  const onIndexChange = useProofSession((s) => s.setCodeIndex);
  const total = codeSteps.length;
  const safeIndex = Math.min(Math.max(index, 0), Math.max(total - 1, 0));
  const step = codeSteps[safeIndex];

  // File model (#10): a session can touch several files (a main proof + throwaway
  // `scratch` probes). `shownPath` is the file currently in view; `isFileCurrent` is
  // true when the shown step is the newest snapshot OF THAT FILE — so Edit / Run
  // SafeVerify / the verdict stay available on the main proof even when a scratch
  // write is the newest step overall (the old `isLatest === total-1` hid them).
  const shownPath = step?.path;
  const files = useMemo(() => distinctFiles(codeSteps), [codeSteps]);
  const mainPath = useMemo(() => mainFilePath(codeSteps), [codeSteps]);
  const isFileCurrent = !!step && safeIndex === latestIndexForPath(codeSteps, shownPath);
  const pickFile = (path: string) => onIndexChange(latestIndexForPath(codeSteps, path));

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

  // Lean highlighting via Shiki (#11). The highlighter loads async once per session;
  // `hlReady` flips true when it's in, triggering a re-highlight. `tokenLines` is the
  // whole snapshot tokenized (so multi-line /- -/ block comments highlight correctly),
  // indexed by source line; a row picks its tokens by its new-file line number. Null
  // (still loading / no code) → the rows fall back to plain text, never blank.
  const [hlReady, setHlReady] = useState(isHighlighterReady());
  useEffect(() => {
    if (hlReady) return;
    let cancelled = false;
    ensureHighlighter()
      .then(() => !cancelled && setHlReady(true))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [hlReady]);
  const tokenLines = useMemo(
    () => (hlReady && step?.code ? highlightToLines(step.code) : null),
    [hlReady, step?.code],
  );

  const beginEdit = () => {
    setDraftCode(step?.code ?? '');
    setFoot(null);
    setEditing(true);
  };

  const runCheck = async () => {
    setBusy(true);
    setFoot({ kind: 'idle', text: 'running lean_check…' });
    try {
      const result = await onSaveAndCheck(draftCode, shownPath);
      if (result.status === 'ok') {
        setEditing(false);
        const hasStub = hasSorryLikeCode(draftCode) || hasSorryLikeCheckDetail(result.detail);
        setFoot({
          kind: hasStub ? 'idle' : 'ok',
          text: hasStub
            ? 'lean_check: 0 errors · contains sorry'
            : 'lean_check: 0 errors · your manual check',
        });
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
      const result = await onVerify(shownPath);
      setVerify({ status: result.status as SafeVerifyStatus, detail: result.detail });
    } catch (err) {
      setVerify({ status: 'error', detail: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const proofStatus = deriveCodeStepProofStatus(step);
  const verdict = editing
    ? { cls: 'idle', text: '● editing — unsaved' }
    : proofStatus === 'proved'
    ? { cls: 'ok', text: '✓ compiles' }
    : proofStatus === 'stubbed'
    ? { cls: 'stub', text: '○ checked stub' }
    : proofStatus === 'failed'
    ? { cls: 'err', text: '✗ errors' }
    : { cls: 'idle', text: '○ not checked' };

  // Live result (this session) wins; otherwise fall back to the persisted verdict
  // when viewing the shown file's current snapshot, so a reload still shows
  // SafeVerify ✓ (M24) — and it stays on the main proof, not a later scratch.
  const shownVerify = verify ?? (isFileCurrent ? persistedVerify ?? null : null);

  return (
    <section className="canvas">
      <div className="canvas-head">
        {files.length > 1 ? (
          <FileSelect files={files} current={shownPath} mainPath={mainPath} onPick={pickFile} />
        ) : (
          <span className="file">{step ? step.path : 'no file yet'}</span>
        )}
        <span className="head-spacer" />
        {step && isFileCurrent && !isRunning && (
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
                    {renderLineTokens(tokenLines, row)}
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
          ) : foot.text.includes('contains sorry') ? (
            <span className="badge stub">✓ {foot.text}</span>
          ) : (
            <span>{foot.text}</span>
          )
        ) : proofStatus === 'proved' ? (
          <span className="badge compile">✓ lean_check: 0 errors</span>
        ) : proofStatus === 'stubbed' ? (
          <span className="badge stub">✓ lean_check: 0 errors · contains sorry</span>
        ) : step?.check_status === 'error' ? (
          <span className="err-detail">{step.check_detail || 'lean_check: errors'}</span>
        ) : (
          <span className="badge idle">○ not checked yet</span>
        )}

        {shownVerify ? (
          shownVerify.status === 'running' ? (
            <span className="badge idle">🛡 SafeVerify…</span>
          ) : shownVerify.status === 'ok' ? (
            <span className="badge sv">🛡 SafeVerify ✓</span>
          ) : (
            // rejected / error / unavailable: show the badge AND the detail inline.
            // The detail is *why* it failed (kernel-audit output, axiom violation,
            // build issue) — it must be visible, not hidden in a hover tooltip.
            <span className="sv-fail">
              <span className="badge bad">🛡 SafeVerify {shownVerify.status}</span>
              {shownVerify.detail && (
                <span className="err-detail">{shownVerify.detail}</span>
              )}
            </span>
          )
        ) : (
          step &&
          isFileCurrent &&
          !editing &&
          !isRunning &&
          proofStatus === 'proved' && (
            <button className="cv-btn" onClick={runVerify} disabled={busy}>
              🛡 Run SafeVerify
            </button>
          )
        )}
      </div>
    </section>
  );
}

type FileMeta = { path: string; isScratch: boolean; latestIndex: number; count: number };

function baseName(path: string): string {
  return path.split('/').pop() || path;
}

// The canvas file selector (#10): pick which file the canvas shows + which file
// SafeVerify/lean_check act on. Main (non-scratch) files first, then a dimmed
// "scratch" group. Picking a file jumps the stepper to that file's latest snapshot.
function FileSelect({
  files,
  current,
  mainPath,
  onPick,
}: {
  files: FileMeta[];
  current?: string;
  mainPath: string | null;
  onPick: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Non-scratch first, each group most-recently-touched first.
  const sorted = [...files].sort(
    (a, b) => Number(a.isScratch) - Number(b.isScratch) || b.latestIndex - a.latestIndex,
  );
  const mains = sorted.filter((f) => !f.isScratch);
  const scratch = sorted.filter((f) => f.isScratch);
  const pick = (path: string) => {
    onPick(path);
    setOpen(false);
  };
  const row = (f: FileMeta) => (
    <button
      key={f.path}
      className={`cv-file-row ${f.path === current ? 'active' : ''} ${f.isScratch ? 'scratch' : ''}`}
      onClick={() => pick(f.path)}
      title={f.path}
    >
      <span className="cv-file-dot" />
      <span className="cv-file-row-name">{baseName(f.path)}</span>
      {f.path === mainPath && <span className="cv-file-tag">main</span>}
    </button>
  );
  return (
    <div className="cv-file-select">
      <button className="cv-file-btn" onClick={() => setOpen((o) => !o)} title={current}>
        📄 <span className="cv-file-name">{current ? baseName(current) : 'no file'}</span>
        <span className="cv-file-caret">▾</span>
      </button>
      {open && (
        <>
          <div className="cv-file-backdrop" onClick={() => setOpen(false)} />
          <div className="cv-file-menu">
            {mains.map(row)}
            {scratch.length > 0 && <div className="cv-file-group">scratch</div>}
            {scratch.map(row)}
          </div>
        </>
      )}
    </div>
  );
}

// Render one diff row's source using its Shiki tokens (colors inline from the
// theme). Tokens are keyed by the row's new-file line number, so this stays aligned
// with the gutter. Falls back to the raw line text while the highlighter loads or if
// a line has no tokens. Shiki fontStyle is a bitmask (Italic=1, Bold=2, Underline=4).
function renderLineTokens(tokenLines: any[] | null, row: any) {
  const toks =
    tokenLines && row.newLineNumber != null ? tokenLines[row.newLineNumber - 1] : null;
  if (!toks) return row.line;
  return toks.map((t: any, j: number) => (
    <span
      key={j}
      style={{
        color: t.color,
        fontStyle: t.fontStyle & 1 ? 'italic' : undefined,
        fontWeight: t.fontStyle & 2 ? 600 : undefined,
        textDecoration: t.fontStyle & 4 ? 'underline' : undefined,
      }}
    >
      {t.content}
    </span>
  ));
}
