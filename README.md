# Location Studio

Windows desktop app for **real iPhone location simulation** over USB, with a Cyber
Motion UI: a map studio, a device center, a motion preview and a simulation console
in one workspace.

It is not a mock-up and not a GPS file exporter. It drives the iPhone through the
same developer services Xcode's location simulation uses
(`com.apple.instruments.server.services.LocationSimulation` over a userspace RSD
tunnel on iOS 17+ — no administrator rights, no TUN/TAP driver, nothing installed
on the phone). Every capability is labelled **verified on hardware**, **documented
but not hardware-tested**, **unknown** or **unsupported**, and the UI never shows a
success it did not observe.

## Screenshots

![Location Studio — Map Studio over the Esri dark basemap](docs/media/app-screenshot.png)

*The real app: Map Studio on the dark basemap, with the coordinate inspector, saved
locations and route builder on the right, and the device link and bridge state on
the left.*

| Illustrative mockup — Tinder | Illustrative mockup — Snapchat |
| --- | --- |
| ![Changing the device location seen by Tinder](docs/media/tinder-location-mockup.png) | ![Changing the device location seen by Snapchat](docs/media/snapchat-location-mockup.png) |

*Concept artwork showing the outcome (these two are mockups, not screenshots of
Location Studio): the app sets the iPhone's position at the system level, so apps
like Tinder and Snapchat see the simulated location. It never touches or modifies
those apps — the screenshots of the app itself are the Map Studio view above.*

## Quick start (Windows)

| Requirement | Notes |
| --- | --- |
| Windows 10/11 x64 | Built and verified on Windows 11 (build 26300). |
| An iPhone with iOS 17 or newer | This is the verified path. iOS 16 and older use a legacy developer path that is implemented but was never hardware-tested here. |
| USB data cable, paired, Developer Mode enabled | Developer Mode lives in Settings → Privacy & Security. Pairing is the usual Trust prompt. |
| "Apple Devices" app (or iTunes) installed | Provides usbmuxd / Apple Mobile Device Service for USB communication. |
| Python 3.11+ with `pymobiledevice3==11.35.0` and `defusedxml==0.7.1` | Powers the device bridge. Not bundled; see below. |

**The easy way — from this folder**

1. Double-click **`Start Location Studio.cmd`** (or the *Location Studio* desktop
   shortcut). It points the app at the project's Python environment, launches the
   packaged build from `release\` when one exists, and otherwise starts from source.
2. Plug in the iPhone, unlock it, tap **Trust**, and open **Device Center** in the app.
3. Press **Run readiness check**, select the phone, then apply a location from
   **Simulation Console** or play a route from **Map Studio**.

**From source**

```powershell
npm install
npm run check
npm test
npm start
```

**Packaged executables** — `npm run dist` produces `release\LocationStudio-1.0.0-win-x64.exe`
(portable) and `release\LocationStudio-Setup-1.0.0.exe` (installer). They are
**unsigned**, so Windows SmartScreen warns on first launch ("More info → Run
anyway"). Packaged builds find Python through `LOCATION_STUDIO_PYTHON` first, so the
launcher script above is the recommended way to start them.

**Python bridge environment** — install the bridge dependency once, in a virtual
environment next to the source:

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r bridge\requirements.txt
```

The app finds this `.venv` automatically (or set `LOCATION_STUDIO_PYTHON` to any
interpreter that has `pymobiledevice3` installed). If no suitable interpreter
exists, the map and GPX tools still work and Device Center reports exactly which
interpreters were probed and what to install.

## The four workspaces

| Workspace | What it does |
| --- | --- |
| **Map Studio** | Pick a target coordinate on the map or by typing lat/lon, search places, build multi-waypoint routes with per-route speed, import/export GPX, and save locations and routes. |
| **Device Center** | Detect the USB iPhone and report *only what was observed*: usbmuxd state, pairing, Developer Mode, developer service, simulation readiness — plus a capability matrix with dated evidence per row. |
| **Motion Lab** | Host-side preview of a route: play/pause/resume/reset, 0.25×–8× multiplier, progress and trail. Explicitly labelled as a visual preview — it does not move the phone. |
| **Simulation Console** | The real device operations: start/stop a fixed location, play/pause/resume/stop a route, live progress, device screenshot, session history. |

