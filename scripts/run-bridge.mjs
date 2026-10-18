/**
 * Locates the bridge's Python interpreter the same way the app does, then runs a
 * bridge subcommand (selfcheck, discover, readiness, ...) with the right
 * PYTHONPATH. Used by npm scripts and by the hardware acceptance procedure.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

function candidates() {
  const list = [];
  if (process.env.LOCATION_STUDIO_PYTHON) list.push({ file: process.env.LOCATION_STUDIO_PYTHON, args: [] });
  if (process.platform === "win32") {
    const venv = path.join(root, ".venv", "Scripts", "python.exe");
    if (fs.existsSync(venv)) list.push({ file: venv, args: [] });
    list.push({ file: "py", args: ["-3.12"] }, { file: "py", args: ["-3.11"] }, { file: "py", args: ["-3"] }, { file: "python", args: [] });
  } else {
    const venv = path.join(root, ".venv", "bin", "python3");
    if (fs.existsSync(venv)) list.push({ file: venv, args: [] });
    list.push({ file: "python3", args: [] }, { file: "python", args: [] });
  }
  return list;
}

function probe(candidate) {
  return new Promise((resolve) => {
    const child = spawn(candidate.file, [...candidate.args, "-c", "import pymobiledevice3,sys;print(sys.executable)"], {
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 && out.trim() ? out.trim() : null));
  });
}

const args = process.argv.slice(2);
if (!args.length) {
  console.error("usage: node scripts/run-bridge.mjs <bridge-subcommand> [args...]");
  process.exit(2);
}

let interpreter = null;
const tried = [];
for (const candidate of candidates()) {
  interpreter = await probe(candidate);
  if (interpreter) break;
  tried.push(candidate.file);
}

if (!interpreter) {
  console.error(
    "No Python interpreter with pymobiledevice3 was found.\nChecked: " +
      tried.join(", ") +
      "\n\nInstall it with:\n  py -3.11 -m venv .venv\n  .venv\\Scripts\\python.exe -m pip install -r bridge\\requirements.txt"
  );
  process.exit(3);
}

const child = spawn(interpreter, ["-m", "location_studio_bridge", ...args], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
  env: {
    ...process.env,
    PYTHONPATH: [path.join(root, "bridge"), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    PYTHONIOENCODING: "utf-8",
  },
});

child.on("close", (code) => process.exit(code ?? 0));
