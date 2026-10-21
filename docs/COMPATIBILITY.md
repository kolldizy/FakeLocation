# Compatibility matrix

Everything in this file is either **verified on hardware from this codebase**, **documented
from the upstream API but not hardware-tested here**, **unknown**, or **unsupported**.

Status vocabulary (the same one the app shows in the Device workspace):

| Status | Meaning |
| --- | --- |
| `verified_hardware` | Exercised end to end against a physical iPhone from this codebase. |
| `documented` | The upstream API exists and is implemented here, but this codebase has not run it against hardware. |
| `unknown` | Neither confirmed nor denied. The UI treats it as unsupported. |
| `unsupported` | The protocol does not offer the operation. |

## Verified combinations

| Component | Verified value | Notes |
| --- | --- | --- |
| iPhone model | `iPhone17,1` (iPhone 16 Pro) | Reported by lockdownd, not assumed. |
| iOS version | `27.0.1` (build `24A446`) | `iosMajor` 27 → iOS 17+ transport path. |
| Device CPU / board | `arm64e`, `D93AP` | Read from the device. |
| Connection | USB, paired, Developer Mode on | usbmuxd `127.0.0.1:27015` (Apple Mobile Device Service). |
| Host OS | Windows 11 Pro, build `26300`, x64 | Same machine used for both acceptance runs. |
| Python | 3.11.9 in a project `.venv` | Any 3.11+ with `pymobiledevice3==11.35.0` should behave the same. |
| Device bridge | `location_studio_bridge` 1.0.0 | Python 3.11 target. |
| Electron | 35.7.5 (Chromium 134, Node 22.16) | `node` 24.18.1 used for the Node-level tests. |
| Simulation transport | DVT `com.apple.instruments.server.services.LocationSimulation` over a userspace RSD tunnel | No administrator rights, no TUN/TAP driver. |

Result of the recorded acceptance run: **35/35 checks passed** — see [ACCEPTANCE.md](ACCEPTANCE.md).
That run predates the wireless work. No iPhone has ever appeared as a wireless endpoint on
this machine: the one hardware probe since then (2026-10-21, iPhone 16 Pro / iOS 27.0.1 over
USB, Wi-Fi sync enabled on the phone) found zero usbmuxd network entries and zero reachable
RSD advertisements. So every wireless row below is `documented` or `unknown` rather than
verified, and no part of this file claims a wireless success.

## iOS version support

| iOS version | Transport | Status |
| --- | --- | --- |
| 17 and newer | Userspace RSD tunnel → DVT `LocationSimulation` (`simulateLocationWithLatitude:longitude:`). | `verified_hardware` on 27.0.1 |
| 16 and older | lockdown `com.apple.dt.simulatelocation` (`DtSimulateLocation`). | `documented` — no compatible device was available, so this path has never been executed against hardware. Writes on this path are fire-and-forget, so the bridge reports results with `deviceAcknowledged: false` and never labels them hardware-confirmed. |

The transport is chosen from the iOS version the device reports; it is not selected manually.

## Host requirements

| Requirement | Why | Status check in the app |
| --- | --- | --- |
| Apple Mobile Device Support (Microsoft Store app “Apple Devices”, or iTunes) | Provides `usbmuxd` and the USB filter drivers that expose an iPhone to non-Apple software. | Device → bridge health → `usbmuxd`, and the six-step setup checklist in Settings. |
| Python 3.11+ with `pymobiledevice3==11.35.0` and `defusedxml==0.7.1` | The device bridge. | Bridge chip in the left rail; `npm run bridge:selfcheck`. |
| Developer Mode enabled on the iPhone | iOS 17+ refuses developer services otherwise. | Device → `DEV MODE` chip, read from the device. |
| Unlocked iPhone | Developer services refuse while locked; screenshots return the lock screen. | Manual step (`UNLOCKED · ?` stays “not checked” because it is not observable). |
| Internet access (optional) | Map tiles are streamed from the tile provider. | The Location workspace shows a tile-error notice if tiles fail. |
| "Sync with this iPhone over Wi-Fi" enabled once, on the cable | A USB pairing does **not** turn the wireless path on. | Settings → the six-step first-time wireless checklist; the Device workspace reports the Wi-Fi sync flag when the phone answers over the network entry. |
| Same subnet, and an access point that forwards multicast DNS | Discovery of a network iPhone uses outbound UDP 5353. | Device → wireless probe, which separates "no device answered" from "this PC could not ask". |
| A RemotePairing record made over USB (iOS 17.0–17.3 only) | Those versions open the developer tunnel only from that record; 17.4+ use the CoreDevice proxy. | The record files are **counted, never read**, and their contents never leave the bridge. |

## Capability matrix (as reported by the bridge)

