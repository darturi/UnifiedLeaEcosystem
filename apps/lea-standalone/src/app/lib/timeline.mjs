// Shared-timeline assembly for the v2 backend.
//
// Both messages and code steps carry an authoritative `seq` (the shared timeline,
// C4), so ordering is a stable merge on `seq` — no timestamp heuristics, no run
// reconstruction. This replaces the old runAttempts/stepTimeline/timelineTarget
// machinery, which existed only because the previous API had no server-side order.

const NO_SEQ = Number.MAX_SAFE_INTEGER;

function seqOf(x) {
  return Number.isFinite(x?.seq) ? x.seq : NO_SEQ;
}

function createdAt(x) {
  const t = Date.parse(x?.created_at || '');
  return Number.isFinite(t) ? t : NO_SEQ;
}

function compare(a, b) {
  return (a.seq - b.seq) || (createdAt(a) - createdAt(b)) || String(a.key).localeCompare(String(b.key));
}

// Stable order for the code pane (and for assigning each step its pane index).
export function sortCodeSteps(codeSteps) {
  return [...codeSteps].sort((a, b) =>
    (seqOf(a) - seqOf(b)) ||
    (createdAt(a) - createdAt(b)) ||
    String(a.id).localeCompare(String(b.id)),
  );
}

// Merge messages + code steps into one ordered list of timeline items.
//
//   { items: TimelineItem[], codeSteps: CodeStep[] }
//
// TimelineItem is either
//   { kind: 'message', key, seq, message }
//   { kind: 'code',    key, seq, step, codeIndex }   // codeIndex → position in codeSteps
//
// `codeSteps` is the sorted list the code pane navigates; codeIndex on a 'code'
// item points into it, so clicking a chat chip can focus the matching snapshot.
export function buildTimeline({ messages = [], codeSteps = [] }) {
  const sorted = sortCodeSteps(codeSteps);
  const indexById = new Map(sorted.map((step, index) => [step.id, index]));

  const items = [];
  for (const message of messages) {
    items.push({ kind: 'message', key: `m:${message.id}`, seq: seqOf(message), created_at: message.created_at, message });
  }
  for (const step of sorted) {
    items.push({
      kind: 'code',
      key: `c:${step.id}`,
      seq: seqOf(step),
      created_at: step.created_at,
      step,
      codeIndex: indexById.get(step.id),
    });
  }
  items.sort(compare);
  return { items, codeSteps: sorted };
}
