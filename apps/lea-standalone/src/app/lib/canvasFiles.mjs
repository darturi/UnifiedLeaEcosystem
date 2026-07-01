// Canvas file model (#10): a session's code steps span multiple files — a main
// proof plus throwaway `scratch` probes (exact?/apply? scratchpads). The canvas is
// a step timeline, so a late scratch write becomes the newest step and hides the
// main proof. These helpers let the canvas offer a file selector and default to the
// main file, and let SafeVerify/lean_check target a *chosen* file's current copy.

// A scratch/probe file — matched the same way the store excludes them from a
// session's status (path contains "scratch", case-insensitive).
export function isScratchPath(path) {
  return /scratch/i.test(String(path || ''));
}

// Distinct files across the (sorted) steps, in first-seen order, each carrying its
// latest step index, step count, and whether it's a scratch file.
export function distinctFiles(steps) {
  const byPath = new Map();
  steps.forEach((s, i) => {
    const path = s?.path;
    if (!path) return;
    const existing = byPath.get(path);
    if (existing) {
      existing.latestIndex = i;
      existing.count += 1;
    } else {
      byPath.set(path, { path, isScratch: isScratchPath(path), latestIndex: i, count: 1 });
    }
  });
  return [...byPath.values()];
}

// The index of the latest snapshot of `path` (or -1 if the file has no steps).
export function latestIndexForPath(steps, path) {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i]?.path === path) return i;
  }
  return -1;
}

// The "main" file's path: the most recently touched NON-scratch file. Falls back to
// the last step's path when every file is scratch. null when there are no steps.
export function mainFilePath(steps) {
  if (!steps.length) return null;
  for (let i = steps.length - 1; i >= 0; i--) {
    const path = steps[i]?.path;
    if (path && !isScratchPath(path)) return path;
  }
  return steps[steps.length - 1]?.path ?? null;
}

// The step index the canvas should open on: the main file's latest snapshot (so a
// reopened session shows the proof, not a leftover scratch probe). -1 for no steps.
export function mainFileIndex(steps) {
  const path = mainFilePath(steps);
  return path == null ? -1 : latestIndexForPath(steps, path);
}
