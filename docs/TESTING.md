# Testing & verification guide

This document lists every test suite in the project, what it covers, how to run
it, and which parts of the system are real versus mocked. Current results are
recorded in [ACCEPTANCE.md](ACCEPTANCE.md).

## Commands

Run from the project root, in PowerShell.

| Command | What it runs | Needs |
| --- | --- | --- |
| `npm run check` | Syntax check of the Electron main-process files and the two Electron-launched harness scripts, plus parse/link of all renderer ES modules (16 files) and the DOM-id contract between them and `index.html` (154 id lookups against 187 declared) | Node |
| `npm run test:js` | JavaScript unit tests (Node's built-in test runner) | Node |
| `npm run test:python` | Python unit tests (unittest) via the project interpreter | Python 3.11+ with `pymobiledevice3` |
| `npm test` | Both suites above | both |
| `npm run smoke` | End-to-end smoke test inside a real Electron window (60 checks) | Electron, Python bridge, internet (basemap check); an iPhone is optional |
| `npm run bridge:selfcheck` | Bridge protocol self-test with no device (8 checks) | Python + bridge deps |
| `.\.venv\Scripts\python.exe tools\acceptance.py` | Hardware acceptance run against a USB iPhone (35 checks) | an iPhone, USB, paired, Developer Mode on |
| `npm run capture:ui -- --out tmp/ui` | PNG per workspace per window size (1280×720, 1366×768, 1920×1080) plus a geometry table: map frame size, tile coverage, primary-action position, what falls below the fold | Electron, internet |
| `node scripts/capture-packaged.cjs --exe <exe> --out <png> --view <map\|device\|motion\|console>` | Screenshot evidence of a packaged build over CDP | a built executable |
| `npm run fix:wincodesign` | Repairs the electron-builder `winCodeSign` cache on Windows | Developer Mode or elevation, internet |

`npm run smoke -- --report tmp/smoke.json` additionally writes a machine-readable
result. The smoke run boots the **real** stack — `app://` protocol, preload/IPC
boundary, the Python bridge and usbmuxd — in a 1280×720 window; only the device
"deep scan" identity calls need an actual iPhone, and every other check is meaningful
without one. One check — the left rail picking up an attached iPhone with no click,
which guards the boot-time race between the renderer and the asynchronous bridge start
— is recorded only when `usbmuxd` reports a device, so a device-less run reports the
60 checks above and a run with a phone attached reports 61.

## Unit tests — JavaScript (60 tests)

| File | Tests | Covers |
| --- | --- | --- |
| `tests/js/app-protocol.test.cjs` | 10 | `app://` file serving: path-traversal refusal (encoded, UNC, backslash, NUL), MIME types, and that the header CSP and the `index.html` meta CSP cannot drift apart (the bug class where a host is allowed in one policy but blocked by the other). |
| `tests/js/ipc.test.cjs` | 21 | The IPC trust boundary: every method's input validation including the wireless channels, error envelopes, a bridge start failure surfacing as a structured response, bridge restart accounting. |
| `tests/js/validation.test.cjs` | 10 | Coordinate/route/GPX input rules shared with the UI: ranges, types, rejection codes (`INVALID_PARAMS`). |
| `tests/js/store.test.mjs` | 11 | Workspace persistence: atomic writes, corrupt-file recovery, merge semantics, failed writes swallowed rather than crashing. |
| `tests/js/util.test.mjs` | 8 | Renderer helpers: `mergeStages` (a fresh non-null stage wins; `null` never erases a measured value), formatting, sanitisation of file names. |

Mocks: IPC tests use a fake `ipcMain`/bridge harness; store tests use temp
directories. No Electron UI is involved.

## Unit tests — Python (171 tests)

| File | Tests | Covers |
| --- | --- | --- |
| `tests/python/test_wireless.py` | 55 | The wireless surface: endpoint model, transport allowlist and selection, mux grouping, mobdev2/lockdown visibility, the probe's per-transport measurements, verdict wording, connect/disconnect rules, link-error classification, capability assessment, medium pinning, and the JSON-RPC handlers. |
| `tests/python/test_simulation.py` | 27 | The simulation state machine: fixed set/clear, route playback pacing, pause/resume, disconnection, shutdown safety, transport honesty (the legacy path never claims device acknowledgement), medium pinning. |
| `tests/python/test_geo.py` | 20 | Route geometry: interpolation, schedules, distance and duration math, speed validation. |
| `tests/python/test_gpx.py` | 19 | GPX import/export: parsing, sanitisation of hostile/oversized input, export shape. |
| `tests/python/test_validation.py` | 17 | Bridge-side validation: coordinates, device ids, strings, numbers, route options, clamping untrusted output. |
| `tests/python/test_device_manager.py` | 16 | Stage bookkeeping and transport truth: measured stage facts remembered per UDID, folded into later cheap scans, invalidated only on negative evidence, and never reported over a network entry as if it were USB. |
| `tests/python/test_tunnel.py` | 8 | Tunnel manager: single-device enforcement, lifecycle, release that never raises. |
| `tests/python/test_protocol.py` | 9 | JSON-RPC envelopes: success/failure shape, request validation, unknown methods. |

Mocks: a fake usbmuxd device list (`FakeMuxDevice`), fake DVT target/services with
configurable acknowledgement (`FakeTarget`, `AcknowledgedTarget`, `LegacyFakeTarget`),
and a fake network for the probe. No real device is touched, and no real multicast DNS
is sent.

## End-to-end smoke test (60 checks)

`scripts/smoke-app.cjs` drives the real app in a 1280×720 Electron window — the
smallest size the redesign promises — and asserts what the UI may and may not claim.
Highlights:

* protocol/preload: allowlisted API only (30 entries), no generic `invoke` escape hatch;
* bridge: handshake, real interpreter/version reporting, usbmuxd state reported
  (not assumed), discovery answering with observed devices only;
* **layout geometry, not DOM presence**: `Start Location Simulation` painted above the
  fold, the whole primary-action panel including its hint inside the viewport, the dock
  beside the map column rather than over it, the map keeping usable space, the header
  status strip inside the top bar and not clipped mid-word, the workspace eyebrow on one
  line — each measured with `getBoundingClientRect()` and reported with its numbers;
* **tile coverage**: the loaded tile grid must span the whole map frame, which is how a
  Leaflet map revealed from a `display: none` workspace is caught still painting into
  its boot-time box. Polled with a 20 s deadline and reported as `24/24 tiles loaded,
  1024x768 of frame 722x368, settled after 794 ms`;
* honesty checks: the primary action is disabled *and* explains itself, an out-of-range
  coordinate is refused before any device call, a start against a missing device fails
  with `DEVICE_DISCONNECTED`, no surface claims a running simulation while nothing runs,
  the setup checklist never claims an unverified step;
* wireless wording: one painted row per transport, each row's mark equal to what the
  bridge measured, the summary reproduced verbatim, a device that was only advertised
  never listed as reachable, a Connect button only for an allowlisted transport, and no
  pairing material (PEM headers, key or record field names, `.plist`) anywhere in the
  window's visible text;
* keyboard: keys 1, 3 and 5 reach Overview, Routes and Settings;
* left rail: with an iPhone attached, the rail picks it up on its own without a click
  (recorded only when usbmuxd reports a device);
* basemap: decoded tiles come from the configured key-free tile hosts, and the dark
  basemap endpoint is probed cold for real imagery (a key-gated provider answers
  `200` with a ~2.5 KB "API KEY REQUIRED" watermark — this check exists because that
  regression shipped once);
* console hygiene: zero renderer console errors over the entire run.

The harness itself is syntax-checked by `npm run check`, because a load-time syntax
error in it makes Electron raise a modal error dialog that blocks the process forever
instead of failing the run.

## Bridge self-check (8 checks, offline)

`npm run bridge:selfcheck` starts the bridge without a device and verifies the
protocol contract: coordinate validation and rejection, haversine sanity, route length,
duration at a given speed, densification, a GPX round trip, and an XXE payload refused.
Useful on a machine without a phone.

## Hardware acceptance (35 checks)

`tools/acceptance.py` drives the **shipped** bridge binary (`python -m
location_studio_bridge serve`) over the same JSON protocol Electron uses, against a
USB iPhone. It sets a fixed location, runs a 4-waypoint route with pause/resume,
verifies pace accuracy, checks refusal codes, verifies session history, takes a
device screenshot while an override is active, and always issues a final safety
stop so the phone is never left pinned. Results for the recorded run are in
[ACCEPTANCE.md](ACCEPTANCE.md); regenerate with the command above and a phone
attached.

## Evidence capture

* `npm run capture:ui -- --out tmp/ui` boots the same real stack as the smoke test in a
  **visible** window and writes one PNG per workspace per window size plus
  `geometry.json`. Options: `--sizes 1280x720,1920x1080`, `--hidden` (see the warning
  below), `--animations` (do not force reduced motion).
  **Why the window is shown:** with `show: false` Chromium never presents the surface,
  and images decoded after the last paint are not always rasterised into the captured
  frame. Measured on this project: the DOM reported 24/24 tiles loaded, visible,
  opacity 1 and correctly transformed while the PNG showed one tile on a sea of
  background — 0 % of the map frame painted from a hidden window against 100 % from a
  shown one, with identical geometry numbers. A screenshot of a hidden window is not
  evidence that anything is visible.
* `node scripts/capture-packaged.cjs --exe "release/win-unpacked/Location Studio.exe" --out docs/reports/evidence/<name>.png --view map|device` opens a **packaged**
  build with a remote-debugging port, waits for the settled UI, screenshots it over
  CDP, then closes the window gracefully and stops the app.
* The reports in `docs/reports/` and the captures in `tmp/` are generated artefacts.
  They contain device identifiers (UDID) and machine paths — including your Windows
  user name in every workspace-file line — so they are **not published**: keep them on
  the machine that produced them and delete them when you are done. The packaged app
  ships no reports — the `docs` extraResources filter excludes the folder. Published
  screenshots are taken of the Location workspace, which shows no path.

## What the suites do *not* cover

* A physical cable-pull mid-session (the failure path is unit-tested with a fake
  usbmuxd; the physical act was not performed).
* iOS 16 or older devices, multiple simultaneous iPhones.
* **Any wireless device.** `wifi-mux` and `rsd-lan` have only ever been measured against
  an empty network: 55 Python tests run them against a fake usbmuxd and a fake multicast
  DNS, and the smoke test asserts how the UI words a probe that found nothing. Nothing in
  the suite can turn a `documented` wireless row into a `verified_hardware` one without a
  phone that is actually on the network.
* Apple's own apps against a simulated position.
* **The main-process lifecycle.** The smoke harness builds its own window and never
  loads `electron/main.cjs`, so the single-instance lock, the windowless
  `second-instance` recovery and the quit watchdog are not automated. They were checked
  by hand: launch, launch again, confirm the second process exits with code 0 while the
  first keeps its window, and read the two lines the startup log wrote
  (`start: development build…`, then `start refused: another instance owns this
  profile…`). A wedged windowless instance — the failure those guards exist for — was
  observed once in the wild and has not been reproduced on demand since.
* Code signing, the NSIS installer execution, and any CI environment — all suites
  are run locally on the development machine.
