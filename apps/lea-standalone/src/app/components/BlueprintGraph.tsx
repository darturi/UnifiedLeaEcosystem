import { useEffect, useMemo, useState } from 'react';
import { getProjectGraph, type GraphNode, type ProjectGraph } from '../lib/api';

// The interactive blueprint graph (F7/D28/D29). Renders the derived dependency
// graph: shape encodes `kind` (definition → box, lemma/theorem → ellipse), color
// encodes the live-derived `status`, edges are `uses` dependencies. Clicking a node
// opens a detail panel listing the sessions that built it (deep-link into the chat).
//
// Layout is a hand-rolled layered DAG: a node's level is the longest chain of
// dependencies beneath it, so foundations sit at the bottom and the theorems that
// build on them rise to the top. No external graph library.

const NODE_W = 176;
const NODE_H = 54;
const H_GAP = 36;
const V_GAP = 72;
const PAD = 28;

const STATUS_LABEL: Record<string, string> = {
  planned: 'Planned',
  stated: 'Stated',
  ready: 'Ready',
  proved: 'Proved',
  failed: 'Failed',
};

interface Placed {
  node: GraphNode;
  x: number;
  y: number;
}

interface Layout {
  placed: Map<string, Placed>;
  width: number;
  height: number;
  order: string[];
}

// Longest-dependency-path level per node (memoized, cycle-guarded), then a centered
// row per level. Edge `from → to` means `from` depends on `to`, so `to` is deeper.
function computeLayout(graph: ProjectGraph): Layout {
  const keys = new Set(graph.nodes.map((n) => n.key));
  const deps = new Map<string, string[]>();
  for (const n of graph.nodes) deps.set(n.key, n.uses.filter((u) => keys.has(u)));

  const level = new Map<string, number>();
  const visiting = new Set<string>();
  const levelOf = (key: string): number => {
    if (level.has(key)) return level.get(key)!;
    if (visiting.has(key)) return 0; // break cycles defensively
    visiting.add(key);
    let lv = 0;
    for (const d of deps.get(key) ?? []) lv = Math.max(lv, levelOf(d) + 1);
    visiting.delete(key);
    level.set(key, lv);
    return lv;
  };
  for (const n of graph.nodes) levelOf(n.key);

  const maxLevel = graph.nodes.reduce((m, n) => Math.max(m, level.get(n.key) ?? 0), 0);
  const byLevel = new Map<number, GraphNode[]>();
  for (const n of graph.nodes) {
    const lv = level.get(n.key) ?? 0;
    (byLevel.get(lv) ?? byLevel.set(lv, []).get(lv)!).push(n);
  }

  const rowWidth = (count: number) => count * NODE_W + (count - 1) * H_GAP;
  const width = Math.max(
    NODE_W + PAD * 2,
    ...Array.from(byLevel.values(), (row) => rowWidth(row.length) + PAD * 2),
  );
  const height = PAD * 2 + (maxLevel + 1) * NODE_H + maxLevel * V_GAP;

  const placed = new Map<string, Placed>();
  const order: string[] = [];
  for (const [lv, row] of byLevel) {
    const startX = (width - rowWidth(row.length)) / 2;
    const y = PAD + (maxLevel - lv) * (NODE_H + V_GAP);
    row.forEach((node, i) => {
      placed.set(node.key, { node, x: startX + i * (NODE_W + H_GAP), y });
      order.push(node.key);
    });
  }
  return { placed, width, height, order };
}

