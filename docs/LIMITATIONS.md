# Known limitations and scope

This document states exactly what Location Studio does **not** do, so nothing here
can be mistaken for a capability it does not have. Everything marked *verified* was
observed on the test iPhone (see [ACCEPTANCE.md](ACCEPTANCE.md)); everything marked
*not tested* was not exercised on hardware in this project, whatever the API
documentation suggests.

## Scope of the developer-location mechanism

| Limitation | Detail |
| --- | --- |
| The override is temporary | It exists only while a session is running. Pressing **Stop** restores real GPS (verified: `deviceCleared=true`). If the app is closed, the bridge process stops or the device is unplugged, the developer channel closes and the phone returns to real positioning. The cable-pull case is covered by unit tests with a fake usbmuxd; it was **not** physically exercised in this project. |
| Nothing is installed on the phone | No profile, certificate, app or driver is added. That also means there is nothing persistent to remove; when the session ends, the effect ends. |
| iOS shows no indicator | The developer channel has no system UI. Nothing on the phone tells its owner that a simulated position is active — so the *app's* explicit Stop button and status display are the only indicators, and they are on the desktop. |
| Server-side lookups are out of scope | Only on-device location consumers were verified (a third-party map app showed the simulated position). Services that resolve the device through Apple's infrastructure — Find My in particular — were **not tested** and are not affected by this developer channel in any documented way. Do not assume anything about them. |
| Locked phone | A screenshot taken while the phone was locked came back completely black, so a locked phone cannot be used as visual proof. The app's setup checklist correctly keeps **unlocked** as `NOT CHECKED` (`null`), because lock state is not observable through the bridge. |
| Altitude is metadata only | The iOS developer location selector takes latitude and longitude only. The altitude field in the UI is stored, exported to GPX and shown in previews — it is **never sent to the device** (`unsupported` in the capability matrix). |
| Pause/resume is route-only | A running route can be paused and resumed (verified). A fixed location cannot: the protocol has no such operation, and the bridge answers `UNSUPPORTED_OPERATION` instead of pretending. |
| Speed is host-side pacing | Route speed is produced by publishing coordinates at a controlled rate from the PC (measured pace error: 0.09 s over a 25.46 s route). It does not change any setting on the phone group. |
| Motion sensors are not spoofed | Accelerometer, gyroscope and step counting are untouched. Apps that fuse GPS with motion data may notice the inconsistency. |
| One device at a time | One bridge process owns one developer session for one selected device, over whichever allowlisted transport it proved. A session request for a different device is refused (`SIMULATION_ACTIVE` or a device-mismatch error). Two iPhones cannot be simulated simultaneously. |
| Wi-Fi is implemented but unproven | The bridge separates USB, `wifi-mux` (a network entry through the same usbmuxd pipe), `rsd-lan` (RemoteServiceDiscovery answered on the LAN) and `wifi-lockdown` (seen only, never offered). Identity reads pin the connection type so a Wi-Fi answer cannot be a USB answer in disguise. **No wireless-capable iPhone was ever attached while this build was verified**, so the tunnel and simulation over Wi-Fi stay `unknown`, and the app refuses to label a session wireless while the cable is attached — usbmuxd prefers the USB entry, so such a run would prove nothing about Wi-Fi. The supported, verified connection method remains the cable. |
| iOS 16 and older | Implemented against the legacy `com.apple.dt.simulatelocation` lockdown service, but **never hardware-tested** (no compatible device was available). That path is fire-and-forget: the bridge reports `deviceAcknowledged: false` and never labels the result hardware-confirmed. |
| Only Windows x64 is packaged | The app and bridge are not tested on macOS or Linux, and only `win-x64` artifacts are produced. |

## Operational limitations

