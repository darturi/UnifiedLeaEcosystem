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

function commandDetail(result) {
  return result.error?.message || result.stderr?.trim() || result.stdout?.trim() || "";
}

function portOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
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
checks.push(check(
  "Lea submodule",
  existsSync(path.join(root, "external", "lea-prover", "pyproject.toml")),
  "run git submodule update --init --recursive if missing",
));
checks.push(check(
  "bundled Lea API virtualenv",
  existsSync(path.join(root, "external", "lea-prover", ".venv", "bin", "python")),
  "run npm run setup:api if missing",
));

const configPath = path.join(root, "config", "lea.local.toml");
let leaApiUrl = "http://127.0.0.1:8000";
if (existsSync(configPath)) {
  const config = readFileSync(configPath, "utf8");
  leaApiUrl = config.match(/lea_api_base_url\s*=\s*"([^"]+)"/)?.[1] || leaApiUrl;
  try {
    const parsed = new URL(leaApiUrl);
    checks.push(check("Lea API URL", ["http:", "https:"].includes(parsed.protocol), leaApiUrl));
  } catch {
    checks.push(check("Lea API URL", false, "lea_api_base_url must be an absolute http(s) URL"));
  }
}

const apiImport = command(["./.venv/bin/python", "-c", "from app.main import app; print(app.title)"], {
  cwd: path.join(root, "server"),
});
checks.push(check("API imports", apiImport.status === 0, commandDetail(apiImport)));

if (existsSync(path.join(root, "external", "lea-prover", ".venv", "bin", "python"))) {
  const leaApiImport = command(["./.venv/bin/python", "-c", "import importlib.metadata as m; print(m.version('lea-prover'))"], {
    cwd: path.join(root, "external", "lea-prover"),
  });
  checks.push(check("bundled Lea API package", leaApiImport.status === 0, commandDetail(leaApiImport)));
}

const frontendPort = await portOpen(5173);
const adapterPort = await portOpen(8001);
let leaApiReachable = false;
try {
  const parsed = new URL(leaApiUrl);
  leaApiReachable = await portOpen(Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)), parsed.hostname);
} catch {
  leaApiReachable = false;
}
console.log(`[INFO] frontend port 5173 - ${frontendPort ? "already running" : "not running"}`);
console.log(`[INFO] UI adapter API port 8001 - ${adapterPort ? "already running" : "not running"}`);
console.log(`[INFO] Lea API ${leaApiUrl} - ${leaApiReachable ? "reachable" : "not reachable"}`);

if (!checks.every(Boolean)) {
  process.exitCode = 1;
}
