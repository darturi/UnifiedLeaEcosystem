import { create } from 'zustand';
import {
  listSkills,
  createSkill,
  importSkill,
  updateSkill,
  setSkillAssignment,
  deleteSkill,
  type Skill,
} from '../lib/api';

/**
 * The factories store (v2.1.1 F10) — the Library's catalogs. Today it holds the
 * skills list + selection + CRUD/assignment/import actions; the MCP servers list
 * is the deferred Slice 9 (kept out until it ships). Mirrors `stores/projects.ts`
 * so the Skill Factory page reads the list + selection from here, no prop-drilling.
 */
interface FactoriesState {
  skills: Skill[];
  selectedSkillId?: string;
  setSelectedSkillId: (id?: string) => void;

  refreshSkills: () => Promise<Skill[]>;
  addSkill: (input: { name: string; body?: string; is_global?: boolean; project_ids?: string[] }) => Promise<Skill>;
  addSkillFromGitHub: (input: { url: string; is_global?: boolean; project_ids?: string[] }) => Promise<Skill>;
  editSkill: (skillId: string, update: { name?: string; body?: string }) => Promise<Skill>;
  assignSkill: (skillId: string, assignment: { is_global: boolean; project_ids: string[] }) => Promise<Skill>;
  removeSkill: (skillId: string) => Promise<void>;
}

// Keep the local list consistent after a mutation, and re-select the touched skill.
function upsert(skills: Skill[], skill: Skill): Skill[] {
  const rest = skills.filter((s) => s.id !== skill.id);
  return [skill, ...rest];
}

export const useFactories = create<FactoriesState>((set, get) => ({
  skills: [],
  selectedSkillId: undefined,
  setSelectedSkillId: (selectedSkillId) => set({ selectedSkillId }),

  refreshSkills: async () => {
    const loaded = await listSkills();
    set({ skills: loaded });
    return loaded;
  },

  addSkill: async (input) => {
    const skill = await createSkill(input);
    set((s) => ({ skills: upsert(s.skills, skill), selectedSkillId: skill.id }));
    return skill;
  },

  addSkillFromGitHub: async (input) => {
    const skill = await importSkill(input);
    set((s) => ({ skills: upsert(s.skills, skill), selectedSkillId: skill.id }));
    return skill;
  },

  editSkill: async (skillId, update) => {
    const skill = await updateSkill(skillId, update);
    set((s) => ({ skills: upsert(s.skills, skill) }));
    return skill;
  },

  assignSkill: async (skillId, assignment) => {
    const skill = await setSkillAssignment(skillId, assignment);
    set((s) => ({ skills: upsert(s.skills, skill) }));
    return skill;
  },

  removeSkill: async (skillId) => {
    await deleteSkill(skillId);
    set((s) => ({
      skills: s.skills.filter((skill) => skill.id !== skillId),
      selectedSkillId: get().selectedSkillId === skillId ? undefined : get().selectedSkillId,
    }));
  },
}));