function truncate(text: string, max = 22): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function BlueprintGraph({
  projectId,
  onOpenSession,
  refreshSignal = 0,
}: {
  projectId: string;
  onOpenSession: (sessionId: string) => void;
  refreshSignal?: number;
}) {
  const [graph, setGraph] = useState<ProjectGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getProjectGraph(projectId)
      .then((g) => !cancelled && (setGraph(g), setError(null)))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshSignal]);

  const layout = useMemo(() => (graph ? computeLayout(graph) : null), [graph]);

  // Keep a selection only while its node still exists after a refresh.
  const selectedNode = selected && layout?.placed.get(selected)?.node;

  if (loading) return <div className="bp-graph-msg">Loading graph…</div>;
  if (error) return <div className="bp-graph-msg bp-graph-err">{error}</div>;
  if (!graph || graph.nodes.length === 0) {
    return (
      <div className="bp-graph-empty">
        <p>No blueprint nodes yet.</p>
        <p className="bp-graph-empty-hint">
          Switch to <b>Markdown</b> and add a <code>## node</code> section, or let Lea sketch the
          decomposition as it proves — each node appears here, colored by its live status.
        </p>
      </div>
    );
  }

  return (
    <div className="bp-graph">
      <div className="bp-graph-canvas">
        <svg width={layout!.width} height={layout!.height} role="img" aria-label="Blueprint dependency graph">
          {/* edges first so nodes paint on top */}
          {graph.edges.map((e, i) => {
            const from = layout!.placed.get(e.from);
            const to = layout!.placed.get(e.to);
            if (!from || !to) return null;
            const x1 = from.x + NODE_W / 2;
            const y1 = from.y + NODE_H;
            const x2 = to.x + NODE_W / 2;
            const y2 = to.y;
            const my = (y1 + y2) / 2;
            return (
              <path
                key={`${e.from}-${e.to}-${i}`}
                className="bp-edge"
                d={`M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`}
                markerEnd="url(#bp-arrow)"
              />
            );
          })}
          <defs>
            <marker id="bp-arrow" markerWidth="9" markerHeight="9" refX="7" refY="3"
              orient="auto" markerUnits="strokeWidth">
              <path d="M0,0 L7,3 L0,6 Z" className="bp-arrowhead" />
            </marker>
          </defs>

          {layout!.order.map((key) => {
            const p = layout!.placed.get(key)!;
            const n = p.node;
            const isDef = n.kind === 'definition';
            const cls = `bp-node bp-${n.status}${selected === key ? ' is-selected' : ''}`;
            return (
              <g
                key={key}
                className="bp-node-g"
                transform={`translate(${p.x},${p.y})`}
                onClick={() => setSelected((s) => (s === key ? null : key))}
              >
                {isDef ? (
                  <rect className={cls} width={NODE_W} height={NODE_H} rx={7} />
                ) : (
                  <ellipse className={cls} cx={NODE_W / 2} cy={NODE_H / 2} rx={NODE_W / 2} ry={NODE_H / 2} />
                )}
                <text className="bp-node-key" x={NODE_W / 2} y={NODE_H / 2 - 3}>
                  {truncate(n.key)}
                </text>
                <text className="bp-node-kind" x={NODE_W / 2} y={NODE_H / 2 + 13}>
                  {n.kind ?? '—'} · {STATUS_LABEL[n.status] ?? n.status}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="bp-graph-side">
        <ul className="bp-legend">
          {(['proved', 'ready', 'stated', 'planned', 'failed'] as const).map((s) => (
            <li key={s}>
              <span className={`bp-swatch bp-${s}`} /> {STATUS_LABEL[s]}
            </li>
          ))}
          <li className="bp-legend-shape"><span className="bp-shape-ellipse" /> lemma / theorem</li>
          <li className="bp-legend-shape"><span className="bp-shape-box" /> definition</li>
        </ul>

        {selectedNode ? (
          <NodeDetail node={selectedNode} onOpenSession={onOpenSession} />
        ) : (
          <div className="bp-detail-empty">Click a node to see its statement and the sessions that built it.</div>
        )}
      </div>
    </div>
  );
}

function NodeDetail({
  node,
  onOpenSession,
}: {
  node: GraphNode;
  onOpenSession: (sessionId: string) => void;
}) {
  return (
    <div className="bp-detail">
      <div className="bp-detail-head">
        <span className="bp-detail-key">{node.key}</span>
        <span className={`bp-detail-status bp-${node.status}`}>{STATUS_LABEL[node.status] ?? node.status}</span>
      </div>
      <div className="bp-detail-meta">
        {node.kind ?? 'node'}
        {node.lean && <> · <code>{node.lean}</code></>}
      </div>
      {node.statement && <p className="bp-detail-stmt">{node.statement}</p>}

      <div className="bp-detail-sub">Worked on by</div>
      {node.sessions.length === 0 ? (
        <div className="bp-detail-empty">
          No sessions yet{node.status === 'planned' ? ' — this node is still planned.' : '.'}
        </div>
      ) : (
        <ul className="bp-detail-sessions">
          {node.sessions.map((s) => (
            <li key={s.session_id}>
              <button className="bp-session-link" onClick={() => onOpenSession(s.session_id)} title="Open this session">
                {s.title || 'session'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
