import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronRight,
  Download,
  File as FileIcon,
  Folder,
  FolderOpen,
  Pencil,
} from 'lucide-react';
import {
  getProjectFile,
  getProjectTree,
  projectExportUrl,
  putProjectFile,
  type TreeEntry,
} from '../lib/api';

// The Filesystem tab (F8 / D34) — "see everything, edit, download." The project is
// already a git repo, so this exposes it: a tree of the repo (left), a viewer/editor
// for the selected file (right; write+commit, with a `.lean` check verdict), and an
// Export button that downloads the whole project as a zip. GitHub push is a later
// pass (6b) — this is the local view/edit/export half.

type CheckVerdict = { status: 'ok' | 'error'; detail?: string | null } | null;

function collectDirPaths(entries: TreeEntry[], into: string[] = []): string[] {
  for (const e of entries) {
    if (e.type === 'dir') {
      into.push(e.path);
      collectDirPaths(e.children ?? [], into);
    }
  }
  return into;
}

export function FilesystemTab({
  projectId,
  refreshSignal = 0,
}: {
  projectId: string;
  refreshSignal?: number;
}) {
  const [tree, setTree] = useState<TreeEntry[] | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [treeLoading, setTreeLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const seededRef = useRef<string | null>(null);

  const [selected, setSelected] = useState<string | null>(null);

  // Load + live-refresh the tree. Auto-expand every dir once per project (the repo is
  // small), then preserve the user's toggles across later refreshes.
  useEffect(() => {
    let cancelled = false;
    setTreeLoading(true);
    getProjectTree(projectId)
      .then((rows) => {
        if (cancelled) return;
        setTree(rows);
        setTreeError(null);
        if (seededRef.current !== projectId) {
          setExpanded(new Set(collectDirPaths(rows)));
          seededRef.current = projectId;
        }
      })
      .catch((err) => !cancelled && setTreeError(err instanceof Error ? err.message : String(err)))
      .finally(() => !cancelled && setTreeLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshSignal]);

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // After a save, refetch the tree so a newly-created file/dir appears.
  const [treeBump, setTreeBump] = useState(0);
  useEffect(() => {
    if (treeBump === 0) return;
    let cancelled = false;
    getProjectTree(projectId)
      .then((rows) => !cancelled && setTree(rows))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [treeBump, projectId]);

  return (
    <div className="fs">
      <div className="fs-bar">
        <span className="fs-bar-hint">The project repo — browse, edit any file, download the lot.</span>
        <a className="fs-export" href={projectExportUrl(projectId)} download title="Download the whole project as a zip">
          <Download size={13} /> Export
        </a>
      </div>

      <div className="fs-body">
        <div className="fs-tree">
          {treeLoading && !tree ? (
            <div className="fs-muted">Loading…</div>
          ) : treeError ? (
            <div className="fs-muted fs-err">{treeError}</div>
          ) : !tree || tree.length === 0 ? (
            <div className="fs-muted">Empty repo.</div>
          ) : (
            <TreeNodes
              entries={tree}
              depth={0}
              expanded={expanded}
              onToggle={toggle}
              selected={selected}
              onSelect={setSelected}
            />
          )}
        </div>

        <div className="fs-viewer">
          {selected ? (
            <FileViewer
              key={selected}
              projectId={projectId}
              path={selected}
              onSaved={() => setTreeBump((b) => b + 1)}
            />
          ) : (
            <div className="fs-empty">Select a file to view or edit it.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function TreeNodes({
  entries,
  depth,
  expanded,
  onToggle,
  selected,
  onSelect,
}: {
  entries: TreeEntry[];
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <>
      {entries.map((e) => {
        const pad = 8 + depth * 14;
        if (e.type === 'dir') {
          const open = expanded.has(e.path);
          return (
            <div key={e.path}>
              <button className="fs-row fs-dir" style={{ paddingLeft: pad }} onClick={() => onToggle(e.path)}>
                <ChevronRight size={13} className={`fs-chevron ${open ? 'open' : ''}`} />
                {open ? <FolderOpen size={14} /> : <Folder size={14} />}
                <span className="fs-name">{e.name}</span>
              </button>
              {open && e.children && e.children.length > 0 && (
                <TreeNodes
                  entries={e.children}
                  depth={depth + 1}
                  expanded={expanded}
                  onToggle={onToggle}
                  selected={selected}
                  onSelect={onSelect}
                />
              )}
            </div>
          );
        }
        return (
          <button
            key={e.path}
            className={`fs-row fs-file ${selected === e.path ? 'active' : ''}`}
            style={{ paddingLeft: pad + 17 }}
            onClick={() => onSelect(e.path)}
          >
            <FileIcon size={13} />
            <span className="fs-name">{e.name}</span>
          </button>
        );
      })}
    </>
  );
}

function FileViewer({
  projectId,
  path,
  onSaved,
}: {
  projectId: string;
  path: string;
  onSaved: () => void;
}) {
  const [content, setContent] = useState('');
  const [binary, setBinary] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [check, setCheck] = useState<CheckVerdict>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setEditing(false);
    setCheck(null);
    getProjectFile(projectId, path)
      .then((f) => {
        if (cancelled) return;
        setContent(f.content);
        setBinary(f.binary);
        setError(null);
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectId, path]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await putProjectFile(projectId, path, draft);
      setContent(draft);
      setCheck(result.check ?? null);
      setEditing(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fs-file-pane">
      <div className="fs-view-head">
        <span className="fs-view-path" title={path}>{path}</span>
        {!binary && !editing && (
          <button
            className="fs-edit"
            onClick={() => {
              setDraft(content);
              setCheck(null);
              setEditing(true);
            }}
          >
            <Pencil size={12} /> Edit
          </button>
        )}
      </div>

      {check && (
        <div className={`fs-check ${check.status === 'ok' ? 'ok' : 'err'}`}>
          {check.status === 'ok' ? '✓ lean_check passed' : '✗ lean_check failed'}
          {check.status === 'error' && check.detail ? <pre className="fs-check-detail">{check.detail}</pre> : null}
        </div>
      )}

      {loading ? (
        <div className="fs-muted">Loading…</div>
      ) : error && !editing ? (
        <div className="fs-muted fs-err">{error}</div>
      ) : binary ? (
        <div className="fs-empty">
          This file isn’t text. <a href={projectExportUrl(projectId)} download>Export the project</a> to get it.
        </div>
      ) : editing ? (
        <div className="fs-editor">
          <textarea
            className="fs-textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            autoFocus
          />
          {error && <div className="fs-muted fs-err">{error}</div>}
          <div className="fs-editor-foot">
            <button className="fs-cancel" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </button>
            <button className="fs-save" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save & commit'}
            </button>
          </div>
        </div>
      ) : (
        <pre className="fs-code">{content || '(empty file)'}</pre>
      )}
    </div>
  );
}
