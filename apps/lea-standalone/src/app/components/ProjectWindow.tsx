import { useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import type { ProjectDetail, SessionStatus } from '../lib/api';
import { MarkdownDoc } from './MarkdownDoc';
import { FilesCard } from './FilesCard';
import { BlueprintTab } from './BlueprintTab';
import { FilesystemTab } from './FilesystemTab';

type Tab = 'overview' | 'blueprint' | 'filesystem';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'blueprint', label: 'Blueprint' },
  { id: 'filesystem', label: 'Filesystem' },
];

// The project window (v2.1 F2/F3). A full-page view — breadcrumb back to Chats, a
// hero (∑ title · namespace + description), and the tab strip. The Overview tab
// (F3) has the "new proof in this project" composer + the project's sessions list;
// opening a row loads the normal Chat+Canvas. Blueprint/Filesystem are later slices.
export function ProjectWindow({
  project,
  onBack,
  onStartProof,
  onOpenSession,
}: {
  project: ProjectDetail;
  onBack: () => void;
  onStartProof: (message: string) => Promise<void> | void;
  onOpenSession: (sessionId: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('overview');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const sessions = project.sessions ?? [];
  // Memory is agent-written: a run advances its session's `updated_at`, so when the
  // project detail is re-fetched the Memory card re-loads memory.md (F4/D39).
  const docSignal = sessions.reduce((max, s) => Math.max(max, Date.parse(s.updated_at) || 0), 0);

  const submit = async () => {
    const message = draft.trim();
    if (!message || busy) return;
    setBusy(true);
    try {
      await onStartProof(message);
      setDraft('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="project-window">
      <div className="pw-bar">
        <button className="pw-back" onClick={onBack}>
          <ChevronLeft size={15} /> Chats
        </button>
        <span className="pw-crumb-sep">/</span>
        <span className="pw-crumb">{project.title}</span>
      </div>

      <div className="pw-hero">
        <h1 className="pw-title">
          <span className="pw-sigma">∑</span> {project.title}
          <span className="pw-ns">{project.namespace}</span>
        </h1>
        {project.description && <p className="pw-desc">{project.description}</p>}
      </div>

      <div className="pw-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`pw-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="pw-body">
        {tab === 'overview' ? (
          <div className="pw-overview-grid">
          <div className="pw-overview">
            <div className="pw-composer">
              <div className="pw-sec-label">New proof in this project</div>
              <textarea
                className="pw-composer-input"
                placeholder={`Prove a theorem in ${project.namespace}… (it can import sibling lemmas)`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
                }}
              />
              <div className="pw-composer-foot">
                <span className="pw-hint">⌘↵ to start</span>
                <button className="pw-start" onClick={submit} disabled={busy || !draft.trim()}>
                  {busy ? 'Starting…' : 'Prove in this project'}
                </button>
              </div>
            </div>

            <div className="pw-sec-label" style={{ marginTop: 22 }}>Sessions</div>
            {sessions.length === 0 ? (
              <div className="pw-empty">
                No proofs yet. Start one above — it lands in <code>{project.repo_path}</code> so
                its lemmas can chain.
              </div>
            ) : (
              <ul className="pw-session-list">
                {sessions.map((s) => (
                  <li key={s.id}>
                    <button className="pw-session-row" onClick={() => onOpenSession(s.id)}>
                      <span className={`dot ${sessionDotClass(s.status)}`} />
                      <span className="pw-session-title">{s.title}</span>
                      <span className="pw-session-when">{new Date(s.updated_at).toLocaleString()}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <aside className="pw-rail">
            <MarkdownDoc
              projectId={project.id}
              doc="instructions"
              title="Instructions"
              icon="📋"
              refreshSignal={docSignal}
              emptyHint="No instructions yet — add your project's goal and any conventions so Lea follows them on every run."
            />
            <MarkdownDoc
              projectId={project.id}
              doc="memory"
              title="Memory"
              icon="🧠"
              agentWritten
              refreshSignal={docSignal}
              emptyHint="No memory for this project yet — jot down facts, witnesses, and dead ends here; Lea reads it and adds to it as it works."
            />
            <FilesCard projectId={project.id} refreshSignal={docSignal} />
          </aside>
          </div>
        ) : tab === 'blueprint' ? (
          <BlueprintTab projectId={project.id} onOpenSession={onOpenSession} refreshSignal={docSignal} />
        ) : (
          <FilesystemTab projectId={project.id} refreshSignal={docSignal} />
        )}
      </div>
    </div>
  );
}

function sessionDotClass(status: SessionStatus | string): string {
  if (status === 'ok' || status === 'proved') return 'ok';
  if (status === 'error') return 'fail';
  if (status === 'running' || status === 'disproved' || status === 'needs_review') return 'run';
  return 'idle';
}
