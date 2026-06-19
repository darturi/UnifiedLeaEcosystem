import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, GitBranch, FileText } from 'lucide-react';
import { getProjectBlueprint, type BlueprintWarning } from '../lib/api';
import { BlueprintGraph } from './BlueprintGraph';
import { MarkdownDoc } from './MarkdownDoc';

// The Blueprint tab (F6/F7, D28/D33). Two sub-views over the one canonical
// `.lea/blueprint.md`: the derived dependency **graph** and a **markdown authoring**
// view (reusing MarkdownDoc). A structural-warnings banner (from the validator) sits
// above both. Editing the markdown re-derives the graph + re-checks the warnings.
type View = 'graph' | 'markdown';

export function BlueprintTab({
  projectId,
  onOpenSession,
  refreshSignal = 0,
}: {
  projectId: string;
  onOpenSession: (sessionId: string) => void;
  refreshSignal?: number;
}) {
  const [view, setView] = useState<View>('graph');
  const [warnings, setWarnings] = useState<BlueprintWarning[]>([]);
  // Bumped on a local save so the graph + warnings re-fetch without a full reload.
  const [bump, setBump] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getProjectBlueprint(projectId)
      .then((b) => !cancelled && setWarnings(b.warnings))
      .catch(() => !cancelled && setWarnings([]));
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshSignal, bump]);

  const onSaved = useCallback(() => setBump((b) => b + 1), []);
  const graphSignal = refreshSignal + bump;

  return (
    <div className="bp-tab">
      <div className="bp-tab-bar">
        <div className="bp-seg">
          <button className={`bp-seg-btn ${view === 'graph' ? 'active' : ''}`} onClick={() => setView('graph')}>
            <GitBranch size={13} /> Graph
          </button>
          <button className={`bp-seg-btn ${view === 'markdown' ? 'active' : ''}`} onClick={() => setView('markdown')}>
            <FileText size={13} /> Markdown
          </button>
        </div>
        <span className="bp-tab-hint">One file, two views — the graph is derived from <code>.lea/blueprint.md</code>.</span>
      </div>

      {warnings.length > 0 && (
        <div className="bp-warns">
          <div className="bp-warns-head">
            <AlertTriangle size={13} /> {warnings.length} blueprint {warnings.length === 1 ? 'warning' : 'warnings'}
          </div>
          <ul>
            {warnings.map((w, i) => (
              <li key={i}>{w.message}</li>
            ))}
          </ul>
        </div>
      )}

      {view === 'graph' ? (
        <BlueprintGraph projectId={projectId} onOpenSession={onOpenSession} refreshSignal={graphSignal} />
      ) : (
        <div className="bp-md">
          <MarkdownDoc
            projectId={projectId}
            doc="blueprint"
            title="Blueprint"
            icon="🗺️"
            agentWritten
            refreshSignal={graphSignal}
            onSaved={onSaved}
            emptyHint="No blueprint yet. Click Edit and add a `## node` section with a kind, an optional lean: decl, and uses: dependencies — the graph builds itself from it."
          />
        </div>
      )}
    </div>
  );
}
