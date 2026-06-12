import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyEnvDefaults, loadDotEnv } from "./config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");
const appDir = path.join(root, ".overleaf-lean-stub");
const settingsPath = path.join(appDir, "settings.json");

loadDotEnv(root);
const settings = applyEnvDefaults(readJson(settingsPath, {}));
const leaRepoPath = path.resolve(settings.leaRepoPath);
const workspaceDir = path.join(leaRepoPath, "workspace");
const projectsDir = path.join(workspaceDir, "projects");
const proofsDir = path.join(workspaceDir, "proofs");
const cachePath = path.join(appDir, "cache.json");
const jobsPath = path.join(appDir, "jobs.json");
const jobsDir = path.join(appDir, "jobs");
const backupsDir = path.join(appDir, "backups");

function collectEntries(dir) {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir).map((entry) => path.join(dir, entry));
}

function removeEntries(label, entries) {
  console.log(`[reset] ${label}: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`);
  for (const filePath of entries) {
    if (!dryRun) {
      rmSync(filePath, { recursive: true, force: true });
    }
    console.log(`${dryRun ? "Would remove" : "Removed"} ${relative(filePath)}`);
  }
}

function removeDir(label, dir) {
  const exists = existsSync(dir);
  console.log(`[reset] ${label}: ${exists ? relative(dir) : "not present"}`);
  if (exists && !dryRun) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (exists) {
    console.log(`${dryRun ? "Would remove" : "Removed"} ${relative(dir)}`);
  }
}

function writeJsonFile(label, filePath, value) {
  console.log(`[reset] ${label}: ${relative(filePath)}`);
  if (!dryRun) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
  console.log(`${dryRun ? "Would write" : "Wrote"} ${relative(filePath)}`);
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function relative(filePath) {
  const relativePath = path.relative(root, filePath);
  return relativePath && !relativePath.startsWith("..") ? relativePath : filePath;
}

removeEntries("Lea project entries", collectEntries(projectsDir));
removeEntries("Lea proof entries", collectEntries(proofsDir));
removeDir("companion job logs", jobsDir);
removeDir("companion backups", backupsDir);
writeJsonFile("companion job index", jobsPath, {});
writeJsonFile("companion cache", cachePath, {});

if (!dryRun) {
  mkdirSync(projectsDir, { recursive: true });
  mkdirSync(proofsDir, { recursive: true });
  mkdirSync(jobsDir, { recursive: true });
}

console.log(`[reset] ${dryRun ? "Dry run complete" : "Local state reset complete"}.`);
