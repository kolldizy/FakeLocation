# Hardware acceptance record

Date: **2026-10-18**. Machine: Windows 11 Pro build 26300 (x64). Device under test:
**iPhone 16 Pro** (`iPhone17,1`), **iOS 27.0.1**, build **24A446**, connected over
USB, paired, Developer Mode enabled. The device UDID and machine user name are
masked in this published copy; the generated reports below are not published (they
contain device identifiers).

This is a snapshot of that day's tree. The wireless transport work and the UI
redesign landed afterwards, so nothing here says anything about them — a record of
USB success is not evidence of wireless success, and re-running the command below
against a phone would exercise the current bridge instead.

The run drives the **shipped** device bridge (`python -m location_studio_bridge serve`)
over the same newline-delimited JSON protocol Electron uses — not a lab script that
bypasses it. Artifacts produced by the run (not published; reproducible with the
commands in [TESTING.md](TESTING.md)):

| Artifact | What it is |
| --- | --- |
| `reports/hardware-acceptance.json` | Machine-readable result: 35 checks, environment, measurements, bridge stderr tail, event counts. |
| `reports/evidence/maps-paris-visual-proof.png` | Device screenshot taken while the coordinate `48.8557, 2.2981` was applied: Google Maps on the iPhone shows its position on the Champ de Mars in Paris. |
| `reports/evidence/lock-screen-capture-221700.png` | A capture taken earlier while the phone was locked. It came back completely black, which is exactly why a *locked* device is not visual proof of anything. |

Reproduce it with the project venv and the phone connected:

```powershell
.\.venv\Scripts\python.exe tools\acceptance.py
```

Result: **35/35 checks passed** in 30.0 s. The script always issues a final safety
stop, so the device is never left on a simulated position.

## Measured results

| Measurement | Value |
| --- | --- |
| Bridge / interpreter | `location_studio_bridge` 1.0.0 · Python 3.11.9 · pymobiledevice3 11.35.0 |
| usbmuxd | `127.0.0.1:27015`, 1 device reported |
| Readiness | `ready=true`; checks: usbmuxd, device present, paired, Developer Mode, transport, tunnel, DVT service — all `true` |
| Fixed set | transport `dvt-rsd`, `deviceAcknowledged=true`, first coordinate applied before `active` was reported |
| Stop | `state=stopped`, `deviceCleared=true`, `locationOverrideActive=false` |
| Route | 4 waypoints → 130 playback points, 636.4 m, 25 m/s |
| Route completion | 129 of 130 points published (`publishedPointCount == totalPoints - 1`), `state=completed` |
| Pace accuracy | elapsed 25.55 s vs estimated 25.46 s → **0.09 s** late |
| Pause | accepted on the route; published count held at 31 across a 3 s sample |
| Resume | accepted; publishing continued to completion |
| Session history | 2 sessions, exactly one row each, both carrying the final `stopped` state |
| Events | 7 `simulation.state`, 59 `simulation.progress` |
| Screenshot | PNG returned (4.3 MB, 1206×2622) while the override was applied |

## Honesty checks (the ones that matter most)

These assert that nothing claims success it did not observe:

| Check | Observed |
| --- | --- |
| Pause on a *fixed* location (nothing to suspend) | `UNSUPPORTED_OPERATION: A fixed location cannot be paused.` |
| Second session while a route is running | `SIMULATION_ACTIVE` |
| Out-of-range coordinate | `INVALID_PARAMS`, refused before any device call |
| Start against an absent device | `DEVICE_DISCONNECTED` (not a success, not a crash) |
| Pause with no session | `NO_ACTIVE_SIMULATION` |
| Bridge health after all refusals | still healthy; error paths do not kill the process |
| Override after a completed route | `locationOverrideActive=true` until Stop — the device really is still pinned |
| Stop after completion | real GPS restored (`deviceCleared=true`) |

## Software verification in the same session

| Suite | Command | Result |
| --- | --- | --- |
| Python unit tests | `npm run test:python` | 107 passed |
| JavaScript unit tests | `npm run test:js` | 56 passed |
| End-to-end renderer/IPC/bridge smoke test | `npm run smoke` | 25/25 checks passed with the phone attached, 24/24 without it (report not published) |
| Bridge offline self-check | `npm run bridge:selfcheck` | 8/8 checks passed |
| Syntax + ES module graph check | `npm run check` | 11 renderer modules parsed and linked |

The smoke suite grew after the device run: two basemap checks were added (a
key-gated tile provider had silently replaced real imagery with "API KEY REQUIRED"
watermarks while answering HTTP 200) and one check now proves the left rail picks
up an attached iPhone by itself, without any click.

## Packaged Windows build

Built with `npm run dist` on the same machine; binaries are **unsigned** ("no
signing info identified, signing is skipped"). The packaged app bundles only the
documentation pages; the build's `extraResources` filter excludes `docs/reports`
and `docs/media`, so no evidence reports or screenshots ship inside the app.

| Artifact | Size | SHA-256 |
| --- | --- | --- |
| `LocationStudio-1.0.0-win-x64.exe` (portable) | 82.24 MB | `0ACE3476095A4A1D51DBC9F0DFEC6EC00A29193F41703695D897CEA4883B7098` |
| `LocationStudio-Setup-1.0.0.exe` (NSIS installer) | 82.49 MB | `824C11BE684A7F75A4E2922ECFEEF19ED6FC295949D32B18A60E6CE6F4616CF0` |

Verified with a packaged executable launched for real (not a development run):

| Check | Result |
| --- | --- |
| Unpacked build starts, bridge reaches `ready`, renderer loads `app://bundle/index.html` | verified over CDP |
| Portable build self-extracts, starts app + bridge, shuts down with no leftover processes | verified over CDP |
| iPhone flow through the packaged app: device listed, readiness `READY`, all five setup stages green (USB, PAIRED, DEV MODE, DEV SERVICE, SIM READY) | verified on a packaged run with the phone attached |
| Basemap renders from the shipped build | verified (screenshot not published) |

The NSIS installer was **built but not executed** — installing would modify this
machine. The acceptance route above used the development tree; see the next table.

## What this run did **not** exercise

Stated explicitly so nothing is over claimed:

| Not exercised | Consequence |
| --- | --- |
| Physically unplugging the cable mid-session | The disconnection path is covered by unit tests with a fake usbmuxd (`DEVICE_DISCONNECTED`, session ends, device released). The physical cable-pull was not performed in this run. |
| A fresh Trust prompt | The device was already paired, so only the pairing *record* was verified. |
| Any iOS 16 or older device | The legacy `com.apple.dt.simulatelocation` path remains `documented`, never hardware-verified. |
| Wi-Fi / network-attached devices | Nothing over the network was exercised on 2026-10-18: this run used a cable only. Wireless support landed after it and has **never** been run against a phone; [COMPATIBILITY.md](COMPATIBILITY.md) is the authority for what each wireless transport is verified, documented or unknown. |
| Apple's own apps (Apple Maps, Find My, Safari) | Only a third-party map app (Google Maps) was verified on screen. System services that resolve the device through Apple's servers — Find My device tracking in particular — are not covered by the developer channel and were not tested. |
| Locked-device behaviour | A screenshot taken while locked returned a black frame; the app keeps "unlocked" as not-checked because it is not observable. |
| The packaged build running the full acceptance route | The packaged app was verified to start, reach readiness and drive the device flow (table above); the 35-check set/route run used the development tree. |
