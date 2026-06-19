import { useEffect, useState } from 'react';
import { Pencil } from 'lucide-react';
import { getProjectDoc, putProjectDoc, type ProjectDocName } from '../lib/api';
import { MarkdownMessage } from './MarkdownMessage';

// One reusable editor for a project's `.lea/*.md` docs (D39) — backs the Instructions
// and Memory rail cards (and, later, Blueprint authoring). Rendered view via
// MarkdownMessage; an edit mode swaps in a textarea that PUTs on Save. `agentWritten`
// docs (Memory) re-fetch when `refreshSignal` changes, so a run that edits memory.md
// shows up without a manual reload.
export function MarkdownDoc({
  projectId,
  doc,
  title,
  icon,
  agentWritten = false,
  refreshSignal = 0,
  emptyHint,
}: {
  projectId: string;
  doc: ProjectDocName;
  title: string;
  icon?: string;
  agentWritten?: boolean;
  refreshSignal?: number;
  emptyHint?: string;
}) {
  const [content, setContent] = useState('');
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load on mount / project change, and re-load on refreshSignal for agent-written
  // docs — but never clobber an in-progress edit.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getProjectDoc(projectId, doc)
      .then((text) => {
        if (cancelled) return;
        setContent(text);
        if (!editing) setError(null);
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, doc, refreshSignal]);

  const startEdit = () => {
    setDraft(content);
    setError(null);
    setEditing(true);
  };

  const cancel = () => {
    setEditing(false);
    setError(null);
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await putProjectDoc(projectId, doc, draft);
      setContent(result.content);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const hasContent = content.trim().length > 0;

  return (
    <section className="rail-card">
      <header className="rail-card-head">
        <span className="rail-card-title">
          {icon && <span className="rail-card-icon">{icon}</span>}
          {title}
          {agentWritten && (
            <span className="rail-card-badge" title="Co-authored: Lea updates this as it works, and so can you">
              Lea + you
            </span>
          )}
        </span>
        {!editing && (
          <button className="rail-card-edit" onClick={startEdit} title={`Edit ${title}`}>
            <Pencil size={13} /> Edit
          </button>
        )}
      </header>

      {editing ? (
        <div className="rail-card-editor">
          <textarea
            className="rail-card-textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`# ${title}\n\nMarkdown…`}
            autoFocus
          />
          {error && <div className="rail-card-error">{error}</div>}
          <div className="rail-card-foot">
            <button className="rail-card-cancel" onClick={cancel} disabled={busy}>
              Cancel
            </button>
            <button className="rail-card-save" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      ) : (
        <div className="rail-card-body">
          {loading ? (
            <div className="rail-card-muted">Loading…</div>
          ) : error ? (
            <div className="rail-card-error">{error}</div>
          ) : hasContent ? (
            <MarkdownMessage content={content} />
          ) : (
            <div className="rail-card-muted">
              {emptyHint ?? `Nothing here yet. Click Edit to add ${title.toLowerCase()}.`}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
