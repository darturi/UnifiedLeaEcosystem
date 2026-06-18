import { create } from 'zustand';
import { listSessions, type SessionSummary } from '../lib/api';

/**
 * The sessions store (v2.0.1 R3) — the session list + which one is open.
 *
 * Sidebar reads the list straight from here; App reads the selection for its
 * handlers; useProofStream pulls `setSelectedSessionId` + `refreshSessions` from
 * here (so the hook no longer needs them passed in).
 */
interface SessionsState {
  sessions: SessionSummary[];
  setSessions: (sessions: SessionSummary[]) => void;
  selectedSessionId?: string;
  setSelectedSessionId: (id?: string) => void;
  // Reload the list from the API and return it (callers use the result to, e.g.,
  // restore the last-open session on startup).
  refreshSessions: () => Promise<SessionSummary[]>;
}

export const useSessions = create<SessionsState>((set) => ({
  sessions: [],
  setSessions: (sessions) => set({ sessions }),
  selectedSessionId: undefined,
  setSelectedSessionId: (selectedSessionId) => set({ selectedSessionId }),
  refreshSessions: async () => {
    const loaded = await listSessions();
    set({ sessions: loaded });
    return loaded;
  },
}));
