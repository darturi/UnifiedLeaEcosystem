import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const root = process.cwd();
const children = [];

function fail(message) {
  console.error(`\n[dev] ${message}`);
  process.exit(1);
}

function ensure(pathname, message) {
  if (!existsSync(path.join(root, pathname))) {
    fail(message);
  }
}

function waitFor(url, label, timeoutMs = 20000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const request = http.get(url, (response) => {
        response.resume();
        resolve();
      });
      request.setTimeout(1000, () => {
        request.destroy();
      });
      request.on("error", () => {
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`${label} did not become ready at ${url}`));
          return;
        }
        setTimeout(tick, 400);
      });
    };
    tick();
  });
}

function start(label, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    ...options,
  });
  children.push(child);

  child.stdout.on("data", (chunk) => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${label}] ${chunk}`));
  child.on("exit", (code) => {
    if (code !== 0 && !shuttingDown) {
      console.error(`[dev] ${label} exited with ${code}`);
      shutdown();
    }
  });
  return child;
}

let shuttingDown = false;
function shutdown() {
  shuttingDown = true;
  for (const child of children) {
    child.kill("SIGINT");
  }
  setTimeout(() => process.exit(0), 200);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

ensure("node_modules", "node_modules is missing. Run npm install.");
ensure("config/lea.local.toml", "config/lea.local.toml is missing. Copy config/lea.local.example.toml.");
ensure("server/.venv/bin/python", "server virtualenv is missing. Run npm run setup:api.");
ensure("external/lea-prover/pyproject.toml", "external/lea-prover is missing.");

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor !== 22 && nodeMajor !== 20) {
  console.warn(`[dev] Node ${process.versions.node} detected. Node 22 LTS is recommended.`);
}

start("api", "./.venv/bin/python", ["run_api.py"], { cwd: path.join(root, "server") });

try {
  await waitFor("http://127.0.0.1:8000/api/health", "API");
  console.log("[dev] API ready at http://127.0.0.1:8000");
} catch (error) {
  console.error(`[dev] ${error.message}`);
  shutdown();
}

start("web", path.join(root, "node_modules", ".bin", "vite"), ["--host", "0.0.0.0"]);

try {
  await waitFor("http://127.0.0.1:5173", "frontend");
  console.log("[dev] Frontend ready at http://localhost:5173");
  console.log("[dev] Press Ctrl+C to stop both servers.");
} catch (error) {
  console.error(`[dev] ${error.message}`);
  shutdown();
}

