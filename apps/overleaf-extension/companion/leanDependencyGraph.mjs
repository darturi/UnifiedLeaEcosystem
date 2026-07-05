// Reverse-dependency index over a project's recorded Lean proof files.
//
// Every target in one Overleaf project shares a single git repo and Lean
// namespace (`Lea.<ProjectSlug>`, D24 in apps/lea-standalone/design/v2-architecture.md):
// each target's recorded proof is its own file under
// `workspace/proofs/Lea/<ProjectSlug>/...` inside that one repo. The *forward*
// direction (what does target X import) already existed for formalize-time
// `uses=` resolution (findImportedCurrentlyStubbedTheoremUses in server.mjs).
// This module adds the mirror image: given a declaration, which other
// recorded files in the project import it -- the question a manual edit needs
// answered before (and after) it changes that declaration.
//
// See docs/FEATURE-overleaf-lean-pane-manual-edit.md ("Downstream Impact")
// and docs/PLAN-overleaf-lean-pane-manual-edit.md (Phase 0).

import fs from "node:fs/promises";
import path from "node:path";

// -- Namespace / path helpers ------------------------------------------------
// Moved here (unchanged) from companion/server.mjs so this module has no
// dependency on server.mjs (server.mjs imports these back, avoiding a
// circular import). Pure string/path manipulation only -- no filesystem
// access, so they're trivially unit-testable and safe to share.

export function projectNamespaceFromSlug(slug) {
  const parts = String(slug || "").trim().split(/[-_\s]+/).filter(Boolean);
  let camel = parts.map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join("");
  camel = camel.replace(/[^A-Za-z0-9]/g, "");
  if (!camel || !/^[A-Za-z]/.test(camel)) {
    camel = `P${camel}`;
  }
  return `Lea.${camel}`;
}

export function proofPathFromProjectStep({ namespace, stepPath }) {
  const cleanPath = String(stepPath || "").replace(/^\/+/, "");
  return path.join("workspace", "proofs", ...String(namespace || "Lea.Misc").split("."), cleanPath);
}

export function moduleNameFromProjectStep({ namespace, stepPath }) {
  const withoutExt = String(stepPath || "").replace(/\.lean$/i, "");
  const moduleSuffix = withoutExt.split(/[\\/]+/).filter(Boolean).join(".");
  return [namespace || "Lea.Misc", moduleSuffix].filter(Boolean).join(".");
}

// Every `import Foo.Bar` line in a Lean file, as a Set of module names.
// Unchanged from the original companion/server.mjs implementation.
export function parseLeanImports(content) {
  const imports = new Set();
  for (const line of String(content || "").split(/\r?\n/)) {
    const match = line.match(/^\s*import\s+(.+?)\s*(?:--.*)?$/);
    if (!match) continue;
    for (const moduleName of match[1].trim().split(/\s+/)) {
      if (moduleName) {
        imports.add(moduleName);
      }
    }
  }
  return imports;
}

// -- Project-wide file discovery --------------------------------------------

// Recursively list every `.lean` file recorded for a project's namespace,
// with its content and derived module name. `namespace` can be passed
// directly (e.g. by a caller that already resolved it from an adapter
// session's `project_namespace`), otherwise it's derived from
// `overleafProjectId` via `projectNamespaceFromSlug(slugProjectId(...))` --
// pass `namespace` explicitly when it's already known to avoid a second,
// possibly-divergent derivation.
export async function listProjectProofFiles({ leaRepoPath, namespace }) {
  if (!leaRepoPath || !namespace) return [];
  const namespaceRoot = path.join(
    path.resolve(leaRepoPath),
    "workspace",
    "proofs",
    ...String(namespace).split(".")
  );

  const files = [];
  await walk(namespaceRoot, "");
  return files;

  async function walk(dir, relativePrefix) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // no recorded proofs for this project yet -- not an error
    }
    for (const entry of entries) {
      const entryRelative = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      const entryAbsolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryAbsolute, entryRelative);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".lean")) continue;
      let content = "";
      try {
        content = await fs.readFile(entryAbsolute, "utf8");
      } catch {
        continue; // file disappeared/unreadable between readdir and readFile
      }
      files.push({
        stepPath: entryRelative,
        absolutePath: entryAbsolute,
        moduleName: moduleNameFromProjectStep({ namespace, stepPath: entryRelative }),
        content
      });
    }
  }
}

// -- Reverse index ------------------------------------------------------------

// Map<importedModuleName, FileRef[]> -- every recorded file, keyed by each
// module name it imports. `files` is the shape `listProjectProofFiles`
// returns.
export function buildReverseImportIndex(files) {
  const index = new Map();
  for (const file of Array.isArray(files) ? files : []) {
    const imports = parseLeanImports(file.content);
    for (const moduleName of imports) {
      const existing = index.get(moduleName);
      if (existing) {
        existing.push(file);
      } else {
        index.set(moduleName, [file]);
      }
    }
  }
  return index;
}

