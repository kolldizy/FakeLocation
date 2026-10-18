/**
 * Runs the Python unit tests with whichever interpreter has the bridge
 * dependency installed. Keeps `npm test` working on a fresh clone.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const candidates = [];
if (process.env.LOCATION_STUDIO_PYTHON) candidates.push(process.env.LOCATION_STUDIO_PYTHON);
if (process.platform === "win32") {
  candidates.push(path.join(root, ".venv", "Scripts", "python.exe"));
  candidates.push("py");
} else {
  candidates.push(path.join(root, ".venv", "bin", "python3"));
  candidates.push("python3");
}

function probe(file) {
  return new Promise((resolve) => {
    const args = file === "py" ? ["-3", "-c", "import sys;print(sys.executable)"] : ["-c", "import sys;print(sys.executable)"];
    const child = spawn(file, args, { windowsHide: true });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 && out.trim() ? out.trim() : null));
  });
}

let interpreter = null;
for (const candidate of candidates) {
  if (candidate.includes(path.sep) && !fs.existsSync(candidate)) continue;
  interpreter = await probe(candidate);
  if (interpreter) break;
}

if (!interpreter) {
  console.error("No usable Python interpreter found for the bridge tests.");
  process.exit(3);
}

const child = spawn(interpreter, ["-m", "unittest", "discover", "-s", "tests/python", "-t", "tests/python", "-v"], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
  env: {
    ...process.env,
    PYTHONPATH: [path.join(root, "bridge"), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    PYTHONIOENCODING: "utf-8",
  },
});

child.on("close", (code) => process.exit(code ?? 1));
