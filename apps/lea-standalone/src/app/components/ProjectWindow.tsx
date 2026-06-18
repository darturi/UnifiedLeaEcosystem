import { useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import type { ProjectDetail } from '../lib/api';

type Tab = 'overview' | 'blueprint' | 'filesystem';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'blueprint', label: 'Blueprint' },
  { id: 'filesystem', label: 'Filesystem' },
];

// The project window (v2.1 F2). A full-page view — breadcrumb back to Chats, a
// hero (∑ title · namespace + description), and the tab strip. Slice 1 scaffolds
// the tabs with placeholders; the composer + sessions wiring (Overview), the
// dependency graph (Blueprint) and the file tree (Filesystem) land in later slices.
export function ProjectWindow({
  project,
  onBack,
}: {
  project: ProjectDetail;
  onBack: () => void;
}) {
  const [tab, setTab] = useState<Tab>('overview');
  const sessions = project.sessions ?? [];

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
          <div className="pw-overview">
            <div className="pw-sec-label">Sessions</div>
            {sessions.length === 0 ? (
              <div className="pw-empty">
                No proofs in this project yet. Starting a proof inside a project
                lands in <code>{project.repo_path}</code> so its lemmas can chain —
                coming in the next slice.
              </div>
            ) : (
              <ul className="pw-session-list">
                {sessions.map((s) => (
                  <li key={s.id} className="pw-session-row">
                    <span className={`dot ${s.status === 'ok' ? 'ok' : s.status === 'error' ? 'fail' : 'idle'}`} />
                    <span className="pw-session-title">{s.title}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="pw-empty">
            The {tab === 'blueprint' ? 'Blueprint' : 'Filesystem'} tab arrives in a
            later slice.
          </div>
        )}
      </div>
    </div>
  );
}
