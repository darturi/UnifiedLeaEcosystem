import path from "node:path";

export const GENERATOR_VERSION = "lea-overleaf-v2";
export const LEA_PROJECTS_DIR = path.join("workspace", "projects");
export const LEA_PROOFS_DIR = path.join("workspace", "proofs");

export function slugProjectId(overleafProjectId) {
  const raw = String(overleafProjectId || "").trim();
  let slug = raw.replace(/[^A-Za-z0-9_-]/g, "_");
  if (!slug) {
    slug = "unknown";
  }
  if (!/^[A-Za-z0-9]/.test(slug)) {
    slug = `project_${slug}`;
  }
  return slug.slice(0, 80);
}

export function buildLeaWorkspacePath(leaRepoPath) {
  return path.join(path.resolve(leaRepoPath), "workspace");
}

export function buildLeaProjectMarkdownPath({ leaRepoPath, overleafProjectId }) {
  return path.join(
    buildLeaWorkspacePath(leaRepoPath),
    "projects",
    `${slugProjectId(overleafProjectId)}.md`
  );
}

export function buildLeaProofPath({ leaRepoPath, proofPath }) {
  const repoRoot = path.resolve(leaRepoPath);
  const absolutePath = path.isAbsolute(proofPath)
    ? path.resolve(proofPath)
    : path.resolve(repoRoot, proofPath);
  if (absolutePath !== repoRoot && !absolutePath.startsWith(`${repoRoot}${path.sep}`)) {
    return null;
  }
  return absolutePath;
}

export function relativeToLeaRepo({ leaRepoPath, absolutePath }) {
  return path.relative(path.resolve(leaRepoPath), path.resolve(absolutePath));
}