Honesty rules the app enforces everywhere: a device operation is reported as
successful only after the device acknowledged it; unsupported operations answer
with `UNSUPPORTED_OPERATION` instead of pretending; a second session is refused
while one is active; and the simulation ends — leaving real GPS restored — the
moment you press Stop, close the app or unplug the cable.

## Verification status

| Result | Scope |
| --- | --- |
| **35/35** hardware acceptance checks in 30 s | Physical iPhone (iPhone 16 Pro, iOS 27.0.1 build 24A446) over USB: fixed set, route playback, pause/resume, pace accuracy, disconnection handling, refusal codes, session history, device screenshot. Device identifiers are omitted from this repository. |
| **25/25** smoke checks | Real Electron app: protocol, preload/IPC boundary, bridge, usbmuxd, UI honesty rules, basemap integrity, console hygiene. 24/24 without a phone attached (one check is skipped). |
| **56** JS + **107** Python unit tests | Validation, GPX, interpolation, simulation state machine, tunnel, persistence, IPC, CSP. |
| **8/8** bridge self-check | Protocol contract with no device attached. |

Docs: [COMPATIBILITY.md](docs/COMPATIBILITY.md) (capability matrix) ·
[ACCEPTANCE.md](docs/ACCEPTANCE.md) (the recorded hardware run) ·
[TESTING.md](docs/TESTING.md) (how to run and reproduce everything) ·
[LIMITATIONS.md](docs/LIMITATIONS.md) (scope and known limits).

Generated reports and screenshots go to `docs/reports/` when you run the tools.
They contain device identifiers, so they are never published and never bundled into
the packaged app — treat them as local scratch and delete them when done.

## Building

```powershell
npm run dist        # NSIS installer + portable exe (release\)
npm run dist:dir    # unpacked build only (release\win-unpacked\)
```

On Windows, electron-builder may fail to extract its `winCodeSign` helper archive
(symlink permissions). `npm run fix:wincodesign` verifies the archive hash and
completes the extraction into the electron-builder cache; see
[LIMITATIONS.md](docs/LIMITATIONS.md).

## Project structure

```text
electron/            Main process: window, app:// protocol + CSP, IPC allowlist,
                     bridge supervisor, workspace store
renderer/            UI (ES modules, strict CSP): map studio, device center,
                     motion lab, simulation console, vendored Leaflet
bridge/              Python bridge package: device discovery, RSD tunnel, DVT
                     location simulation, GPX, route scheduler, JSON-RPC server
scripts/             Tooling: asset vendoring, renderer link check, bridge runner,
                     python test runner, winCodeSign fix, smoke test, capture tool
tests/               Unit tests (js/ and python/)
tools/               Hardware acceptance runner + fixtures
docs/                Compatibility, acceptance record, testing guide, limitations
Start Location Studio.cmd   One-double-click launcher (see above)
```

## Data and external services

* Basemap tiles: Esri "Dark Gray Canvas" (dark theme) and OpenStreetMap (light
  theme) — both key-free public endpoints. Tile attribution is shown on the map.
* Geocoding: OpenStreetMap Nominatim. Respect its usage policy; this app makes
  individual search requests only.
* No account, no telemetry, no cloud backend. Everything else stays local: the
  workspace is a JSON document in the app's user-data folder.

## Security posture

* Only a user-selected device is ever operated on; one bridge process owns one
  device and refuses sessions for any other UDID.
* The renderer is sandboxed: a fixed JSON-RPC allowlist over the preload bridge,
  no generic `invoke`, no shell access, strict CSP (own origin + the two tile hosts
  + the geocoder only).
* No driver installs, no TUN/TAP, no administrator rights, no changes to the phone
  (no profiles, certificates or apps), no hidden persistence.
* Coordinates and GPX files are validated on both sides of the boundary before any
  device call; the UI never executes data from files or devices.
