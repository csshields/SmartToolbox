---
title: Plan of Attack - Flashing the XIAO from the Pi, over the cable already there
scope: implementation plan, written 2026-08-29 - esptool over USB, and a way back from a brick
status: COMPLETE - all four steps done on hardware 2026-08-29. A deliberately bricked
  device, silent for three minutes, was recovered from Windows in 47s with nobody
  touching the box.
---

# Plan: the Pi flashes the device, over the wire it already talks on

One sentence of scope:

> Run one command and the XIAO is running the build you just compiled, without
> anybody walking to the box with a cable.

## Why, when Wi-Fi OTA already works

OTA works and is not being removed. This exists for the case OTA structurally cannot
cover.

**Application-level updates need working firmware to receive them.** That is true of the
Wi-Fi path today and would be equally true of any serial version of it. Ship a build that
crashes in `setup()`, wedges the loop, or breaks the serial link, and there is no way in -
the thing that would have accepted the next update is the thing that is broken. The
recovery is a person, a USB cable, and a trip to the box.

That was an acceptable risk when firmware went out occasionally. It is not the situation
any more: on 2026-08-29 alone, four builds went to the device, every one of them compiled
but not run beforehand. The odds of eventually shipping a brick are no longer small, and
the cost of one is a physical trip.

**The ROM bootloader is in silicon and always answers.** It does not care whether the
application is broken, because it runs before the application exists. That is the whole
argument: `esptool` talking to the ROM bootloader is the only update path that survives
its own bad output.

The second benefit is smaller but real. Every Wi-Fi problem this project has had goes
away on this path:

- The XIAO cannot use Wi-Fi **at all** without its external antenna - it sees the network
  at roughly -85 dBm and never associates, while reporting a status code that reads like
  a credentials problem. The OTA plan records that this cost more time than the OTA code.
- `WIFI_CONNECT_TIMEOUT_MS` blocks the loop for 25 seconds on failure. That is what
  created the cold-boot race, and why `startWaitingForPi()` had to move ahead of the
  update check.
- Credentials are compiled in through `arduino_secrets.h`.

None of that applies to a cable that is already carrying `/dev/ttyACM0`.

## Best practice, briefly

For an **untethered** ESP32, Wi-Fi OTA is correct and is what everybody does. This device
is not untethered: it draws power and data from the Pi over one cable and cannot work
without it. For an MCU permanently wired to a host computer, the host flashing it over
that wire is the ordinary pattern, not an exotic one.

So both paths earn their place. OTA is the convenient one; this is the one that works
when the convenient one cannot.

## Step 0 - can esptool talk to the chip at all?

**Everything below this line is provisional until this passes.** It is one command and it
decides whether the feature exists.

```bash
sudo apt-get install -y esptool           # not pip: PEP 668, see the findings below
sudo systemctl stop smarttoolbox          # frees /dev/ttyACM0
/usr/bin/esptool --port /dev/ttyACM0 --no-stub chip_id
sudo systemctl start smarttoolbox
```

**Done when:** it prints a chip type and MAC without anyone touching the board.

**The specific risk, and it is not small.** The XIAO ESP32S3 has no USB-to-UART bridge.
`/dev/ttyACM0` is the ESP32-S3's *own* USB peripheral, presented by the running sketch.
esptool's usual trick for entering download mode is toggling DTR and RTS, which works
through a bridge chip that has those lines wired to EN and IO0. Here there is no bridge.
The S3 supports a reset-to-bootloader over native USB, and esptool knows how to ask - but
that was a claim to test, not to design around. (It held. See the result below.)

**If it fails**, the likely fixes in order of preference:

1. `--before usb_reset` or `--before no_reset`, which are the S3-specific reset modes.
2. Queue the existing `reboot` device command first, and have esptool catch the chip in
   its boot window. Clumsy, but it uses machinery that already exists (0.21.0).
3. Wire the XIAO's BOOT and RESET pads to two Pi GPIOs. This turns a software problem into
   a soldering problem and always works, which is exactly what the recovery path wants -
   but it is a hardware change and belongs in its own decision, not smuggled in here.
