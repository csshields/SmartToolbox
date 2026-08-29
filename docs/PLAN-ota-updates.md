---
title: Plan of Attack - Wireless (OTA) Firmware Updates
scope: implementation plan, written 2026-08-27
status: complete - revised 2026-08-28, see the boot-race note below
---

> **Done 2026-08-27.** The device pulled `smarttoolbox-0.4.0.bin` (1,046,256 bytes)
> from the Pi over Wi-Fi, verified it, rebooted into it, and reported the new version
> on its next check. The "pull from the Pi" option below is what was built.
>
> One thing the plan did not anticipate: the XIAO cannot use Wi-Fi at all without its
> external antenna attached. Without it the radio sees the network at roughly -85 dBm
> and never completes an association, while reporting a status code that looks like a
> credentials problem. That cost more time than the OTA code itself.
>
> Not tested: recovery from a transfer interrupted mid-write. The dual-partition
> mechanism makes it safe in principle, but the path was never deliberately exercised.
>
> **2026-08-28 - the boot check cannot win a cold start, and never could.** Three
> releases (0.12.0 through 0.14.0) went by without the device taking any of them, and
> the reason turned out to be structural rather than a bug in this plan's code. The
> check ran only in `setup()`, and on a whole-box power-on it runs far too early:
>
> | | time from power-on |
> |---|---|
> | Pi finishes booting (5.2s kernel + 31.4s userspace) | **36.6s**, before the API accepts anything |
> | XIAO starts asking | ~3.5s |
> | XIAO gives up (25s Wi-Fi timeout) | **~30s** |
>
> The device gives up roughly ten seconds before the server it is asking exists. The
> earlier successes were not luck: the XIAO was being reset *by itself* against a Pi
> that had been running for some time, which is the only condition under which the
> boot check can work at all. It presents as `Update failed` with a **negative**
> status, because `HTTPClient` returns its own error codes rather than an HTTP one -
> so the number on the screen is the diagnosis, and its sign is the important part.
>
> Fixed in 0.16.0 two ways: the check now also runs on a timer while the device is
> up - two minutes after boot, then every thirty minutes, and only while idle - and
> the outcome of the last check is held and printed once the serial link is proven.
> That second half matters more than it sounds: the boot check runs before the Pi has
> the port open, and the S3's native USB CDC discards anything written while no host
> is attached, so **the entire boot-time OTA log had been going into a void**. Every
> attempt to debug this from the Pi's journal was reading a log that structurally
> could not contain the answer.

# Plan: OTA Firmware Updates for the XIAO

## Why

Right now, updating the XIAO means walking to it with a USB cable and running
`arduino-cli upload`. That's fine occasionally, but Feature 2 (touch-triggered lookup,
see `docs/PLAN-next-features.md`) means reflashing the firmware repeatedly while
debugging. OTA removes that friction.

## The real decision: this turns Wi-Fi on

Every other feature in this project works within the existing design: wired USB
serial only, Wi-Fi and BLE present on the chip but deliberately unused. OTA breaks
that pattern - it requires the XIAO to join your Wi-Fi network. That's a bigger
architectural step than anything else currently planned, not just a feature to bolt on.

Two ways to structure it:

| | Push from dev machine (ArduinoOTA) | Pull from the Pi (HTTP OTA) |
|---|---|---|
| How it works | Arduino IDE finds the XIAO over mDNS on your LAN, pushes the compiled binary directly | XIAO periodically asks the Pi "is there a newer version?" and downloads it if so |
| Fits existing design? | No - new trust relationship between your dev machine and the device | Yes - the Pi is already the XIAO's only trusted peer |
| Needs the Pi running? | No | Yes |
| Extra work | Minimal - it's a standard Arduino library | Needs a small endpoint on the Pi and a place to drop the `.bin` file |

**Recommendation: pull from the Pi.** It reuses the trust relationship that already
exists (XIAO already trusts the Pi for everything else) instead of creating a new one
between the XIAO and your laptop. It also means updates work the same way whether
you're compiling on this Windows machine or eventually from somewhere else.

## Security: this needs more than the MVP's "trusted LAN" answer

The spec's authentication decision (`.github/copilot-instructions.md` >
Authentication & Authorization) is "no auth, trusted home LAN" - fine for tool lookups,
not fine for something that can overwrite the firmware. Anyone who can reach the Pi's
OTA endpoint can brick or reflash the device. Minimum bar: a shared secret token the
XIAO sends with its update check, stored in `arduino_secrets.h` (already scaffolded but
empty - `SECRET_DEVICE_KEY`) and checked by the Pi before serving a binary.

One thing working in our favor: the ESP32-S3 has two OTA partitions built in. A bad
flash doesn't have to mean a bricked device - the standard `Update` library pattern
only marks the new partition as bootable after it verifies the write, so a corrupted
transfer just fails and stays on the old firmware.

## Design

```
XIAO (on boot, or on a timer)
  -> GET /api/firmware/latest?currentVersion=0.1.0   [+ device key]
Pi
  -> 204 No Content                 if currentVersion is already latest
  -> 200 + firmware.bin              if newer, streamed as the response body
XIAO
  -> writes the stream to the inactive OTA partition (ESP32 Update library)
  -> verifies, marks it bootable, reboots
```

