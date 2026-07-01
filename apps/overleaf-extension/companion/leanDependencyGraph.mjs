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
