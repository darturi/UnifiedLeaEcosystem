import { BarChart3, PanelLeftClose, Plus, Sparkles } from 'lucide-react';
import type { SessionSummary } from '../lib/api';
import { useSessions } from '../stores/sessions';
import { useProjects } from '../stores/projects';

// Left rail: brand, new-proof, (search stub), Projects group, date-grouped loose
// chats, footer. The Projects group (v2.1 F1) lists projects; loose chats are the
// `project_id IS NULL` sessions.
export function Sidebar({
  runningSessionId,
  userEmail,
  onSelectSession,
  onNewSession,
  onSelectProject,
  onNewProject,
  onOpenSkills,
  onOpenSearch,
  onOpenSettings,
  onOpenStats,
  onCollapse,
}: {
  runningSessionId?: string;
  userEmail?: string;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onSelectProject: (id: string) => void;
  onNewProject: () => void;
  onOpenSkills: () => void;
  onOpenSearch: () => void;
  onOpenSettings: () => void;
  onOpenStats: () => void;
  onCollapse: () => void;
}) {
  // R3: session list + selection from the store, not props.
  const sessions = useSessions((s) => s.sessions);
  const selectedSessionId = useSessions((s) => s.selectedSessionId);
  // D36: the sidebar's Chats group is loose sessions only — in-project sessions
  // live in the project window (reachable there or via search), not here.
  const looseSessions = sessions.filter((s) => !s.project_id);
  const groups = groupByDate(looseSessions);
  // F1: projects list + which one is open, from the projects store.
  const projects = useProjects((s) => s.projects);
  const selectedProjectId = useProjects((s) => s.selectedProjectId);

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="logo">L</div>
        <div className="name">Lea</div>
        <div className="ver">v2</div>
        <button className="icon-btn" style={{ marginLeft: 8 }} onClick={onCollapse} title="Collapse sidebar">
          <PanelLeftClose size={15} />
        </button>
      </div>
      <button className="newbtn" onClick={onNewSession}>
        <span className="plus">+</span> New proof
      </button>
      <button className="searchbtn" onClick={onOpenSearch} title="Search all proofs (⌘K)">
        🔍 Search all proofs <span className="kbd">⌘K</span>
      </button>

      <div className="sb-scroll">
        <div className="proj-group">
          <div className="group-label proj-head">
            Projects
            <button className="proj-add" onClick={onNewProject} title="New project" aria-label="New project">
              <Plus size={13} />
            </button>
          </div>
          {projects.length === 0 ? (
            <div className="proj-empty">No projects yet.</div>
          ) : (
            projects.map((project) => (
              <button
                key={project.id}
                className={`row ${selectedProjectId === project.id ? 'active' : ''}`}
                onClick={() => onSelectProject(project.id)}
              >
                <span className="picon">∑</span>
                <span className="rtitle">{project.title}</span>
                {typeof project.session_count === 'number' && project.session_count > 0 && (
                  <span className="count">{project.session_count}</span>
                )}
              </button>
            ))
          )}
        </div>

        <div className="proj-group">
          <div className="group-label">Library</div>
          <button className="row" onClick={onOpenSkills}>
            <span className="picon"><Sparkles size={13} /></span>
            <span className="rtitle">Skills</span>
          </button>
        </div>

        {looseSessions.length > 0 && <div className="group-label">Chats</div>}
        {looseSessions.length === 0 && (
          <div className="group-label" style={{ textTransform: 'none', letterSpacing: 0 }}>
            No proofs yet — start one below.
          </div>
        )}
        {groups.map((group) => (
          <div key={group.label}>
            <div className="group-label">{group.label}</div>
            {group.sessions.map((session) => (
              <button
                key={session.id}
                className={`row ${selectedSessionId === session.id ? 'active' : ''}`}
                onClick={() => onSelectSession(session.id)}
              >
                <span className={`dot ${dotClass(session, runningSessionId)}`} />
                <span className="rtitle">{session.title}</span>
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="sidebar-foot">
        <span>{userEmail || 'local'}</span>
        <button
          className="gear stats"
          onClick={onOpenStats}
          title="Usage & statistics"
          aria-label="Usage & statistics"
        >
          <BarChart3 size={15} strokeWidth={1.75} />
        </button>
        <button className="gear" onClick={onOpenSettings} title="Settings" aria-label="Settings">
          ⚙
        </button>
      </div>
    </aside>
  );
}

function dotClass(session: SessionSummary, runningSessionId?: string): string {
  if (session.id === runningSessionId) return 'run';
  if (session.status === 'ok' || session.status === 'proved') return 'ok';
  if (session.status === 'disproved' || session.status === 'needs_review') return 'run';
  if (session.status === 'error') return 'fail';
  return 'idle';
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function groupByDate(sessions: SessionSummary[]): { label: string; sessions: SessionSummary[] }[] {
  const sorted = [...sessions].sort(
    (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at),
  );
  const now = new Date();
  const today = startOfDay(now);
  const yesterday = today - 86400000;
  const buckets = new Map<string, SessionSummary[]>();
  const order: string[] = [];
  const put = (label: string, s: SessionSummary) => {
    if (!buckets.has(label)) {
      buckets.set(label, []);
      order.push(label);
    }
    buckets.get(label)!.push(s);
  };
  for (const session of sorted) {
    const t = startOfDay(new Date(session.updated_at || session.created_at));
    if (t >= today) put('Today', session);
    else if (t >= yesterday) put('Yesterday', session);
    else put('Earlier', session);
  }
  return order.map((label) => ({ label, sessions: buckets.get(label)! }));
}