### Pi side — **built 2026-08-27**

- ~~`api/deploy/firmware/`~~ → **`<cwd>/firmware/`** (`~/smarttoolbox/firmware/` on the
  Pi). Changed from the original plan: `sync.ps1` copies only `src`, `public`,
  `scripts`, and the config files, so nothing under `deploy/` ever reaches the Pi.
  The new location mirrors `data/` and `logs/`, and is gitignored - firmware images
  do not belong in the repo. Files are named `smarttoolbox-<major>.<minor>.<patch>.bin`;
  anything else in the folder is ignored rather than treated as an error.
- `GET /api/firmware/latest?currentVersion=X` - implemented in `api/src/index.ts`,
  with the version and file scanning logic in `api/src/firmware.ts` (unit tested in
  `firmware.test.ts`). Verified end to end against a running server: 401 for a missing
  or wrong key, 200 with byte-identical binary for an older reported version, 204 when
  already current or newer, 200 for an unparseable version (treated as out of date so a
  device cannot strand itself), and 503 when `DEVICE_KEY` is unset.
- Version comparison is numeric, not lexical - `0.10.0` correctly sorts above `0.9.0`.

- `api/scripts/release-firmware.ps1` - **built 2026-08-27.** Stamps
  `#define FIRMWARE_VERSION` into the sketch, compiles, drops the binary as
  `smarttoolbox-<version>.bin`, and with `-Push` scps it to the Pi using the same
  deploy key as `sync.ps1`. It owns both the stamped version and the file name so
  they cannot drift apart. Verified: 0.3.0 built and pushed, sha256 identical on
  both ends.

Still to build: the whole firmware side below. Note the endpoint is committed but not
yet deployed - `/api/firmware/latest` returns 404 on the Pi until the next `sync.ps1`,
and 503 after that until `DEVICE_KEY` is set in the systemd unit.
- Add `api/scripts/` helper (the directory already exists, currently empty) to bump
  the version and copy a freshly compiled `.bin` into place - this replaces the manual
  `arduino-cli upload` step for iteration.

### Firmware side (new)

- Fill in `firmware/arduino_secrets.h`: `SECRET_SSID`, `SECRET_OPTIONAL_PASS` (Wi-Fi),
  `SECRET_DEVICE_KEY` (OTA auth). This file is already gitignored-adjacent scaffolding
  from earlier - confirm it's actually in `.gitignore` before putting real credentials
  in it.
- `WiFi.begin(SECRET_SSID, SECRET_OPTIONAL_PASS)` at boot, alongside (not instead of)
  the existing USB serial connection to the Pi. USB serial stays the primary link for
  normal operation; Wi-Fi is OTA-only.
- Use the ESP32 `Update` library against `HTTPClient`/`WiFiClientSecure` to stream the
  response body from `/api/firmware/latest` into the inactive partition.
- Check on boot, not continuously - checking on every boot is enough for a device that
  gets power-cycled during development anyway, and avoids keeping the radio on.

## Open questions to settle before starting

- Does the XIAO join the same Wi-Fi network the Pi and dev machine are on? (Almost
  certainly yes - just confirming the SSID before writing `arduino_secrets.h`.)
- Manual trigger (a button hold, or a serial command) vs. automatic check on every
  boot? Automatic is simpler to build first; a manual trigger can be added later.
- HTTPS for the OTA endpoint, or is plain HTTP acceptable on the home LAN like
  everything else in this project? Given the "trusted LAN" MVP stance elsewhere, plain
  HTTP + the device-key check is probably consistent - but flagging it since firmware
  is a more sensitive payload than a tool lookup.

## Where this fits against the other planned work

This is bigger than Features 1-4 in `docs/PLAN-next-features.md` - it's the first
thing that turns on Wi-Fi at all. Two reasonable orderings:

- **Do it after Feature 2** (touch-triggered lookup): Feature 2 is the actual reason
  OTA is worth the trouble right now (faster reflash-and-test loop). Building OTA
  before Feature 2 exists is optimizing a workflow you haven't started yet.
- **Do it in parallel if the firmware and Pi work are split between people**: the Pi
  side (endpoint, file drop folder) doesn't depend on Feature 2 at all and could be
  built independently.

Recommendation: finish Feature 2's first working version over USB, confirm the
touch-to-lookup flow works end to end, then add OTA once you know you're doing enough
reflash cycles for it to pay off.

## Done when

- A firmware version bump + `.bin` drop in `api/deploy/firmware/` is picked up by the
  XIAO on its next boot without a USB cable.
- An update with a wrong or missing device key is rejected by the Pi (404 or 401, not
  a silent 204).
- A corrupted or interrupted transfer leaves the XIAO running its previous firmware,
  not bricked.
- Spec updates: move "Implement over-the-air (OTA) firmware updates" out of Future
  Considerations in `.github/copilot-instructions.md`, add a Wi-Fi section describing
  that Wi-Fi is now used for OTA only (not general communication - USB serial is still
  the primary link), and add the OTA endpoint to the API Endpoints table.