| Capability | Status | Evidence |
| --- | --- | --- |
| USB iPhone discovery | `verified_hardware` | usbmuxd reported the attached iPhone17,1 over USB. |
| Model, iOS version and build | `verified_hardware` | lockdownd reported `iPhone17,1`, `27.0.1`, `24A446`. |
| Pairing state detection | `verified_hardware` | The existing pairing record was accepted (`paired=true`, `trusted=true`). |
| Starting a new pairing (Trust prompt) | `documented` | Implemented with the upstream autopair flow; not exercised because the test device is already paired. |
| Developer Mode detection | `verified_hardware` | Reported `true` by the test device. |
| No-admin developer tunnel (iOS 17+) | `verified_hardware` | Tunnel established from a non-elevated process; DVT service port advertised. |
| Set a fixed simulated location | `verified_hardware` | Call acknowledged; Google Maps on the device showed the simulated position. |
| Stop and restore real GPS | `verified_hardware` | `deviceCleared=true`, `locationOverrideActive=false`. |
| Route playback | `verified_hardware` | 130 updates, 636.4 m, 25.55 s elapsed vs 25.46 s estimated at 25 m/s. |
| Pause / resume a running route | `verified_hardware` | Publishing frozen at 31 updates for 3 s, then resumed to completion. |
| Movement speed control | `verified_hardware` | Pace error 0.09 s over a 25.46 s route. |
| Altitude override | `unsupported` | The DVT selector takes latitude and longitude only. |
| Device screenshot | `verified_hardware` | Captured from the device, including Maps at the simulated position. A locked phone returns the lock screen. |
| iOS 16 and older simulation path | `documented` | Implemented against `com.apple.dt.simulatelocation`; not hardware-tested. |
| Wi-Fi iPhone discovery | `documented` | usbmuxd exposes devices with connection type `Network` and this bridge separates them from USB entries in every scan and probe. No wireless-capable iPhone was attached while this build was verified, so no network entry was observed from this PC. |
| Model and iOS version over Wi-Fi | `documented` | Lockdown requests pin the usbmux connection type, so an identity read this way can only come from the network entry. The same queries were verified over USB. Read-only. |
| Wireless discovery diagnostics (multicast DNS) | `documented` | The bridge probes outbound mDNS and reports per-interface failures, so "no answers" and "this PC cannot ask" are told apart. Firewalls, VPN adapters and client-isolated guest networks block UDP 5353. |
| Developer tunnel over Wi-Fi (iOS 17+) | `unknown` | The userspace tunnel is opened from the usbmuxd entry it is given, and a network entry routes that pipe over Wi-Fi — but this codebase has not established one without a cable. The app refuses to call a session wireless while the cable is attached, because usbmuxd prefers the USB entry and the result would prove nothing about Wi-Fi. |
| Location simulation over Wi-Fi | `unknown` | Simulation needs the DVT developer service, which is only reachable through the tunnel above. Nothing here has been exercised on a wireless device. Wireless simulation is offered only after a readiness check reaches the developer service over the wireless endpoint; until then the control stays disabled and the state stays unknown. |
| RemoteServiceDiscovery directly over the LAN | `unknown` | The bridge can complete the RSD handshake at an address the phone advertised and reads only the identity that handshake returned. No DVT location command has ever been sent over such a session from this codebase. Needs iOS 17+, a private network, and a RemotePairing record made once over USB. |

The full 20-row matrix, with each row's evidence text, is generated by the bridge at
runtime and shown in **Device → Capability matrix** — this table is the summary, the UI
is the authority.

## Wireless transports

`wireless.probe` measures three transports independently and the UI paints one row per
transport with exactly the mark the bridge returned:

| Transport id | What it is | Connectable? |
| --- | --- | --- |
| `usb` | The cable, through usbmuxd. | Yes — the verified path. |
| `wifi-mux` | A network-attached iPhone reached through the same usbmuxd pipe. | Yes, in code. Never observed with a device attached. |
| `rsd-lan` | RemoteServiceDiscovery answered directly at a LAN address the phone advertised. | Yes, in code, for identity reads only. No location command has been sent over it. |
| `wifi-lockdown` | A lockdown-visible Wi-Fi entry seen during a scan but not offering a developer path. | No — reported as *seen only*, never as reachable. |

A device that was merely advertised is listed as seen, gets no Connect button, and can
never be selected for a session. `wireless.connect` validates the transport against the
allowlist above before any device call and answers `INVALID_PARAMS` for anything else —
the renderer names a transport from a fixed list and never supplies a host, a port or a
command.

## Deliberately not done

| Not supported | Reason |
| --- | --- |
| Installing drivers, TUN/TAP adapters or profiles | Requires administrator rights and would change the machine's security posture. The userspace tunnel makes it unnecessary. |
| Enabling Developer Mode for you | It is a security setting that only the device owner can change, on the phone, with a device restart. |
| Spoofing altitude, speed or motion sensors | The developer channel exposes neither. Speed is produced by host-side pacing of coordinates. |
| Spoofing on a device you did not select | Every device call carries the UDID the user selected, and the bridge refuses a session for a different device. |
