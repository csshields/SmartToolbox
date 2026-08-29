---
title: Plan of Attack - Flashing the XIAO from the Pi, over the cable already there
scope: implementation plan, written 2026-08-29 - esptool over USB, and a way back from a brick
status: not started - Step 0 is an experiment and everything after it is provisional
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
pip3 install esptool
sudo systemctl stop smarttoolbox          # frees /dev/ttyACM0
esptool.py --port /dev/ttyACM0 chip_id
sudo systemctl start smarttoolbox
```

**Done when:** it prints a chip type and MAC without anyone touching the board.

**The specific risk, and it is not small.** The XIAO ESP32S3 has no USB-to-UART bridge.
`/dev/ttyACM0` is the ESP32-S3's *own* USB peripheral, presented by the running sketch.
esptool's usual trick for entering download mode is toggling DTR and RTS, which works
through a bridge chip that has those lines wired to EN and IO0. Here there is no bridge.
The S3 supports a reset-to-bootloader over native USB, and esptool knows how to ask - but
that is a claim to test, not to design around.

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
esptool.py --chip esp32s3 --port /dev/ttyACM0 --baud 460800 \
  write_flash -z 0x0 smarttoolbox-<version>.merged.bin
sudo systemctl start smarttoolbox
```

**Done when:** the device reboots into the flashed version and `GET /api/devices` reports
it. Prove it by flashing a version *older* than the one running - an upgrade could be
explained by an OTA that happened to fire, a downgrade could not.

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

## Step 3 - prove it recovers a brick

The step that justifies the whole plan, and the one most likely to be skipped.

Deliberately build and flash a broken firmware - an infinite loop in `setup()` before
`Serial.begin` is the honest version, since it kills the serial link and any hope of an
application-level update. Then recover it with Step 2's script.

**Done when:** a device that answers nothing at all is brought back to a working build by
a command typed from Windows, with nobody touching the box.

If this cannot be made to work, say so in this document and keep the feature anyway for
the convenience case - but stop describing it as a recovery path, because it would not be
one.

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