| Limitation | Detail |
| --- | --- |
| Unsigned binaries | The installer and portable exe carry no code-signing certificate, so Windows SmartScreen shows a warning on first launch ("no signing info identified, signing is skipped" during the build). No certificate is bundled or fetched. |
| Python is not bundled | The packaged app needs a Python 3.11+ interpreter with `pymobiledevice3` (and `defusedxml`). The installer ships none. The app searches, in order: `LOCATION_STUDIO_PYTHON`, a `.venv` next to the app or project, then `py -3.12`, `py -3.11`, `py -3`, `python`. If none can import `pymobiledevice3`, the bridge reports `DEPENDENCY_MISSING`-class failure with the exact list of interpreters it probed and the installation command. `Start Location Studio.cmd` and the desktop shortcut point the app at the project `.venv` automatically. |
| The installer was built but not executed | Running it would modify the machine, so the NSIS installer is a build artifact only; the unpacked and portable builds were executed and verified. |
| No CI pipeline | All suites are run locally. Nothing guards the repository on push. |
| Windows-only build tooling quirk | On Windows, `electron-builder` downloads a `winCodeSign` archive that contains symlinks, which fails to extract without Developer Mode or elevation. `scripts/unpack-wincodesign.mjs` (`npm run fix:wincodesign`) verifies the archive hash and completes the extraction into the electron-builder cache; the workaround is environment-specific and documented so it can be dropped when upstream fixes it. |
| Map tiles and geocoding need internet | The basemap is served from Esri (dark canvas) and OpenStreetMap (light), geocoding from Nominatim. Offline, the app shows a tile-error notice and geocoding fails — it never renders a fake map. Tile providers' terms apply to their public endpoints. |

## Deliberately not done

| Not supported | Reason |
| --- | --- |
| Installing drivers, TUN/TAP adapters or MDM profiles | Requires administrator rights and would change the machine's security posture. The iOS 17+ path uses a userspace RSD tunnel and needs no elevation (verified from a non-elevated process). |
| Enabling Developer Mode | It is a security setting that only the device owner can change, on the phone, with a device restart. |
| Reading pairing material | The bridge lists the pairing-record folders and counts `*.plist` files by name (`remote_*` versus the rest) to answer "is a RemotePairing bootstrap present". File contents are never opened, and no key, token or record body reaches the renderer, the logs, or this repository. Where the system folder is not readable by an unprivileged process, the count is reported as *not countable* rather than as zero. |
| Hiding the simulation from the phone's owner | Out of scope: no jailbreak, no hooks, no persistent artefacts. |
| Auto-installing Python or packages | The app reports what is missing and how to install it; it never runs a package manager by itself. |
| Exposing arbitrary shell or commands to the UI | The renderer can only call a fixed JSON-RPC allowlist through the preload bridge; there is no generic `invoke` and the CSP is locked to the app's own origin plus the two tile hosts and the geocoder. |

## Test gaps (what has not been exercised on hardware)

* Physically unplugging the cable mid-session (unit tests cover the failure path).
* A fresh Trust prompt on an unpaired device (the test device was already paired).
* Any iOS 16 or older device.
* **Every wireless case.** A network usbmuxd entry has never been observed from this PC,
  so nothing has been measured on `wifi-mux` or `rsd-lan`: not the identity read, not the
  developer tunnel, not a location write. On 2026-10-21 the probe ran against a real
  iPhone 16 Pro (iOS 27.0.1) attached over USB with Wi-Fi sync reported as enabled, and
  it still saw no network entry, no reachable RSD and no pairing record that matched an
  advertisement — so the probe has now been exercised against hardware, but only ever to
  measure the *absence* of a wireless endpoint. Its verdict wording ("this PC could not
  ask" versus "no device answered") is unit-tested with a fake network rather than
  confirmed on one.
* Starting a pairing from scratch (`devices.pair` / the RemotePairing bootstrap) against
  a device that is not already trusted.
* Client-isolated networks, VPN adapters and firewalls that drop UDP 5353 — the probe
  reports per-interface failures, but no such network was available to test on.
* Multiple iPhones attached at once.
* Apple's own apps (Apple Maps, Find My, Safari) against a simulated position.
* The packaged build performing an actual location set (the packaged app was verified
  to start, reach readiness and drive the developer service; the recorded set/route
  acceptance run used the development tree).

The UI and wireless work in this repository's latest commits was verified with **no
iPhone attached at all**: the hardware row above is the earlier USB record, and every
wireless claim in the app is `documented` or `unknown` because there was no device to
turn it into evidence.