// Transitive closure of "imports, directly or indirectly" starting from
// `moduleName`. Lean's import graph is acyclic by construction (a cycle would
// mean Lean itself fails to build), so this needs no cycle-breaking to be
// correct -- the visited set below is a defensive bound, not a correctness
// requirement, and also de-duplicates a diamond dependency (C importing both
// A and B, both of which import D) to one entry for C.
export function transitiveDependents(moduleName, reverseIndex) {
  const visitedModules = new Set([moduleName]);
  const resultByModule = new Map();
  const queue = [moduleName];

  while (queue.length > 0) {
    const current = queue.shift();
    const directDependents = reverseIndex.get(current) || [];
    for (const file of directDependents) {
      if (!resultByModule.has(file.moduleName)) {
        resultByModule.set(file.moduleName, file);
      }
      if (!visitedModules.has(file.moduleName)) {
        visitedModules.add(file.moduleName);
        queue.push(file.moduleName);
      }
    }
  }

  return [...resultByModule.values()];
}

// The single entry point handlers should call: every file in the project
// that imports `moduleName`, directly or transitively. v1 computes this on
// demand (no caching) -- see the feature spec's "Reverse-dependency index"
// section for why that's an acceptable cost at pane scale.
export async function dependentsOf({ leaRepoPath, namespace, moduleName }) {
  const files = await listProjectProofFiles({ leaRepoPath, namespace });
  const reverseIndex = buildReverseImportIndex(files);
  return transitiveDependents(moduleName, reverseIndex);
}

// The FORWARD mirror of dependentsOf: every project file the given module
// imports, directly or transitively, whose CURRENT content still contains a
// sorry/admit -- i.e. everything upstream that remains to be formalized
// before this proof stands on solid ground. Purely file-derived: it reads
// imports and content from disk right now, so it needs no `uses=` links or
// job records to have survived (jobs.json is routinely cleared by
// start-dev.sh), and it is transitive where the job-recorded `targetUses`
// scan is direct-only. The BFS deliberately continues THROUGH stubbed files:
// a stub's own imports may be stubs too, and all of them are "what remains."
//
// The root can be given as `moduleName` or located by `absolutePath` (for
// callers that only know where the proof file lives on disk).
export async function stubbedUpstreamOf({ leaRepoPath, namespace, moduleName, absolutePath }) {
  const files = await listProjectProofFiles({ leaRepoPath, namespace });
  const byModule = new Map(files.map((file) => [file.moduleName, file]));
  let root = moduleName ? byModule.get(moduleName) : null;
  if (!root && absolutePath) {
    const resolved = path.resolve(String(absolutePath));
    root = files.find((file) => path.resolve(file.absolutePath) === resolved) || null;
  }
  if (!root) return [];

  const visited = new Set([root.moduleName]);
  const queue = [root.moduleName];
  const stubbed = [];
  while (queue.length > 0) {
    const current = byModule.get(queue.shift());
    if (!current) continue;
    for (const imported of parseLeanImports(current.content)) {
      if (visited.has(imported)) continue;
      visited.add(imported);
      const file = byModule.get(imported);
      if (!file) continue; // outside the project namespace (Mathlib etc.)
      if (/\bsorry\b|\badmit\b/.test(file.content)) {
        stubbed.push(file);
      }
      queue.push(imported);
    }
  }
  return stubbed;
}

// -- Batch-repair ordering (self-repair Phase 4) -------------------------------

// Order a repair set so an item is repaired only after every batch item it
// transitively imports: repairing `C` before the `B` it imports would have
// `C` fail on `B`'s still-broken import and waste a full agent run.
//
// `items` carry a `moduleName` (null/undefined allowed -- unattributable items
// sort last, in given order); `importsByModule` is Map<moduleName, imports>
// over the WHOLE project (transitive paths may pass through non-batch
// modules). Lean's import graph is acyclic by construction, so the cycle
// guard is defensive: on a cycle (corrupt fixture, symlinked repo) it falls
// back to the given order with `cyclic: true` rather than looping or
// guessing an order it can't justify.
export function topologicalRepairOrder(items, importsByModule) {
  const list = Array.isArray(items) ? items : [];
  const byModule = new Map(list.filter((item) => item.moduleName).map((item) => [item.moduleName, item]));

  // For each batch item, which OTHER batch items it transitively imports --
  // walked over the full project graph so A -> (non-batch) M -> B still
  // orders B before A.
  const batchDepsOf = (moduleName) => {
    const deps = new Set();
    const seen = new Set([moduleName]);
    const queue = [...(importsByModule.get(moduleName) || [])];
    while (queue.length > 0) {
      const current = queue.shift();
      if (seen.has(current)) continue;
      seen.add(current);
      if (byModule.has(current)) deps.add(current);
      for (const imported of importsByModule.get(current) || []) queue.push(imported);
    }
    return deps;
  };

  const ordered = [];
  const placed = new Set();
  const visiting = new Set();
  let cyclic = false;
  const visit = (item) => {
    if (placed.has(item.moduleName)) return;
    if (visiting.has(item.moduleName)) {
      cyclic = true;
      return;
    }
    visiting.add(item.moduleName);
    for (const depModule of batchDepsOf(item.moduleName)) {
      visit(byModule.get(depModule));
    }
    visiting.delete(item.moduleName);
    if (!placed.has(item.moduleName)) {
      placed.add(item.moduleName);
      ordered.push(item);
    }
  };
  for (const item of list) {
    if (item.moduleName) visit(item);
  }
  for (const item of list) {
    if (!item.moduleName) ordered.push(item);
  }
  return cyclic ? { ordered: [...list], cyclic: true } : { ordered, cyclic: false };
}