4. Abandon it and keep Wi-Fi OTA. Recording this as a real outcome rather than a failure:
   the current state is not broken, it just has a gap.

**Do not skip to Step 1 on a partial result.** "esptool connected but only after I held
the button" is a different feature - it still needs a person at the box, which is the one
thing this plan exists to remove.

### It passed - 2026-08-29

```
esptool.py v4.7.0
Connecting...
Detecting chip type... ESP32-S3
Chip is ESP32-S3 (QFN56) (revision v0.2)
Features: WiFi, BLE, Embedded PSRAM 8MB (AP_3v3)
MAC: e8:f6:0a:8a:0d:64
Hard resetting via RTS pin...
```

Exit 0, nobody near the board. **The risk this step was written around did not
materialise**: esptool resets the S3 into download mode over native USB unaided, and the
absence of a bridge chip turned out not to matter. It even reports resetting "via RTS
pin" afterwards, so the native-USB path covers both directions of the reset.

Two things the experiment found that the plan did not anticipate:

**1. Debian's esptool has no stub flashers, and `--no-stub` is mandatory.** Install with
`sudo apt-get install esptool` (4.7.0) rather than pip - the Pi's Python is externally
managed under PEP 668, and `--break-system-packages` is not worth it for a tool apt
already has. But the package is `4.7.0+dfsg`, and the *dfsg* part matters: Debian strips
the precompiled stub flasher blobs as non-free. Without `--no-stub` every command dies
with:

```
FileNotFoundError: .../esptool/targets/stub_flasher/stub_flasher_32s3.json
```

That reads like a corrupt installation rather than a licensing decision, and would send
anyone looking in the wrong place entirely. **It is also diagnostic in a useful way:**
reaching `run_stub()` proves the connect and the download-mode reset already succeeded,
which is how this step was known to have passed before it was made to work.

The ROM loader is slower than the stub. Irrelevant for `chip_id`; it will matter for an
8 MB `write_flash`, and Step 1 should time it rather than assume.

**2. The binary is `/usr/bin/esptool`, not `esptool.py`,** and it is not on the PATH of a
non-interactive SSH shell. Scripts must use the absolute path; `ssh pi "esptool ..."`
fails with `No such file or directory` while the same command in an interactive session
works.

## Step 1 - flash the merged image, by hand

`arduino-cli` already writes `smarttoolbox.ino.merged.bin` beside the app binary: a full
8 MB flash image containing bootloader, partition table, otadata and application.

**Flash the merged image, not the app binary,** and the reason is specific. The board's
layout is `default_8MB`:

| partition | offset | size |
|---|---|---|
| nvs | 0x9000 | 0x5000 |
| otadata | 0xe000 | 0x2000 |
| app0 (ota_0) | 0x10000 | 0x330000 |
| app1 (ota_1) | 0x340000 | 0x330000 |
| spiffs | 0x670000 | 0x180000 |

There are two application slots, and after any OTA the device may be running from either
one. Writing the 1.06 MB app binary to `app0` while `otadata` still points at `app1`
would report complete success and change nothing - the device would boot the old image
out of the other slot, which is the most confusing possible failure. The merged image
writes `otadata` too, so the question does not arise.

The 8 MB size is not the cost it appears to be: it is mostly `0xFF` padding, and
`write_flash` compresses by default.

```bash
sudo systemctl stop smarttoolbox
/usr/bin/esptool --chip esp32s3 --port /dev/ttyACM0 --baud 460800 --no-stub \
  write_flash -z 0x0 smarttoolbox-<version>.merged.bin
sudo systemctl start smarttoolbox
```

**Done when:** the device reboots into the flashed version and `GET /api/devices` reports
it. Prove it with a version that **is not in the Pi's drop folder** - then OTA cannot be
the explanation, whichever direction the version moved.

### It worked - 2026-08-29

0.21.1 was built locally with `release-firmware.ps1 -Version 0.21.1` and deliberately
*not* pushed, so the Pi had never heard of it. After the flash the device reported it:

```
firmwareVersion: 0.21.1   bootCount: 8   uptimeMs: 5924
firmware: { latestVersion: 0.21.0, updateAvailable: false }
```

