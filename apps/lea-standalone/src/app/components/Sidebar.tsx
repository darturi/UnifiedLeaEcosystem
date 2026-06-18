import { PanelLeftClose } from 'lucide-react';
import type { SessionSummary } from '../lib/api';
import { useSessions } from '../stores/sessions';

// Left rail: brand, new-proof, (search stub), date-grouped loose chats, footer.
// Projects are deferred to v2.1 — the mockup's Projects group is intentionally
// omitted here until that feature lands.
export function Sidebar({
  runningSessionId,
  userEmail,
  onSelectSession,
  onNewSession,
  onOpenSettings,
  onCollapse,
}: {
  runningSessionId?: string;
  userEmail?: string;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onOpenSettings: () => void;
  onCollapse: () => void;
}) {
  // R3: session list + selection from the store, not props.
  const sessions = useSessions((s) => s.sessions);
  const selectedSessionId = useSessions((s) => s.selectedSessionId);
  const groups = groupByDate(sessions);

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
      <div className="searchbtn" title="Search is coming in a later pass" style={{ opacity: 0.6 }}>
        🔍 Search all proofs <span className="kbd">⌘K</span>
      </div>

      <div className="sb-scroll">
        {sessions.length === 0 && (
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
        <button className="gear" onClick={onOpenSettings} title="Settings">
          ⚙
        </button>
      </div>
    </aside>
  );
}

function dotClass(session: SessionSummary, runningSessionId?: string): string {
  if (session.id === runningSessionId) return 'run';
  if (session.status === 'ok') return 'ok';
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
