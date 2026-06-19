import { useEffect, useRef, useState } from 'react';
import { Download, Trash2, Upload } from 'lucide-react';
import {
  deleteProjectFile,
  listProjectFiles,
  projectFileDownloadUrl,
  uploadProjectFile,
  type ProjectFile,
} from '../lib/api';

// The Overview-rail Files card (F5/D40) — the quick view over a project's uploaded
// reference docs (D27): drag-drop / picker upload, the file list, download, delete.
// Bytes live in the project repo's .lea/files/; pdf/docx also get a .txt the agent
// reads, surfaced here as an "extracted" tag. The Filesystem tab (U1) is the fuller
// manager later; this card shares the same endpoints.
export function FilesCard({
  projectId,
  refreshSignal = 0,
}: {
  projectId: string;
  refreshSignal?: number;
}) {
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listProjectFiles(projectId)
      .then((rows) => !cancelled && (setFiles(rows), setError(null)))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshSignal]);

  const uploadFiles = async (list: FileList | File[]) => {
    const picked = Array.from(list);
    if (picked.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Upload sequentially so one failure (size/type) surfaces a clear message and
      // doesn't get lost behind others.
      for (const file of picked) await uploadProjectFile(projectId, file);
      setFiles(await listProjectFiles(projectId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (file: ProjectFile) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteProjectFile(projectId, file.id);
      setFiles((prev) => prev.filter((f) => f.id !== file.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rail-card">
      <header className="rail-card-head">
        <span className="rail-card-title">
          <span className="rail-card-icon">📁</span>
          Files
          {files.length > 0 && <span className="files-count">{files.length}</span>}
        </span>
        <button
          className="rail-card-edit"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          title="Upload a file"
        >
          <Upload size={13} /> Upload
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) uploadFiles(e.target.files);
            e.target.value = ''; // allow re-picking the same file
          }}
        />
      </header>

      <div className="rail-card-body">
        <div
          className={`files-drop ${dragOver ? 'over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer.files) uploadFiles(e.dataTransfer.files);
          }}
        >
          {busy ? 'Uploading…' : 'Drop files here, or use Upload. PDF · TeX · Markdown · DOCX · images.'}
        </div>

        {error && <div className="rail-card-error">{error}</div>}

        {loading ? (
          <div className="rail-card-muted">Loading…</div>
        ) : files.length === 0 ? (
          <div className="rail-card-muted" style={{ marginTop: 8 }}>
            No files yet — add papers or notes Lea can read while it works.
          </div>
        ) : (
          <ul className="file-list">
            {files.map((file) => (
              <li key={file.id} className="file-row">
                <a
                  className="file-name"
                  href={projectFileDownloadUrl(projectId, file.id)}
                  title={`Download ${file.filename}`}
                >
                  {file.filename}
                </a>
                {file.extracted_path && <span className="file-tag" title="Text extracted for Lea to read">text</span>}
                <a
                  className="file-act"
                  href={projectFileDownloadUrl(projectId, file.id)}
                  title="Download"
                >
                  <Download size={13} />
                </a>
                <button className="file-act" onClick={() => remove(file)} disabled={busy} title="Delete">
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