The device is now ahead of the newest thing OTA has, which is the cleanest possible proof
that the bytes came over the cable.

| | |
|---|---|
| image | 8,388,608 bytes, **735,919 compressed** |
| write | 25.9s at 2,596 kbit/s |
| wall clock | **51s**, including connect, erase and reset |
| verification | `Hash of data verified` |

**Both worries about this step were unfounded.** The 8 MB image is mostly `0xFF` padding
and compresses about 11:1, so it is not the transfer cost it looks like. And the
`--no-stub` ROM loader, flagged above as a thing to time rather than assume, runs at
~2.6 Mbit/s - perfectly usable. Fifty-one seconds is slower than an OTA pull, and it does
not matter for a path that exists for recovery rather than for routine releases.

It came back clean: `Mic ready=1`, promotion fired on the first heartbeat, and
`OTA last result: up to date at v0.21.1`.

## Step 2 - the scripts

`release-firmware.ps1` currently pushes only the app binary. It needs to push the merged
one as well, under `smarttoolbox-<version>.merged.bin`, and to keep publishing them
atomically the way it already does - upload to `.tmp`, then `mv`, because the drop folder
is scanned by name and a half-copied file advertised with an honest Content-Length is
worse than no file.

Two entry points, mirroring what exists:

- **`api/scripts/flash-device.ps1`** from Windows: SSHes to the Pi and drives the steps
  above. This is the sibling of `push-to-device.ps1`.
- **A Pi-side script** it calls, so the same thing can be run from an SSH session when
  the network path from Windows is the thing that is broken.

The stop/flash/start sequence must be **fault-tolerant about the restart**. If the flash
fails halfway, the service must still come back up - otherwise a failed flash also takes
out the API, the dashboard, and the serial link, and a person has to walk over anyway.
That means a trap/finally, not a linear script.

**Done when:** one command from Windows puts a named version on the device, and killing
it halfway still leaves `smarttoolbox.service` running.

### Built - 2026-08-29

- `api/scripts/flash-device.sh` on the Pi, `api/scripts/flash-device.ps1` from Windows.
  Both are synced by `sync.ps1`, which already copies `api/scripts/`.
- `release-firmware.ps1` now publishes `smarttoolbox-<version>.merged.bin` beside the app
  binary, with the same upload-then-rename it already used, so a known-good image is
  always on the Pi. A recovery is never the moment to be rebuilding one.
- `flash-device.ps1 -List` shows what the Pi can flash; `-Upload` pushes a locally built
  image for a version that was never released.

Proved end to end: released 0.21.2, listed it, flashed it, confirmed. 48s wall clock,
`Hash of data verified`, service back to `active`.

**Three things worth keeping.**

**The confirmation watches uptime, not the version.** Flashing the same version the device
is already running is a legitimate thing to do - it is what you do when you suspect the
flash itself - and the version alone cannot tell that apart from nothing having happened.
A fresh `uptimeMs` can.

**`.gitattributes` now pins `*.sh` to LF.** `core.autocrlf` is true on the Windows dev
machine, so a committed shell script would be checked out with CRLF and copied to the Pi
that way, where bash reports `$'
': command not found` on line one - which reads like a
corrupt file rather than a line-ending problem.

**esptool's progress output is thinned to one line in sixty.** It prints one
`Writing at 0x...` per block, about 600 of them, which buries the lines that actually say
something: the chip it found, the compressed size, whether the hash verified. `VERBOSE=1`
brings them back. The awk that does it deliberately avoids `match($0, re, arr)`, which is
a gawk extension that fails at parse time under mawk.

**A guard the plan did not ask for but should have.** `flash-device.sh` refuses any image
under 2 MB. Writing the 1 MB app binary at `0x0` would overwrite the bootloader with
application code and produce precisely the brick this script exists to repair - and it is
an easy mistake, because both files sit in the same folder with almost the same name.

## Step 3 - prove it recovers a brick

The step that justifies the whole plan, and the one most likely to be skipped.

Deliberately build and flash a broken firmware - an infinite loop in `setup()` before
`Serial.begin` is the honest version, since it kills the serial link and any hope of an
application-level update. Then recover it with Step 2's script.

