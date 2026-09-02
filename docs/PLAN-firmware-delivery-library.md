---
title: Plan of Attack - extract the firmware delivery half nobody ships
scope: implementation plan, written 2026-09-02 - the server, the release toolchain, the
  out-of-band command channel and the USB rescue path. Explicitly NOT another OTA
  client; the survey found that half is well covered and better than ours.
status: PLANNED - nothing built, and scoped down from the first sketch. Phase 0 is a
  spike that decides whether the device-side updater is deleted in favour of an existing
  library; nothing downstream should be written before that answer. Weakest reuse case
  of the three extraction plans - read "Is this worth doing at all" before starting.
---

# Plan: the half of OTA that nobody packages

One sentence of scope:

> Everything around the firmware update except the update itself - serving a manifest
> from a directory, cutting a release, telling a device to check *now* when the server
> cannot push, and flashing over USB when OTA structurally cannot help.

## Context: what the survey found, and a correction

An earlier note in this conversation claimed the existing OTA libraries "assume a cloud
HTTP server". **That was wrong, and the plan is scoped down accordingly.**

**[esp32FOTA](https://github.com/chrisjoyce911/esp32FOTA)** is server-agnostic: it fetches
a JSON manifest from any URL, compares semantic versions via `semver.c`, matches firmware
by type, and installs. It also has **RSA signature verification and gzip-compressed
images, neither of which this firmware has.** On the device side it is strictly ahead of
`checkForFirmwareUpdate()`.

**HTTPUpdate** ships inside the ESP32 Arduino core - no install at all. Pull an image from
a URL, reboot into it, and on failure keep running the current firmware. The ESP32's dual
OTA partitions give rollback at the hardware level regardless of which library writes.

**Push-model tools** - ArduinoOTA, `espota`, ElegantOTA - are a different shape: your
laptop pushes to a device on the same LAN. Fine for the bench, not for a box that has
left it.

**Fleet platforms** - hawkBit and Mender self-hosted, Golioth and Memfault managed - are
the correct answer above roughly ten devices and enormous overkill below it.

**So the device half is covered, and covered better.** What is *not* covered by any of
them:

1. **The server.** Every one of these says "host a JSON manifest and a binary" and stops.
   You write the endpoint, the directory convention, and the version comparison yourself.
   `api/src/firmware.ts` is that, already written and already tested.

   *Second-pass check, and it softens this point.* There is an
   [`esp-ota`](https://www.npmjs.com/package/esp-ota) on npm, but it is the push model -
   it uploads to a device via ArduinoOTA, so it does not fill this hole. What does exist
   is a scattering of GitHub *projects* named some variant of "esp32-ota-server"
   ([one](https://github.com/Otorexer/ESP32-OTA-Server),
   [two](https://github.com/OscarHedeby/esp32-ota-server),
   [three](https://github.com/nickdex/Esp-OTA)), each an Express app someone wrote for
   themselves. So the claim "nobody packages this" holds literally - none is an
   installable dependency - but the weaker reading is also true: **this is a wheel many
   people have already reinvented, and copying one of theirs is a legitimate alternative
   to publishing yours.** Fold that into the verdict below.
2. **Telling a device to check now, when the server cannot initiate.** The protocol here
   has no server-initiated message, so a command is not sent - it is *left out to be
   collected* on the device's own heartbeat. `api/src/deviceCommands.ts`.
3. **The USB rescue path.** OTA needs working firmware to receive an update, so a bad
   build is exactly the case OTA cannot fix. `flash-device.ps1` goes in through the ROM
   bootloader from the Pi.
4. **Two hard-won scheduling facts** that are worth more than the code around them:
   - **A boot-time update check structurally cannot succeed when both halves power on
     together.** Measured here: the Pi needs 36.6s (5.2s kernel + 31.4s userspace) before
     its API accepts anything, while the device starts asking ~3.5s in and gives up at the
     25s Wi-Fi timeout, around 30s. It loses by about ten seconds, *every time, by
     construction*. Updates in this project appeared to work only because the XIAO was
     being reset by itself against an already-running Pi. The fix is a deliberately early
     first re-check (2 minutes), separate from the steady interval (30 minutes).
   - **The result of a boot-time check is invisible.** On the S3's native USB CDC,
     anything printed while no host is attached is discarded, so the OTA log is lost every
     time. Holding the outcome in `lastOtaResult` and printing it once a host provably
     attaches is the difference between a diagnosable failure and silence.

## Is this worth doing at all

State the case honestly before spending a weekend on it.

**Against.** This is the most topology-bound of the three extraction candidates. It
assumes a companion SBC that both serves firmware and has USB to the MCU, a Windows dev
machine driving PowerShell, and a device that reports its version over a side channel.
Change any one and parts stop applying. It is also three artifacts with three different
distribution mechanisms, not one library.

**For.** That topology - MCU plus a Linux SBC a metre away - is extremely common in this
kind of build, and it is precisely the case the fleet platforms are too heavy for and the
push tools are too manual for. The two scheduling facts above are the sort of thing people
rediscover one painful release at a time.

**Verdict: do the server package, treat the rest as a documented template.** The npm
package is genuinely reusable; the PowerShell scripts are worth publishing as a template
repo to copy from, not as a dependency to install. Do not pretend otherwise.

## What this ships

Three things, deliberately not one:

**1. `firmware-drop` (npm).** A directory is the source of truth. Scan it, parse versions
out of filenames, serve a manifest and the binary. This is `firmware.ts` generalised - the
filename pattern becomes configurable instead of hardcoding `smarttoolbox-`. Two
behaviours to carry over verbatim, both of them the result of thinking about failure:

- **Files that do not match the pattern are skipped, not rejected.** The drop folder is a
  working directory; a stray README or a half-copied file must not take the endpoint down.
- **An unparseable reported version is treated as older than everything**, so a device
  reporting garbage still gets offered an update rather than being stranded on the very
  firmware that broke its version string.

**2. A device-side scheduler (Arduino), sitting on top of an existing updater.** Not an
updater. It owns *when* to check and *how to report*, and delegates the download and write
to HTTPUpdate or esp32FOTA: the first-check-at-2-minutes rule, the 30-minute steady
interval, "only while idle" so a check never lands mid-request, deferred result reporting,
and handling a collected `check-firmware` command.

**3. A release-toolchain template (a repo to copy).** `release-firmware.ps1`,
`flash-device.ps1`, `push-to-device.ps1`. PowerShell has no meaningful package story for
this, and these are path- and host-specific by nature. Publishing them as a template with
the reasoning intact is the honest form.

## The command queue

Small enough to quote the whole design, and the most portable idea here.

When the server cannot initiate, a command is not delivered - it is *queued for
collection* on the peer's next heartbeat. From `deviceCommands.ts`:

- **In memory, not in the database, deliberately.** A command is an instruction about
  *now*. One that survived a service restart to fire hours later against a device that has
  moved on would be a surprise, not a feature.
- **A TTL** - five minutes here. Long enough to cover a device that is mid-update or
  rebooting, short enough that a command queued against an unplugged box does not fire
  when it reappears tomorrow.
- **Collected exactly once.** The device acts on collection and cannot acknowledge
  separately, because there is no server-initiated retry to build on. Leaving it queued
  would re-run it every heartbeat until expiry - and a reboot loop is a worse failure than
  a command that did not land. The retry for one that did not land is queueing it again.
- **A slot, not a queue.** One pending command replaces the previous one. Worth revisiting
  in the library, but the single slot has never been the limitation here.

This is 61 lines against 89 lines of test. It goes in `firmware-drop` rather than standing
alone - it is meaningless without something to command.

## Phases

### Phase 0 - the spike that decides the rest

**Replace `checkForFirmwareUpdate()`'s download-and-write with HTTPUpdate, on real
hardware, before writing anything else.** The function is ~170 lines, most of it Wi-Fi
association diagnostics rather than updating.

Two possible answers, and they lead to different libraries:

- *It works.* Then artifact 2 shrinks to a scheduler and a reporter, the plan gets much
  smaller, and this project gains signature verification and rollback maturity for free.
- *It does not* - because of the Wi-Fi re-association behaviour, the scan-first
  diagnostics, or something in the manifest shape. Then write down exactly why, because
  that reason is the library's entire justification.

Keep the Wi-Fi diagnostics either way. The scan-before-connect and the re-issued `begin()`
solve real failures (an SSID that is 5 GHz, out of range, or misspelled looks identical
from the status code; an association stalled in `WL_IDLE_STATUS` never recovers on its
own) and no OTA library does that for you.

### Phase 1 - extract the server package

`firmware.ts` and `deviceCommands.ts` out to their own repo as `firmware-drop`. Make the
filename pattern and the TTL configuration. Ship the manifest route as a framework-free
handler plus a thin Bun/Express adapter, since the routing here is a deliberate hand-rolled
`if` chain and should not become someone else's framework dependency.

Both modules already carry near 1:1 tests, which is why this phase is the safe one.

### Phase 2 - the device-side scheduler

Whatever Phase 0 leaves. Depends on HTTPUpdate or esp32FOTA rather than reimplementing
them.

### Phase 3 - the template repo

Scripts, plus a README that states the assumed topology in the first paragraph so someone
with a different one stops reading immediately.

### Phase 4 - publish

npm for `firmware-drop`; Arduino Library Manager for the scheduler if Phase 0 leaves
enough to be worth a library. **If Phase 0 concludes the scheduler is thirty lines, do not
publish it** - write it up as a README section in the template instead. A library that
exists to justify a plan is worse than a documented pattern.

## Known constraints

- **The topology is the dependency.** Companion SBC serving firmware, USB between them,
  version reported over a side channel. Say it in the README's first paragraph.
- **No signature verification today.** Anything on the LAN that answers the manifest URL
  can hand this device a binary. Acceptable for a workshop toolbox, not something to
  publish silently - either adopt esp32FOTA's RSA path or state the threat model plainly.
- **PowerShell and Windows** for the release scripts; the Pi side is `bash`. A
  cross-platform rewrite is a separate decision, not a prerequisite.
- **The Pi never compiles.** Verified: `release-firmware.ps1` builds on Windows and
  `flash-device.ps1` scps a prebuilt `.merged.bin`. Any tooling change must preserve that.

## Open questions

1. **Does `firmware-drop` serve, or just resolve?** A resolver (given a directory and a
   reported version, return what to send) is smaller, easier to test, and framework-free.
   Serving drags in HTTP opinions. Suggest resolver as the core with an optional adapter.
2. **Should the manifest match esp32FOTA's existing schema** (`type`, `version`, `host`,
   `port`, `bin`)? If Phase 0 adopts esp32FOTA, matching its schema means the device needs
   no custom parsing at all - which is most of the argument for adopting it in the first
   place.
3. **Does the command channel belong here or in the serial RPC library?** It rides the
   serial heartbeat but it is about device management, not transport. Keep it here; the
   transport should stay ignorant of what its messages mean.
