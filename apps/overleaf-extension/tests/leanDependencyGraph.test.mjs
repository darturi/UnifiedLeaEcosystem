import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildReverseImportIndex,
  dependentsOf,
  listProjectProofFiles,
  moduleNameFromProjectStep,
  parseLeanImports,
  projectNamespaceFromSlug,
  proofPathFromProjectStep,
  transitiveDependents
} from "../companion/leanDependencyGraph.mjs";

async function makeLeaRepo() {
  return fs.mkdtemp(path.join(os.tmpdir(), "lea-dep-graph-"));
}

async function writeProof(leaRepo, namespace, stepPath, content) {
  const absolute = path.join(leaRepo, proofPathFromProjectStep({ namespace, stepPath }));
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, "utf8");
}

test("projectNamespaceFromSlug/proofPathFromProjectStep/moduleNameFromProjectStep are unchanged from the original companion/server.mjs behavior", () => {
  assert.equal(projectNamespaceFromSlug("my-project"), "Lea.MyProject");
  assert.equal(
    proofPathFromProjectStep({ namespace: "Lea.MyProject", stepPath: "compactness.lean" }),
    path.join("workspace", "proofs", "Lea", "MyProject", "compactness.lean")
  );
  assert.equal(
    moduleNameFromProjectStep({ namespace: "Lea.MyProject", stepPath: "compactness.lean" }),
    "Lea.MyProject.compactness"
  );
});

test("parseLeanImports collects every import line, ignoring comments", () => {
  const content = [
    "import Lea.MyProject.a",
    "import Lea.MyProject.b Lea.MyProject.c -- trailing comment",
    "-- import Lea.MyProject.commented_out is not a real import line here",
    "theorem foo : True := by trivial"
  ].join("\n");
  const imports = parseLeanImports(content);
  assert.deepEqual([...imports].sort(), ["Lea.MyProject.a", "Lea.MyProject.b", "Lea.MyProject.c"]);
});

test("listProjectProofFiles walks the namespace directory recursively and derives module names", async () => {
  const leaRepo = await makeLeaRepo();
  const namespace = "Lea.MyProject";
  await writeProof(leaRepo, namespace, "a.lean", "theorem a : True := by trivial\n");
  await writeProof(leaRepo, namespace, path.join("nested", "b.lean"), "import Lea.MyProject.a\ntheorem b : True := by trivial\n");

  const files = await listProjectProofFiles({ leaRepoPath: leaRepo, namespace });
  const byModule = new Map(files.map((f) => [f.moduleName, f]));
  assert.equal(files.length, 2);
  assert.ok(byModule.has("Lea.MyProject.a"));
  assert.ok(byModule.has("Lea.MyProject.nested.b"));
  assert.match(byModule.get("Lea.MyProject.nested.b").content, /import Lea\.MyProject\.a/);
});

test("listProjectProofFiles returns an empty list when the project has no recorded proofs yet", async () => {
  const leaRepo = await makeLeaRepo();
  const files = await listProjectProofFiles({ leaRepoPath: leaRepo, namespace: "Lea.NothingYet" });
  assert.deepEqual(files, []);
});

test("buildReverseImportIndex + transitiveDependents finds direct and transitive dependents", () => {
  const files = [
    { moduleName: "Lea.P.a", content: "" },
    { moduleName: "Lea.P.b", content: "import Lea.P.a\n" },
    { moduleName: "Lea.P.c", content: "import Lea.P.b\n" },
    { moduleName: "Lea.P.d", content: "import Lea.P.unrelated\n" }
  ];
  const index = buildReverseImportIndex(files);
  const dependents = transitiveDependents("Lea.P.a", index).map((f) => f.moduleName).sort();
  assert.deepEqual(dependents, ["Lea.P.b", "Lea.P.c"]);
});

test("transitiveDependents finds both direct dependents at the same level (the spec's two-dependent worked example)", () => {
  const files = [
    { moduleName: "Lea.P.compactness_criterion", content: "" },
    { moduleName: "Lea.P.compactness_corollary", content: "import Lea.P.compactness_criterion\n" },
    { moduleName: "Lea.P.heine_borel_application", content: "import Lea.P.compactness_criterion\n" }
  ];
  const index = buildReverseImportIndex(files);
  const dependents = transitiveDependents("Lea.P.compactness_criterion", index).map((f) => f.moduleName).sort();
  assert.deepEqual(dependents, ["Lea.P.compactness_corollary", "Lea.P.heine_borel_application"]);
});

test("transitiveDependents de-duplicates a diamond dependency", () => {
  const files = [
    { moduleName: "Lea.P.d", content: "" },
    { moduleName: "Lea.P.a", content: "import Lea.P.d\n" },
    { moduleName: "Lea.P.b", content: "import Lea.P.d\n" },
    { moduleName: "Lea.P.c", content: "import Lea.P.a\nimport Lea.P.b\n" }
  ];
  const index = buildReverseImportIndex(files);
  const dependents = transitiveDependents("Lea.P.d", index).map((f) => f.moduleName).sort();
  assert.deepEqual(dependents, ["Lea.P.a", "Lea.P.b", "Lea.P.c"]);
});

test("transitiveDependents returns nothing for a module no one imports (or that doesn't exist)", () => {
  const files = [
    { moduleName: "Lea.P.a", content: "" },
    { moduleName: "Lea.P.b", content: "import Lea.P.a\n" }
  ];
  const index = buildReverseImportIndex(files);
  assert.deepEqual(transitiveDependents("Lea.P.typo_or_never_formalized", index), []);
  assert.deepEqual(transitiveDependents("Lea.P.b", index), []);
});

test("dependentsOf composes file discovery + reverse index + traversal end to end", async () => {
  const leaRepo = await makeLeaRepo();
  const namespace = "Lea.MyProject";
  await writeProof(leaRepo, namespace, "compactness_criterion.lean", "theorem compactness_criterion : True := by trivial\n");
  await writeProof(leaRepo, namespace, "compactness_corollary.lean", "import Lea.MyProject.compactness_criterion\ntheorem compactness_corollary : True := by trivial\n");
  await writeProof(leaRepo, namespace, "unrelated.lean", "theorem unrelated : True := by trivial\n");

  const dependents = await dependentsOf({
    leaRepoPath: leaRepo,
    namespace,
    moduleName: "Lea.MyProject.compactness_criterion"
  });
  assert.deepEqual(dependents.map((f) => f.moduleName), ["Lea.MyProject.compactness_corollary"]);
});

test("dependentsOf on a module with no recorded dependents returns an empty array, not an error", async () => {
  const leaRepo = await makeLeaRepo();
  const namespace = "Lea.MyProject";
  await writeProof(leaRepo, namespace, "solo.lean", "theorem solo : True := by trivial\n");

  const dependents = await dependentsOf({ leaRepoPath: leaRepo, namespace, moduleName: "Lea.MyProject.solo" });
  assert.deepEqual(dependents, []);
});