**Done when:** a device that answers nothing at all is brought back to a working build by
a command typed from Windows, with nobody touching the box.

### It worked - 2026-08-29

`BRICK_TEST` was added to the sketch for this and left in at `0`. With it set, `setup()`
hangs on its **first line** - before `Serial.begin`, before the OLED, before the OTA
check. Every software update path this project has is gone at once: no serial, no
heartbeat, and `setup()` never reaches `checkForFirmwareUpdate()`, so Wi-Fi cannot help
either.

Built as 0.99.0 and deliberately never pushed to the drop folder, so no device could
reach it by accident.

**The brick, confirmed rather than assumed:**

```
flashed 22:01 -> last seen 22:01:17 -> checked 22:03:30
uptimeMs: 504064   (frozen; the value from before the flash)
version:  0.21.2   (stale - the chip was running 0.99.0 and could not say so)
```

Silent for over two minutes, which is four missed heartbeats, and not one `[serial]` line
in the log across the whole window.

**The recovery:** `flash-device.ps1 -Version 0.21.2`. Back at 22:04:45 on `bootCount 11`,
with `Mic ready=1`, promotion on the first heartbeat, and
`OTA last result: up to date at v0.21.2`. **47 seconds.**

**Why it worked, and the condition it depends on.** `/dev/ttyACM0` was still enumerated
throughout - checked during the brick, timestamped from just after the flash. This board
builds with `cdc_on_boot=1`, so the core starts the USB CDC stack *before* `setup()` runs,
and TinyUSB lives on its own FreeRTOS task that a spinning Arduino task cannot starve.

That is the load-bearing fact. **A build compiled with CDC-on-boot disabled could hang
before USB exists at all**, and then there is no port for esptool to open. This path is
verified against a device whose USB is brought up by the core, which is the default and
what every build here uses - but it is a dependency, not a law.

This plan is now complete, and the claim it was written to make is true: the Pi can
recover a device that nothing else can reach.

## Traps this plan already knows about

- **The serial listener holds the port.** `startSerialTransport` reconnects on an
  unlimited retry with a 5s ceiling, so it will fight esptool for `/dev/ttyACM0` unless
  the service is stopped. Stopping it is also what makes the flash observable: with the
  service down, esptool's own output is the only thing on the wire.
- **The port re-enumerates during flashing.** The USB device the Pi sees is provided by
  the chip being reprogrammed, so `/dev/ttyACM0` disappears and comes back. A script that
  assumes a stable device node across the whole operation will break. It may also come
  back as a different node if anything else ACM-shaped is attached.
- **`stty raw -echo` is reapplied on every connect** by `configureRawMode`, and the
  settings reset when the device re-enumerates. After a flash the service reconnects and
  handles this itself - but only if the service was restarted, which is another reason the
  restart cannot be best-effort.
- **A brick may not present as silence.** The failure this is built for could equally be a
  device that boots, connects, and behaves wrongly. Do not build the recovery path so it
  only triggers on "the Pi has not heard from the device" - it has to be runnable on
  demand, against a device that looks fine.
- **`--no-stub` is not optional on this Pi, and it fails late.** The command connects,
  resets the chip into download mode, identifies it, and only then dies on a missing file -
  so the error appears after everything that could plausibly go wrong has already gone
  right.
- **Do not diagnose the flash from the Pi's service log.** The service is stopped during
  it, by design. esptool's own stdout is the record, and the script should keep it.

## What this deliberately does not do

- **It does not remove Wi-Fi OTA.** That path works, it is the convenient one, and it
  costs nothing to keep. This is the path for when it cannot help.
- **It does not move normal releases onto USB.** OTA stays the default. Reach for this
  when OTA has failed, or when flashing something you do not trust.
- **It does not add BOOT/RESET GPIO wiring.** If Step 0 says that is the only way, that is
  a hardware decision to take deliberately, with the Open Hardware Question in the spec,
  and not a detail buried in an update script.
- **It does not touch the device command queue.** That is for asking a *working* device to
  do something. This is for one that cannot be asked.
