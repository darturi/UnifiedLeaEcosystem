import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();

function check(label, ok, detail = "") {
  const marker = ok ? "OK" : "FAIL";
  console.log(`[${marker}] ${label}${detail ? ` - ${detail}` : ""}`);
  return ok;
}

function command(args, options = {}) {
  return spawnSync(args[0], args.slice(1), {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(750);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}

const checks = [];

const nodeMajor = Number(process.versions.node.split(".")[0]);
checks.push(check("Node version", nodeMajor === 22 || nodeMajor === 20, `v${process.versions.node}; Node 22 LTS is recommended`));

checks.push(check("node_modules", existsSync(path.join(root, "node_modules")), "run npm install if missing"));
checks.push(check("local config", existsSync(path.join(root, "config", "lea.local.toml")), "copy config/lea.local.example.toml if missing"));
checks.push(check("server virtualenv", existsSync(path.join(root, "server", ".venv", "bin", "python")), "run npm run setup:api if missing"));
checks.push(check("Lea checkout", existsSync(path.join(root, "external", "lea-prover", "pyproject.toml")), "expected external/lea-prover"));
checks.push(check("Lea workspace root module", existsSync(path.join(root, "external", "lea-prover", "workspace", "proofs", "Lea.lean")), "create with: printf 'import Mathlib\\n' > external/lea-prover/workspace/proofs/Lea.lean"));

const configPath = path.join(root, "config", "lea.local.toml");
if (existsSync(configPath)) {
  const config = readFileSync(configPath, "utf8");
  checks.push(check("API key configured", /openai_api_key\s*=\s*"[^"]+"/.test(config) || /anthropic_api_key\s*=\s*"[^"]+"/.test(config) || /google_api_key\s*=\s*"[^"]+"/.test(config), "one provider key is needed"));
}

const apiImport = command(["./.venv/bin/python", "-c", "from app.main import app; print(app.title)"], {
  cwd: path.join(root, "server"),
});
checks.push(check("API imports", apiImport.status === 0, apiImport.stderr.trim() || apiImport.stdout.trim()));

const frontendPort = await portOpen(5173);
const apiPort = await portOpen(8000);
console.log(`[INFO] frontend port 5173 - ${frontendPort ? "already running" : "not running"}`);
console.log(`[INFO] API port 8000 - ${apiPort ? "already running" : "not running"}`);

if (!checks.every(Boolean)) {
  process.exitCode = 1;
}
