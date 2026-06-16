import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { MONOREPO_ROOT, loadRootEnv, readDotEnv, ROOT_ENV_PATH } from "./env.mjs";

// Unified local-state reset for the whole monorepo. Replaces the former
// per-app reset scripts (apps/overleaf-extension/companion/reset-local-state.mjs
// and apps/lea-ui/scripts/reset-local-state.mjs); both apps share the Lea
// workspace under vendor/lea-prover, so their cleanup is consolidated here.

const dryRun = process.argv.includes("--dry-run");

loadRootEnv();
const rootEnv = readDotEnv(ROOT_ENV_PATH);
const leaRoot = resolveMonorepoPath(process.env.LEA_ROOT || rootEnv.LEA_ROOT || "vendor/lea-prover");
const workspaceDir = path.join(leaRoot, "workspace");
const projectsDir = path.join(workspaceDir, "projects");
const proofsDir = path.join(workspaceDir, "proofs");
const overleafContextDir = path.join(workspaceDir, "context", "overleaf");

// Overleaf companion local state.
const companionDir = path.join(MONOREPO_ROOT, "apps", "overleaf-extension", ".overleaf-lean-stub");
const companionJobsDir = path.join(companionDir, "jobs");
const companionBackupsDir = path.join(companionDir, "backups");
const companionJobsIndex = path.join(companionDir, "jobs.json");
const companionCache = path.join(companionDir, "cache.json");

// Lea UI local state.
const uiDataDir = path.join(MONOREPO_ROOT, "apps", "lea-ui", "data");

function resolveMonorepoPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(MONOREPO_ROOT, value);
}

function rel(filePath) {
  const relativePath = path.relative(MONOREPO_ROOT, filePath);
  return relativePath && !relativePath.startsWith("..") ? relativePath : filePath;
}

function collectEntries(dir, predicate = () => true, files = [], recurse = false) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    if (entry === ".gitkeep") continue;
    const entryPath = path.join(dir, entry);
    const isDir = statSync(entryPath).isDirectory();
    if (isDir && recurse) {
      collectEntries(entryPath, predicate, files, recurse);
    } else if (predicate(entryPath, isDir)) {
      files.push(entryPath);
    }
  }
  return files;
}

function removeEntries(label, entries) {
  console.log(`[reset] ${label}: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`);
  for (const entryPath of entries) {
    if (!dryRun) rmSync(entryPath, { recursive: true, force: true });
    console.log(`${dryRun ? "Would remove" : "Removed"} ${rel(entryPath)}`);
  }
}

function removeDir(label, dir) {
  const exists = existsSync(dir);
  console.log(`[reset] ${label}: ${exists ? rel(dir) : "not present"}`);
  if (exists && !dryRun) rmSync(dir, { recursive: true, force: true });
  if (exists) console.log(`${dryRun ? "Would remove" : "Removed"} ${rel(dir)}`);
}

function writeJsonFile(label, filePath, value) {
  console.log(`[reset] ${label}: ${rel(filePath)}`);
  if (!dryRun) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
  console.log(`${dryRun ? "Would write" : "Wrote"} ${rel(filePath)}`);
}

const sqliteFiles = collectEntries(
  uiDataDir,
  (filePath, isDir) => !isDir && /\.(db|sqlite|sqlite3)(-(journal|shm|wal))?$/.test(path.basename(filePath)),
  [],
  true,
);

// Shared Lea workspace artifacts (used by both apps).
removeEntries("Lea project entries", collectEntries(projectsDir));
removeEntries("Lea proof entries", collectEntries(proofsDir));
removeDir("Lea Overleaf LaTeX context", overleafContextDir);

// Overleaf companion artifacts.
removeDir("companion job logs", companionJobsDir);
removeDir("companion backups", companionBackupsDir);
writeJsonFile("companion job index", companionJobsIndex, {});
writeJsonFile("companion cache", companionCache, {});

// Lea UI artifacts.
removeEntries("Lea UI SQLite databases", sqliteFiles);

if (!dryRun) {
  mkdirSync(projectsDir, { recursive: true });
  mkdirSync(proofsDir, { recursive: true });
  mkdirSync(companionJobsDir, { recursive: true });
  mkdirSync(uiDataDir, { recursive: true });
}

console.log(`[reset] Ecosystem local state ${dryRun ? "dry run" : "reset"} complete.`);
