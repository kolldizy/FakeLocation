/**
 * Capture a screenshot of the packaged Windows build while it is running for
 * real: the app opens its own window, starts the Python bridge, scans the
 * attached iPhone and renders the Device Center.
 *
 * This drives the *packaged* executable over the Chrome DevTools Protocol, so
 * the evidence it produces is about the shipped artifact, not about a dev run.
 *
 * Usage:
 *
 *     node scripts/capture-packaged.cjs \
 *       --exe "release/win-unpacked/Location Studio.exe" \
 *       --out docs/reports/evidence/packaged-device-center.png \
 *       --python .venv/Scripts/python.exe
 *
 * Options:
 *   --exe <path>      packaged executable (default: release/win-unpacked/Location Studio.exe)
 *   --out <path>      PNG to write (default: docs/reports/evidence/packaged-device-center.png)
 *   --python <path>   interpreter handed to the app via LOCATION_STUDIO_PYTHON
 *   --port <number>   remote debugging port (default: 9133)
 *   --view <name>     view to capture: map | device | motion | console (default: device)
 *   --timeout <ms>    how long to wait for the UI (default: 90000)
 */

const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const CDP = require("chrome-remote-interface");

const ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const options = {
    exe: path.join(ROOT, "release", "win-unpacked", "Location Studio.exe"),
    out: path.join(ROOT, "docs", "reports", "evidence", "packaged-device-center.png"),
    python: null,
    port: 9133,
    view: "device",
    timeout: 90_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--exe":
        options.exe = path.resolve(value);
        i += 1;
        break;
      case "--out":
        options.out = path.resolve(value);
        i += 1;
        break;
      case "--python":
        options.python = path.resolve(value);
        i += 1;
        break;
      case "--port":
        options.port = Number(value);
        i += 1;
        break;
      case "--view":
        options.view = value;
        i += 1;
        break;
      case "--timeout":
        options.timeout = Number(value);
        i += 1;
        break;
      default:
        console.error(`Unknown argument: ${flag}`);
        process.exit(2);
    }
  }
  return options;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stop the app this script started.
 *
 * Killing the launcher is not enough for the portable build: it unpacks to a temp
 * directory and exits, leaving the real app running. The window is closed first so
 * the app can stop the bridge itself; whatever is left is terminated. The app allows
 * a single instance, so a surviving "Location Studio.exe" can only be this run.
 */
async function stopApp(Runtime, port) {
  if (Runtime) {
    try {
      await evaluate(Runtime, "window.close(), true");
      await sleep(2000);
    } catch {
      /* the page may already be gone */
    }
  }
  const command = [
    `$port = '--remote-debugging-port=${port}'`,
    "Get-CimInstance Win32_Process -Filter \"Name = 'Location Studio.exe'\" |",
    "Where-Object { $_.CommandLine -like \"*$port*\" } |",
    "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    "Start-Sleep -Milliseconds 800",
    "Get-Process -Name 'Location Studio' -ErrorAction SilentlyContinue |",
    "Stop-Process -Force -ErrorAction SilentlyContinue",
  ].join(" ");
  try {
    execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], { stdio: "ignore" });
  } catch {
    /* best effort: the process may already be gone */
  }
}

async function listTargets(port, deadline) {
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === "page" && target.url.startsWith("app://"));
        if (page) return page;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(400);
  }
  throw new Error(`No app:// page appeared on port ${port}.${lastError ? ` Last error: ${lastError.message}` : ""}`);
}

