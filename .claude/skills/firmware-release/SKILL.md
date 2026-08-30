---
name: firmware-release
description: Get a firmware build onto the XIAO - version and publish it for OTA with release-firmware.ps1, make the device fetch it now with push-to-device.ps1, or flash it over USB with flash-device.ps1 when OTA structurally cannot help. Use when releasing firmware, bumping FIRMWARE_VERSION, pushing a build to the device, testing an OTA update end to end, or recovering a device that went silent after a flash.
allowed-tools: [Read, Glob, Grep, Bash, Edit]
---

# Getting firmware onto the device

Two paths exist and both earn their place. OTA over Wi-Fi is the convenient one; USB
from the Pi is the one that works when the convenient one cannot.

## Pick the path first

| Situation | Command |
|---|---|
| Routine release, device is healthy and reporting | `release-firmware.ps1 -Version x.y.z -Push -Now` |
| Build you do not trust, or one that touched `setup()` / the serial link | Release it, then `flash-device.ps1 -Version x.y.z -Upload` |
| Device has gone silent - no heartbeat, stale `uptimeMs` | `flash-device.ps1 -Version <last known good>` |
| Build already published, just want it collected now | `push-to-device.ps1 check-firmware` |

**Why USB is not optional as a fallback.** An application-level update needs working
firmware to receive it. A build that crashes in `setup()`, wedges the loop, or breaks
the serial link cannot be replaced over the air - the thing that would accept the next
update is the thing that is broken. `flash-device.ps1` talks to the ROM bootloader,
which runs before the application and does not care that it is broken.

## Releasing for OTA

```powershell
cd api\scripts
.\release-firmware.ps1 -Version 0.23.0 -Push -Now
```

- `-Push` is what makes it visible to a device; without it the release is local only.
- `-Now` queues a `check-firmware` command so the device collects it within one
  heartbeat instead of waiting up to 30 minutes. It does nothing without `-Push`.
- `-Force` overwrites a version already in the drop folder. It refuses otherwise, and
  warns if a *newer* image is already there, since devices would keep pulling that one.

The script owns both the `#define FIRMWARE_VERSION "x.y.z"` line in the sketch and the
name of the built file, because the device decides whether to update by comparing them.
**Do not hand-edit that line and do not reformat it** - its exact shape is the anchor
the script rewrites.

It publishes two files: `smarttoolbox-<version>.bin` (the app binary, what OTA serves)
and `smarttoolbox-<version>.merged.bin` (the full 8 MB image, the only thing USB
flashing can use). Both go up under a `.tmp` name and are renamed, because the OTA
endpoint scans the drop folder by name and a half-copied image advertised with an
honest Content-Length is worse than no image.

**Bump the version for every build that goes to the device.** The device compares
versions; reflashing the same number is legitimate over USB but invisible over OTA.

## Making the device collect it

The Pi cannot push. The serial protocol has no Pi-initiated message type - the device
speaks first, always - so a command is left waiting and collected on the next heartbeat:
every 30s while running, every 2s while still waiting for the Pi at boot.

```powershell
.\push-to-device.ps1 check-firmware    # or: reboot
.\push-to-device.ps1 check-firmware -NoWait
```

Nothing here is instant, and `-WaitSeconds` under about 45 gives a false negative on a
perfectly healthy device. There is no `device/ota-reset` command; an early draft of the
spec named one and it was never built.

## Flashing over USB (the recovery path)

```powershell
.\flash-device.ps1 -List                       # what the Pi can flash
.\flash-device.ps1 -Version 0.21.1             # from the Pi's drop folder
.\flash-device.ps1 -Version 0.23.0 -Upload     # push a local build that was never released
```

`-Upload` reads the merged image out of `$env:TEMP\smarttoolbox-build-<version>\`, so
the version must have been built locally with `release-firmware.ps1` first.

Roughly 48s wall clock. It stops `smarttoolbox.service` to free the port and restarts it
from a trap, so a failed flash still leaves the API, dashboard and serial link up.

Traps this path already knows about, all recorded in `docs/PLAN-usb-flashing.md`:

- **Flash the merged image, never the app binary.** The board is `default_8MB` with two
  app slots. Writing the app binary to `app0` while `otadata` points at `app1` reports
  complete success and changes nothing. Writing it at `0x0` overwrites the bootloader
  and creates the brick you were repairing. `flash-device.sh` refuses anything under 2 MB.
- **`--no-stub` is mandatory on the Pi and fails late.** Debian's `esptool` is
  `4.7.0+dfsg` with the stub blobs stripped, so the command connects, resets the chip,
  identifies it, and only then dies on a missing `stub_flasher_32s3.json`.
- **The binary is `/usr/bin/esptool`**, not on a non-interactive SSH shell's PATH.
- **The port re-enumerates mid-flash** - the USB device is provided by the chip being
  reprogrammed.

## Confirming it actually worked

Watch `uptimeMs`, not the version. Flashing the same version the device is already
running is a legitimate thing to do - it is what you do when you suspect the flash
itself - and the version alone cannot tell that apart from nothing having happened. A
fresh uptime can. Both scripts already check this; when doing it by hand:

```powershell
Invoke-RestMethod http://192.168.50.30:3000/api/devices
```

## Testing an OTA update end to end

1. Note the version the device reports now.
2. `.\release-firmware.ps1 -Version <higher> -Push`
3. Reset the board with the RTS pulse in the firmware instructions - **not** by
   reflashing, which would install the build directly and prove nothing.
4. Watch for `OTA GET ... -> 200`, `OTA writing N bytes`, `OTA wrote N` (counts must
   match), then `rst:0xc`.
5. Confirm the next boot reports the new version and gets `-> 204`. Step 5 is the proof;
   3 and 4 only show that bytes moved.

**A whole-box cold start always loses this race by construction.** The Pi needs ~36.6s
to reach a listening API; the device asks at ~3.5s and gives up at ~30s. It presents as
`Update failed` with a **negative** number on the OLED - `HTTPClient` error codes are
negative, so below zero means "never reached the server", `401` is the device key, and
`204` is genuinely up to date. Read the sign before anything else. Since 0.16.0 the
device re-checks two minutes after boot and every thirty minutes, so it recovers on its
own. Test deliberately by resetting the XIAO alone against a running Pi.

## Before you commit

Bump the status tags in the same commit - see the `spec-status` skill. If the release
changed hardware behaviour, `.github/instructions/xiao-esp32s3-firmware.instructions.md`
is where the trap belongs, not a comment in the sketch.
