import { create } from 'zustand';
import type {
  ApprovalRecord,
  ChatMessage,
  CodeStep,
  RunStatus,
  SafeVerifyResult,
  StatusEvent,
} from '../lib/api';

// React-style setter signature: accept a value or an updater fn, so existing
// `setX((cur) => ...)` call sites migrate from useState unchanged.
type Updater<T> = T | ((current: T) => T);
const apply = <T,>(update: Updater<T>, current: T): T =>
  typeof update === 'function' ? (update as (c: T) => T)(current) : update;

/**
 * The proof-session store (v2.0.1 R1).
 *
 * Shared state for the proof view, so the chat header, ChatThread and Canvas
 * read it straight from here instead of being prop-drilled through App. We move
 * App's `useState` into this store one cohesive slice at a time — this file
 * grows per sub-todo (R1a, R1b, …).
 *
 * Usage:
 *   const editedPath = useProofSession((s) => s.editedPath);  // subscribe to a slice
 *   useProofSession.getState().setEditedPath(path);           // write from non-React code
 */
interface ProofSessionState {
  // Canvas-edit nudge (M20): the file the user just edited, prompting a note in
  // the composer. Set after a canvas edit; cleared on send / new session / load.
  editedPath?: string;
  setEditedPath: (path?: string) => void;

  // Error banner shown in the chat thread (run errors, lost connection, failed
  // actions). Cleared at the start of each session/run.
  error?: string;
  setError: (error?: string) => void;

  // Persisted SafeVerify verdict for the latest proof, shown in the canvas foot.
  // Set on verify / load; cleared on edit / new session.
  safeVerify: SafeVerifyResult | null;
  setSafeVerify: (safeVerify: SafeVerifyResult | null) => void;

  // Edit-mode SafeVerify result surfaced as a collapsible box above the composer,
  // so the user can dismiss it or push the error into the draft ("fix it"). Set on
  // an Edit-mode SafeVerify run; cleared on dismiss / send / new session.
  verifySurface: SafeVerifyResult | null;
  setVerifySurface: (verifySurface: SafeVerifyResult | null) => void;

  // Shared InfoView (v2.2 · Phase 3): the goal state at the human's cursor, captured
  // from the live editor and surfaced above the composer so they can ask Lea about
  // it. Cleared on dismiss / send / new session.
  goalSurface: { rendered: string; line: number } | null;
  setGoalSurface: (goalSurface: { rendered: string; line: number } | null) => void;

  // Lean proof snapshots for the session (stored raw; consumers sort via
  // sortCodeSteps) + the canvas stepper position. Written by the run stream /
  // session load; codeIndex follows the latest step or the user's stepper choice.
  codeSteps: CodeStep[];
  setCodeSteps: (codeSteps: CodeStep[]) => void;
  codeIndex: number;
  setCodeIndex: (codeIndex: number) => void;

  // Chat thread content: assistant/user messages + tool/compile status events.
  // Written by the run stream / session load; ChatThread derives its timeline.
  messages: ChatMessage[];
  setMessages: (update: Updater<ChatMessage[]>) => void;
  statusEvents: StatusEvent[];
  setStatusEvents: (update: Updater<StatusEvent[]>) => void;

  // Run lifecycle: whether a run is active, its id + status, and the per-run
  // final/active status map that places the "Proved" milestone (M16).
  isRunning: boolean;
  setIsRunning: (isRunning: boolean) => void;
  currentRunId?: string;
  setCurrentRunId: (currentRunId?: string) => void;
  runStatus?: RunStatus;
  setRunStatus: (runStatus?: RunStatus) => void;
  runStatusById: Record<string, string>;
  setRunStatusById: (update: Updater<Record<string, string>>) => void;
  runResultKindById: Record<string, string | null | undefined>;
  setRunResultKindById: (update: Updater<Record<string, string | null | undefined>>) => void;

  // Theorem-approval gate: the approval history (each gains a decision once
  // resolved; M13) + a busy flag while a decision is in flight.
  approvals: ApprovalRecord[];
  setApprovals: (update: Updater<ApprovalRecord[]>) => void;
  approvalBusy: boolean;
  setApprovalBusy: (approvalBusy: boolean) => void;
}

export const useProofSession = create<ProofSessionState>((set) => ({
  editedPath: undefined,
  setEditedPath: (editedPath) => set({ editedPath }),

  error: undefined,
  setError: (error) => set({ error }),

  safeVerify: null,
  setSafeVerify: (safeVerify) => set({ safeVerify }),

  verifySurface: null,
  setVerifySurface: (verifySurface) => set({ verifySurface }),

  goalSurface: null,
  setGoalSurface: (goalSurface) => set({ goalSurface }),

  codeSteps: [],
  setCodeSteps: (codeSteps) => set({ codeSteps }),
  codeIndex: 0,
  setCodeIndex: (codeIndex) => set({ codeIndex }),

  messages: [],
  setMessages: (update) => set((s) => ({ messages: apply(update, s.messages) })),
  statusEvents: [],
  setStatusEvents: (update) => set((s) => ({ statusEvents: apply(update, s.statusEvents) })),

  isRunning: false,
  setIsRunning: (isRunning) => set({ isRunning }),
  currentRunId: undefined,
  setCurrentRunId: (currentRunId) => set({ currentRunId }),
  runStatus: undefined,
  setRunStatus: (runStatus) => set({ runStatus }),
  runStatusById: {},
  setRunStatusById: (update) => set((s) => ({ runStatusById: apply(update, s.runStatusById) })),
  runResultKindById: {},
  setRunResultKindById: (update) => set((s) => ({ runResultKindById: apply(update, s.runResultKindById) })),

  approvals: [],
  setApprovals: (update) => set((s) => ({ approvals: apply(update, s.approvals) })),
  approvalBusy: false,
  setApprovalBusy: (approvalBusy) => set({ approvalBusy }),
}));
