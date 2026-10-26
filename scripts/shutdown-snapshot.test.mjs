import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const python = path.resolve(scripts, "../apps/lea-standalone/adapter/.venv/bin/python");

test("the local stack saves separate full archives after SIGINT and SIGTERM", {
  timeout: 15000, skip: !existsSync(python) && "Run npm run setup to install the adapter Python",
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lea-snapshot-supervisor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ["scripts", "apps/lea-standalone/adapter/.venv/bin", "apps/lea-standalone/config"])
    await mkdir(path.join(root, dir), { recursive: true });
  for (const name of ["supervisor.mjs", "process-supervisor.mjs", "env.mjs", "shutdown_snapshot.py"])
    await copyFile(path.join(scripts, name), path.join(root, "scripts", name));
  // Only replace the network preflight and the serving process. The actual
  // supervisor and exporter run unchanged, with no real ports or user data.
  await writeFile(path.join(root, "scripts/dev-stack-preflight.mjs"), "export async function assertServicesAvailable() {}\n");
  await symlink(python, path.join(root, "apps/lea-standalone/adapter/.venv/bin/python"));
  await writeFile(path.join(root, "apps/lea-standalone/config/lea.local.toml"), 'openai_api_key="fixture-local-credential"\nmodel="test/model"\n');
  await writeFile(path.join(root, "apps/lea-standalone/adapter/run_api.py"), `
import signal, time
from pathlib import Path
def stop(*args):
    data = Path('../data')
    data.mkdir(exist_ok=True)
    with (data / 'final.log').open('a') as log:
        log.write('flushed on shutdown fixture-local-credential\\n')
    raise SystemExit(0)
signal.signal(signal.SIGTERM, stop)
print('FIXTURE READY', flush=True)
while True: time.sleep(.01)
`);
  const archives = path.join(root, "apps/lea-standalone/data/shutdown-archives");
  for (const [attempt, signal] of ["SIGINT", "SIGTERM"].entries()) {
    let output = "";
    const child = spawn(process.execPath, ["scripts/supervisor.mjs", "adapter"], {
      cwd: root, detached: true, env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} });
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const exited = once(child, "exit");
    const deadline = Date.now() + 5000;
    while (!output.includes("FIXTURE READY")) {
      assert.equal(child.exitCode, null, output);
      assert.ok(Date.now() < deadline, output);
      await delay(20);
    }
    child.kill(signal);
    const [code] = await exited;
    assert.equal(code, 0, output);
    assert.match(output, /\[snapshot\] Saved/);
    assert.doesNotMatch(output, /fixture-local-credential/);
    assert.equal((await readdir(archives)).filter(name => name.endsWith(".zip")).length, attempt + 1);
  }
  execFileSync(python, ["-c", `
import pathlib, sys, zipfile
for file in pathlib.Path(sys.argv[1]).glob('*.zip'):
    with zipfile.ZipFile(file) as archive:
        data = b'\\n'.join(archive.read(name) for name in archive.namelist())
        assert b'fixture-local-credential' not in data
        assert b'flushed on shutdown' in archive.read('data/final.log')
        assert not any('shutdown-archives/' in name for name in archive.namelist())
`, archives]);
});
