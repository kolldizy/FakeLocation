# Testing & verification guide

This document lists every test suite in the project, what it covers, how to run
it, and which parts of the system are real versus mocked. Current results are
recorded in [ACCEPTANCE.md](ACCEPTANCE.md).

## Commands

Run from the project root, in PowerShell.

| Command | What it runs | Needs |
| --- | --- | --- |
| `npm run check` | Syntax check of the Electron main-process files + parse/link of all renderer ES modules (11 files) | Node |
| `npm run test:js` | JavaScript unit tests (Node's built-in test runner) | Node |
| `npm run test:python` | Python unit tests (unittest) via the project interpreter | Python 3.11+ with `pymobiledevice3` |
| `npm test` | Both suites above | both |
| `npm run smoke` | End-to-end smoke test inside a real Electron window (25 checks) | Electron, Python bridge, internet (basemap check), optionally an iPhone |
| `npm run bridge:selfcheck` | Bridge protocol self-test with no device (8 checks) | Python + bridge deps |
| `.\.venv\Scripts\python.exe tools\acceptance.py` | Hardware acceptance run against a USB iPhone (35 checks) | an iPhone, USB, paired, Developer Mode on |
| `node scripts/capture-packaged.cjs --exe <exe> --out <png> --view <map\|device\|motion\|console>` | Screenshot evidence of a packaged build over CDP | a built executable |
| `npm run fix:wincodesign` | Repairs the electron-builder `winCodeSign` cache on Windows | Developer Mode or elevation, internet |

`npm run smoke -- --report docs/reports/renderer-smoke.json` additionally writes a
machine-readable result. The smoke run boots the **real** stack — `app://` protocol,
preload/IPC boundary, the Python bridge and usbmuxd — in a hidden window; only the
device "deep scan" identity calls need an actual iPhone, and every other check is
meaningful without one. When no iPhone is attached the left-rail check is skipped,
so a device-less run reports 24 checks instead of 25.

## Unit tests — JavaScript (56 tests)

| File | Tests | Covers |
| --- | --- | --- |
| `tests/js/app-protocol.test.cjs` | 10 | `app://` file serving: path-traversal refusal (encoded, UNC, backslash, NUL), MIME types, and that the header CSP and the `index.html` meta CSP cannot drift apart (the bug class where a host is allowed in one policy but blocked by the other). |
| `tests/js/ipc.test.cjs` | 17 | The IPC trust boundary: every method's input validation, error envelopes, a bridge start failure surfacing as a structured response, bridge restart accounting. |
| `tests/js/validation.test.cjs` | 10 | Coordinate/route/GPX input rules shared with the UI: ranges, types, rejection codes (`INVALID_PARAMS`). |
| `tests/js/store.test.mjs` | 11 | Workspace persistence: atomic writes, corrupt-file recovery, merge semantics, failed writes swallowed rather than crashing. |
| `tests/js/util.test.mjs` | 8 | Renderer helpers: `mergeStages` (a fresh non-null stage wins; `null` never erases a measured value), formatting, sanitisation of file names. |

Mocks: IPC tests use a fake `ipcMain`/bridge harness; store tests use temp
directories. No Electron UI is involved.

## Unit tests — Python (107 tests)

| File | Tests | Covers |
| --- | --- | --- |
| `tests/python/test_geo.py` | 20 | Route geometry: interpolation, schedules, distance and duration math, speed validation. |
| `tests/python/test_gpx.py` | 19 | GPX import/export: parsing, sanitisation of hostile/oversized input, export shape. |
| `tests/python/test_protocol.py` | 9 | JSON-RPC envelopes: success/failure shape, request validation, unknown methods. |
| `tests/python/test_simulation.py` | 23 | The simulation state machine: fixed set/clear, route playback pacing, pause/resume, disconnection, shutdown safety, transport honesty (legacy path never claims device acknowledgement). |
| `tests/python/test_tunnel.py` | 8 | Tunnel manager: single-device enforcement, lifecycle, release that never raises. |
| `tests/python/test_validation.py` | 17 | Bridge-side validation: coordinates, strings, clamping untrusted output. |
| `tests/python/test_device_manager.py` | 11 | Stage bookkeeping: measured stage facts are remembered per UDID, folded into later cheap scans, invalidated only on negative evidence. |

Mocks: a fake usbmuxd device list (`FakeMuxDevice`), fake DVT target/services with
configurable acknowledgement (`FakeTarget`, `AcknowledgedTarget`, `LegacyFakeTarget`).
No real device is touched.

## End-to-end smoke test (25 checks)

`scripts/smoke-app.cjs` drives the real app in an Electron window and asserts what
the UI may and may not claim. Highlights:

* protocol/preload: allowlisted API only, no generic `invoke` escape hatch;
* bridge: handshake, real interpreter/version reporting, usbmuxd state reported
  (not assumed);
* left rail picks up an attached iPhone on its own, without any click (this guards
  the startup race between the renderer boot and the asynchronous bridge start);
* honesty checks: an out-of-range coordinate is refused before any device call, a
  start against a missing device fails with `DEVICE_DISCONNECTED`, no card claims a
  running simulation while nothing runs, the setup checklist never claims an
  unverified step;
* basemap: decoded tiles come from the configured key-free tile hosts, and the dark
  basemap endpoint is probed cold for real imagery (a key-gated provider answers
  `200` with a ~2.5 KB "API KEY REQUIRED" watermark — this check exists because that
  regression shipped once);
* console hygiene: zero renderer console errors over the entire run.

## Bridge self-check (8 checks, offline)

`npm run bridge:selfcheck` starts the bridge without a device and verifies the
protocol contract: handshake, health, discover with no usbmuxd devices, capability
vocabulary, refusal codes for invalid parameters, unknown methods and shutdown
behaviour. Useful on a machine without a phone.

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

* `node scripts/capture-packaged.cjs --exe "release/win-unpacked/Location Studio.exe" --out docs/reports/evidence/<name>.png --view map|device` opens a **packaged**
  build with a remote-debugging port, waits for the settled UI, screenshots it over
  CDP, then closes the window gracefully and stops the app.
* The reports in `docs/reports/` are generated artefacts. They contain device
  identifiers (UDID) and machine paths, so in this repository they are **not
  published**: they stay on the machine that produced them. Regenerate them locally
  with the commands above.

## What the suites do *not* cover

* A physical cable-pull mid-session (the failure path is unit-tested with a fake
  usbmuxd; the physical act was not performed).
* iOS 16 or older devices, Wi-Fi devices, multiple simultaneous iPhones.
* Apple's own apps against a simulated position.
* Code signing, the NSIS installer execution, and any CI environment — all suites
  are run locally on the development machine.
