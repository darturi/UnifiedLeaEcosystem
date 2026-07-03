// A typed layer over the Lean language server (v2.2 · Phase 3).
//
// UI actions ("ask about this goal", "explain this term", goal gutter markers, …)
// bind to typed methods here instead of each re-implementing the fiddly mechanics:
//   * pick the *running* Lean client — `LeanClient.sendRequest` silently no-ops
//     (returns undefined) unless the client is running, and the "active" client
//     isn't always the running one;
//   * build the document URI + LSP position (0-based — the same numbering Lean's
//     InfoView shows in its `file:line:col` header, one less than Monaco's 1-based).
//
// Keep the shapes aligned with the agent-side (Python) goal dataclasses when those
// land, so the human and the agent speak the same goal type.

// LSP 0-based position.
export interface Position {
  line: number;
  character: number;
}

// `$/lean/plainGoal` — the tactic goals at a position (what the InfoView shows).
export interface PlainGoal {
  rendered: string;
  goals: string[];
}

// `$/lean/plainTermGoal` — the expected type at a term position.
export interface TermGoal {
  rendered: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyLeanMonaco = any;
type AnyEditor = any;

export class LeanQuery {
  constructor(private leanMonaco: AnyLeanMonaco, private editor: AnyEditor) {}

  /** The running Lean client, or null. Selecting by `isRunning()` is what makes
   *  requests actually reach the server. */
  private client(): any | null {
    const provider = this.leanMonaco?.clientProvider;
    const clients: any[] = provider?.getClients?.() ?? [];
    const chosen = clients.find((c) => c?.isRunning?.()) ?? provider?.getActiveClient?.();
    return chosen && chosen.isRunning?.() ? chosen : null;
  }

  /** textDocument URI + LSP position (defaults to the cursor), or null. */
  private target(pos?: Position): { uri: string; position: Position } | null {
    const model = this.editor?.getModel?.();
    if (!model) return null;
    const position = pos ?? this.cursor();
    if (!position) return null;
    return { uri: model.uri.toString(), position };
  }

  private async request<T>(method: string, pos?: Position): Promise<T | null> {
    const client = this.client();
    const target = this.target(pos);
    if (!client || !target) return null;
    const result = await client.sendRequest(method, {
      textDocument: { uri: target.uri },
      position: target.position,
    });
    return (result ?? null) as T | null;
  }

  /** Whether a running Lean client is available to query. */
  ready(): boolean {
    return this.client() !== null;
  }

  /** The current cursor as an LSP 0-based position (for labelling actions). */
  cursor(): Position | null {
    const p = this.editor?.getPosition?.();
    return p ? { line: p.lineNumber - 1, character: p.column - 1 } : null;
  }

  /** Tactic goals at `pos` (default: the cursor). */
  plainGoal(pos?: Position): Promise<PlainGoal | null> {
    return this.request<PlainGoal>('$/lean/plainGoal', pos);
  }

  /** Expected type at a term position (default: the cursor). */
  termGoal(pos?: Position): Promise<TermGoal | null> {
    return this.request<TermGoal>('$/lean/plainTermGoal', pos);
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
