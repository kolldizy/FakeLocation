# Compatibility matrix

Everything in this file is either **verified on hardware from this codebase**, **documented
from the upstream API but not hardware-tested here**, **unknown**, or **unsupported**.

Status vocabulary (the same one the app shows in Device Center):

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

## iOS version support

| iOS version | Transport | Status |
| --- | --- | --- |
| 17 and newer | Userspace RSD tunnel → DVT `LocationSimulation` (`simulateLocationWithLatitude:longitude:`). | `verified_hardware` on 27.0.1 |
| 16 and older | lockdown `com.apple.dt.simulatelocation` (`DtSimulateLocation`). | `documented` — no compatible device was available, so this path has never been executed against hardware. Writes on this path are fire-and-forget, so the bridge reports results with `deviceAcknowledged: false` and never labels them hardware-confirmed. |

The transport is chosen from the iOS version the device reports; it is not selected manually.

## Host requirements

| Requirement | Why | Status check in the app |
| --- | --- | --- |
| Apple Mobile Device Support (Microsoft Store app “Apple Devices”, or iTunes) | Provides `usbmuxd` and the USB filter drivers that expose an iPhone to non-Apple software. | Device Center → bridge health → `usbmuxd`, and the five-step setup checklist. |
| Python 3.11+ with `pymobiledevice3==11.35.0` and `defusedxml==0.7.1` | The device bridge. | Bridge chip in the left rail; `npm run bridge:selfcheck`. |
| Developer Mode enabled on the iPhone | iOS 17+ refuses developer services otherwise. | Device Center → `DEV MODE` chip, read from the device. |
| Unlocked iPhone | Developer services refuse while locked; screenshots return the lock screen. | Manual step (`UNLOCKED · ?` stays “not checked” because it is not observable). |
| Internet access (optional) | Map tiles are streamed from the tile provider. | Map Studio shows a tile-error notice if tiles fail. |

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
| Simulation over Wi-Fi | `unknown` | The tunnel targets a USB-attached device; network-attached devices are listed but simulation is not offered. |

## Deliberately not done

| Not supported | Reason |
| --- | --- |
| Installing drivers, TUN/TAP adapters or profiles | Requires administrator rights and would change the machine's security posture. The userspace tunnel makes it unnecessary. |
| Enabling Developer Mode for you | It is a security setting that only the device owner can change, on the phone, with a device restart. |
| Spoofing altitude, speed or motion sensors | The developer channel exposes neither. Speed is produced by host-side pacing of coordinates. |
| Spoofing on a device you did not select | Every device call carries the UDID the user selected, and the bridge refuses a session for a different device. |
