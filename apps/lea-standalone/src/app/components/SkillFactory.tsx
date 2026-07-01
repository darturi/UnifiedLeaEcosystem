import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Github, Pencil, Plus, Trash2 } from 'lucide-react';
import type { Skill } from '../lib/api';
import { useFactories } from '../stores/factories';
import { useProjects } from '../stores/projects';
import { MarkdownMessage } from './MarkdownMessage';
import { ScopeAssignment, ScopeBadge, type Scope } from './ScopeAssignment';

// The Skill Factory page (v2.1.1 F11, D52/D55/D58). A full-page Library view:
// leads with Add-from-GitHub (paste a link → Add), with an "or write from scratch"
// fallback; below it a two-pane catalog — the skills list (left) and a detail pane
// (right) to edit the markdown body + set the scope (Global ∪ projects). A skill's
// body is injected into the prover's system prompt for the project runs it resolves
// for; loose sessions get none.
export function SkillFactory({ onBack }: { onBack: () => void }) {
  const skills = useFactories((s) => s.skills);
  const refreshSkills = useFactories((s) => s.refreshSkills);
  const selectedSkillId = useFactories((s) => s.selectedSkillId);
  const setSelectedSkillId = useFactories((s) => s.setSelectedSkillId);
  const projects = useProjects((s) => s.projects);
  const refreshProjects = useProjects((s) => s.refreshProjects);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([refreshSkills(), refreshProjects().catch(() => [])])
      .then(() => !cancelled && setLoadError(null))
      .catch((err) => !cancelled && setLoadError(err instanceof Error ? err.message : String(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = useMemo(
    () => skills.find((s) => s.id === selectedSkillId),
    [skills, selectedSkillId],
  );

  return (
    <div className="lea-app">
      <div className="project-window sf">
        <div className="pw-bar">
          <button className="pw-back" onClick={onBack}>
            <ChevronLeft size={15} /> Chats
          </button>
          <span className="pw-crumb-sep">/</span>
          <span className="pw-crumb">Library</span>
          <span className="pw-crumb-sep">/</span>
          <span className="pw-crumb">Skills</span>
        </div>

        <div className="pw-hero">
          <h1 className="pw-title">
            <span className="pw-sigma">✦</span> Skills
          </h1>
          <p className="pw-desc">
            Reusable procedural knowledge — a tactic recipe, a naming convention, house rules.
            A skill is injected into Lea's system prompt for the projects you assign it to.
          </p>
        </div>

        <AddSkill />

        {loadError && <div className="sf-load-err">{loadError}</div>}

        <div className="sf-catalog">
          <div className="sf-list">
            {loading ? (
              <div className="sf-muted">Loading…</div>
            ) : skills.length === 0 ? (
              <div className="sf-muted">No skills yet. Add one above.</div>
            ) : (
              skills.map((skill) => (
                <button
                  key={skill.id}
                  className={`sf-list-row ${selectedSkillId === skill.id ? 'active' : ''}`}
                  onClick={() => setSelectedSkillId(skill.id)}
                >
                  <span className="sf-list-name">{skill.name}</span>
                  <ScopeBadge isGlobal={skill.is_global} count={skill.project_ids.length} />
                </button>
              ))
            )}
          </div>

          <div className="sf-detail">
            {selected ? (
              <SkillDetail key={selected.id} skill={selected} />
            ) : (
              <div className="sf-empty">Select a skill to view or edit it.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// The Add panel: Add-from-GitHub (default) with an "or write from scratch" toggle.
// Both create a skill and select it; scope is chosen inline (D58).
function AddSkill() {
  const projects = useProjects((s) => s.projects);
  const addSkill = useFactories((s) => s.addSkill);
  const addSkillFromGitHub = useFactories((s) => s.addSkillFromGitHub);

  const [mode, setMode] = useState<'github' | 'scratch'>('github');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [scope, setScope] = useState<Scope>({ is_global: false, project_ids: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const reset = () => {
    setUrl('');
    setName('');
    setScope({ is_global: false, project_ids: [] });
  };

  const submit = async () => {
    setError(null);
    setOk(null);
    setBusy(true);
    try {
      if (mode === 'github') {
        if (!url.trim()) throw new Error('Paste a GitHub link first.');
        const skill = await addSkillFromGitHub({ url: url.trim(), ...scope });
        setOk(`Imported “${skill.name}”.`);
      } else {
        if (!name.trim()) throw new Error('Give the skill a name.');
        const skill = await addSkill({ name: name.trim(), body: '', ...scope });
        setOk(`Created “${skill.name}”. Add its content below.`);
      }
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sf-add">
      <div className="sf-add-modes">
        <button
          className={`sf-add-mode ${mode === 'github' ? 'active' : ''}`}
          onClick={() => setMode('github')}
        >
          <Github size={14} /> Add from GitHub
        </button>
        <button
          className={`sf-add-mode ${mode === 'scratch' ? 'active' : ''}`}
          onClick={() => setMode('scratch')}
        >
          <Plus size={14} /> Write from scratch
        </button>
      </div>

      {mode === 'github' ? (
        <input
          className="sf-add-input"
          value={url}
          placeholder="https://github.com/owner/repo (or a link to a SKILL.md / folder)"
          onChange={(e) => setUrl(e.target.value)}
          spellCheck={false}
        />
      ) : (
        <input
          className="sf-add-input"
          value={name}
          placeholder="Skill name, e.g. “Ring & field tactics”"
          onChange={(e) => setName(e.target.value)}
        />
      )}

      <ScopeAssignment value={scope} projects={projects} onChange={setScope} disabled={busy} />

      <div className="sf-add-foot">
        {error && <span className="sf-add-err">{error}</span>}
        {ok && <span className="sf-add-ok">{ok}</span>}
        <button className="sf-add-btn" onClick={submit} disabled={busy}>
          {busy ? (mode === 'github' ? 'Importing…' : 'Creating…') : 'Add'}
        </button>
      </div>
    </div>
  );
}

// The detail pane for one skill: markdown body (view/edit) + scope + delete.
function SkillDetail({ skill }: { skill: Skill }) {
  const projects = useProjects((s) => s.projects);
  const editSkill = useFactories((s) => s.editSkill);
  const assignSkill = useFactories((s) => s.assignSkill);
  const removeSkill = useFactories((s) => s.removeSkill);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(skill.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Scope edits save on change (small, immediate); guarded against overlap.
  const [scopeBusy, setScopeBusy] = useState(false);

  const scope: Scope = { is_global: skill.is_global, project_ids: skill.project_ids };

  const saveBody = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await editSkill(skill.id, { body: draft });
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const saveScope = async (next: Scope) => {
    setScopeBusy(true);
    setError(null);
    try {
      await assignSkill(skill.id, next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScopeBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete the skill “${skill.name}”? This can't be undone.`)) return;
    setBusy(true);
    try {
      await removeSkill(skill.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="sf-detail-pane">
      <div className="sf-detail-head">
        <div className="sf-detail-title">
          <span className="sf-detail-name">{skill.name}</span>
          <span className="sf-detail-slug">{skill.slug}</span>
        </div>
        <button className="sf-del" onClick={remove} disabled={busy} title="Delete skill">
          <Trash2 size={13} /> Delete
        </button>
      </div>

      {skill.source_url && (
        <a className="sf-source" href={skill.source_url} target="_blank" rel="noreferrer">
          <Github size={12} /> Imported from GitHub
        </a>
      )}

      <div className="sf-section-label">
        Content
        {!editing && (
          <button
            className="sf-edit"
            onClick={() => {
              setDraft(skill.body);
              setEditing(true);
            }}
          >
            <Pencil size={12} /> Edit
          </button>
        )}
      </div>

      {editing ? (
        <div className="sf-body-editor">
          <textarea
            className="sf-textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="# Skill&#10;&#10;Markdown Lea will read as procedural knowledge…"
            spellCheck={false}
            autoFocus
          />
          <div className="sf-body-foot">
            <button className="sf-cancel" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </button>
            <button className="sf-save" onClick={saveBody} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      ) : (
        <div className="sf-body">
          {skill.body.trim() ? (
            <MarkdownMessage content={skill.body} />
          ) : (
            <div className="sf-muted">No content yet. Click Edit to add the skill’s markdown.</div>
          )}
        </div>
      )}

      <div className="sf-section-label">Scope</div>
      <ScopeAssignment value={scope} projects={projects} onChange={saveScope} disabled={scopeBusy} />

      {error && <div className="sf-detail-err">{error}</div>}
    </div>
  );
}
