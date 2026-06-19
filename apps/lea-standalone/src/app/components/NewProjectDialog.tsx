import { useState } from 'react';

// Create-project dialog (v2.1 F2). A lightweight controlled modal — App owns the
// open flag; on submit it calls onCreate (which provisions the project + repo and
// opens its window). Title is required; description is optional.
export function NewProjectDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (title: string, description?: string) => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  if (!open) return null;

  const reset = () => {
    setTitle('');
    setDescription('');
    setError(undefined);
    setBusy(false);
  };
  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };
  const submit = async () => {
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onCreate(t, description.trim() || undefined);
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={close}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">New project</div>
        <div className="modal-sub">
          A project is a shared directory + git repo. Its proofs share a namespace
          so lemmas can import each other.
        </div>

        <label className="modal-label">Name</label>
        <input
          className="modal-input"
          autoFocus
          placeholder="e.g. Real Analysis"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') close();
          }}
        />

        <label className="modal-label">Description <span className="modal-opt">(optional)</span></label>
        <textarea
          className="modal-input modal-textarea"
          placeholder="What is this project about?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />

        {error && <div className="modal-error">{error}</div>}

        <div className="modal-foot">
          <button className="modal-btn" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button className="modal-btn primary" onClick={submit} disabled={busy || !title.trim()}>
            {busy ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </div>
    </div>
  );
}