async function evaluate(Runtime, expression) {
  const { result, exceptionDetails } = await Runtime.evaluate({
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
  }
  return result.value;
}

async function waitFor(Runtime, expression, deadline, label) {
  while (Date.now() < deadline) {
    if (await evaluate(Runtime, expression)) return;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

/** Like waitFor, but a missing result is not fatal: the screenshot still gets taken. */
async function waitForOptional(Runtime, expression, deadline) {
  while (Date.now() < deadline) {
    if (await evaluate(Runtime, expression)) return true;
    await sleep(500);
  }
  return false;
}

/**
 * Click a navigation button until the matching view is active.
 *
 * The renderer attaches its navigation listeners while booting, so an early click
 * can land on a button that has no handler yet; retrying is cheaper than guessing
 * at an internal "ready" flag.
 */
async function clickNavUntilActive(Runtime, view, deadline) {
  while (Date.now() < deadline) {
    await evaluate(Runtime, `document.querySelector('[data-view="${view}"]')?.click(), true`);
    await sleep(600);
    if (await evaluate(Runtime, `!!document.querySelector("#view-${view}.active")`)) return true;
  }
  return false;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(options.exe)) {
    console.error(`Packaged executable not found: ${options.exe}`);
    console.error('Build it first: "npm run dist" (installer + portable) or "npm run dist:dir" (unpacked).');
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(options.out), { recursive: true });

  const child = spawn(options.exe, [`--remote-debugging-port=${options.port}`], {
    cwd: path.dirname(options.exe),
    env: {
      ...process.env,
      LOCATION_STUDIO_VERBOSE: "1",
      ...(options.python ? { LOCATION_STUDIO_PYTHON: options.python } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const appLog = [];
  const collect = (chunk) => {
    const text = chunk.toString().trimEnd();
    if (text) appLog.push(text);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  const deadline = Date.now() + options.timeout;
  let client = null;
  try {
    const target = await listTargets(options.port, deadline);
    client = await CDP({ target, port: options.port });
    const { Page, Runtime } = client;
    await Page.enable();
    await Runtime.enable();

    if (options.view !== "map") {
      await waitForOptional(Runtime, `document.readyState === "complete"`, deadline);
      const switched = await clickNavUntilActive(Runtime, options.view, Math.min(deadline, Date.now() + 30_000));
      if (!switched) throw new Error(`Could not open the ${options.view} view.`);
    }

    if (options.view === "device") {
      // Opening the view triggers the deep scan. The readiness check itself is an
      // explicit action in the UI (the "Run readiness check" button), so drive it
      // here — only when it has not produced a verdict yet — to capture the app's
      // settled state rather than its idle one.
      await waitFor(
        Runtime,
        `document.querySelectorAll("#device-list .device-card").length > 0`,
        deadline,
        "a device card (is an iPhone attached and trusted?)",
      );
      await evaluate(
        Runtime,
        `(() => {
          const tag = document.querySelector("#readiness-tag");
          const button = document.querySelector("#btn-readiness");
          if (button && tag && tag.textContent.trim() === "NOT RUN") button.click();
          return true;
        })()`,
      );
      // Wait until the card carries the identity (model, iOS version) and the
      // readiness check has produced a verdict, so the screenshot shows the app in
      // its settled state rather than mid-scan.
      const settled = await waitForOptional(
        Runtime,
        `(() => {
          const meta = document.querySelector("#device-list .device-card .meta");
          const tag = document.querySelector("#readiness-tag");
          return Boolean(meta && meta.textContent.includes("iOS")) && Boolean(tag) && tag.textContent !== "NOT RUN";
        })()`,
        Math.min(deadline, Date.now() + 60_000),
      );
      if (!settled) appLog.push("[capture] the card never reported an iOS version and a readiness result; capturing anyway");
      await sleep(1200);
    } else {
      await sleep(2500);
    }

    const facts = await evaluate(
      Runtime,
      `(() => ({
        view: ${JSON.stringify(options.view)},
        devices: document.querySelectorAll("#device-list .device-card").length,
        deviceNames: Array.from(document.querySelectorAll("#device-list .device-card .name")).map((node) => node.textContent),
        readiness: (document.querySelector("#readiness-tag") || {}).textContent || null,
        bridgeChip: (document.querySelector("#rail-bridge-chip") || {}).textContent || null,
        deviceChip: (document.querySelector("#rail-device-chip") || {}).textContent || null,
        size: [window.innerWidth, window.innerHeight],
      }))()`,
    );

    const shot = await Page.captureScreenshot({ format: "png" });
    fs.writeFileSync(options.out, Buffer.from(shot.data, "base64"));

    console.log(`Screenshot: ${options.out}`);
    console.log(JSON.stringify(facts, null, 2));
    console.log("--- packaged app log ---");
    console.log(appLog.join("\n") || "(no output)");
  } catch (error) {
    console.error(`Capture failed: ${error.message}`);
    console.error("--- packaged app log ---");
    console.error(appLog.join("\n") || "(no output)");
    process.exitCode = 1;
  } finally {
    try {
      await stopApp(client ? client.Runtime : null, options.port);
    } finally {
      if (client) {
        try {
          await client.close();
        } catch {
          /* the window may already be gone */
        }
      }
      child.kill();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
