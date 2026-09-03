---
name: hardware-debug
description: Triage a SmartToolbox hardware failure - device silent, lookup times out, touch does not fire, OLED frozen, OTA reports a negative number, logs look empty. Use whenever "nothing happens" on the box, before reading firmware or serial code, because a wrong touch threshold, a frozen peripheral, a tty in the wrong mode and a missing antenna are indistinguishable from the outside.
allowed-tools: [Read, Glob, Grep, Bash, Edit]
---

# When nothing happens

Almost every failure in this project presents identically. Nearly every bug found here
was found by making the system observable, not by inspection - so run the check that
separates the causes before reading code.

Full detail lives in the Debugging & Testing section of
`.github/copilot-instructions.md` and in
`.github/instructions/xiao-esp32s3-firmware.instructions.md`.

**What is actually wired, and on which pin, is `docs/HARDWARE.md`** - the Bring-Up
Status table at the top of it answers "is this part even supposed to work yet" before
you spend an hour on a part that was never connected.

## Start here

```bash
tail -f ~/smarttoolbox/logs/service.log         # requests, responses, device debug
tail -f ~/smarttoolbox/logs/service-error.log   # serial errors only
```

`journalctl -u smarttoolbox` is **not** the log - the unit redirects both streams to
files, so the journal shows only systemd's start/stop lines and looks empty.
`service-error.log` has **no timestamps**: check `ls -l --time-style=full-iso` before
believing an error is current, or a stale `EACCES` from an earlier unplug will send you
after the wrong problem.

Then read the device's own account:

```powershell
Invoke-RestMethod http://192.168.50.30:3000/api/devices
```

A frozen `uptimeMs` across two reads means the device is not running, whatever version
it claims - the version is the last thing it managed to say, not what is on the chip.

## The device is completely silent

No heartbeat, `uptimeMs` frozen, no `[serial]` lines. Heartbeats are every 30s, so wait
two minutes before calling it silent.

If a firmware build went out just before it went quiet, that build is the suspect and
the recovery is USB: `.\flash-device.ps1 -Version <last known good>`. See the
`firmware-release` skill. This is proven against a real brick - a device that hung on
the first line of `setup()` came back in 47 seconds.

That path depends on `/dev/ttyACM0` still enumerating, which holds because this board
builds with `cdc_on_boot=1`: the core brings USB up before `setup()` runs, on a FreeRTOS
task a spinning Arduino task cannot starve. Check it is there before assuming the worst:

```bash
ls -l /dev/ttyACM*
```

## A lookup times out but the Pi log looks clean

The link fails one side at a time, and a half-open link looks healthy from the Pi.
`[serial] request id=req-N` followed by `[serial] response written id=req-N` only proves
the Pi's *write* succeeded. It says nothing about whether the XIAO received it.

```bash
sudo lsof /dev/ttyACM0        # want both an FD ending in r and one ending in w
stty -F /dev/ttyACM0 -a       # want raw mode: -echo, -icanon, -opost
```

A read FD with no write FD means responses are being dropped. `echo` being on means the
device is receiving its own transmissions back.

To prove the device's receive path independently of the touch hardware:

```bash
printf "lookup Claw Hammer\n" > /dev/ttyACM0
```

It is ignored while the firmware is mid-lookup or mid-blink, so send it a few times
spaced a few seconds apart before concluding the receive path is dead.

If you are on Windows: the API never starts the serial listener there, so a lookup sent
from the laptop always times out. That is correct, not a fault.

## Touch does not fire

The ESP32-S3 uses touch sensor v2 and readings go **up** on contact, the opposite of the
original ESP32. A threshold written as `value < baseline * 0.7` never fires and looks
exactly like a dead pad. Reference readings on D0 once calibrated: ~18,300 idle, ~31,400
touched.

Three ways this has already been broken here:

- The first ~10 `touchRead` calls after boot come back roughly 8x high while the
  peripheral settles. Averaging them into the baseline puts the threshold out of reach.
- Reading several pads back-to-back with no gap froze `touchRead` at a constant
  (2,513,860 on every call). Scan only the pads in use.
- GPIO5/GPIO6 are the I2C bus carrying the OLED. Touch-capable on paper; reading them
  fights the display. Usable pads are GPIO1-4 and GPIO7-9.

## Wi-Fi or OTA fails

**Check the antenna first.** The XIAO has no usable onboard antenna. Without the clip-on
one it sees networks at about -85 dBm and never associates, while `WiFi.status()` cycles
6 then sits at 0 - which reads like a credentials problem and is not one. This cost more
time than writing the OTA code did.

On the OLED, read the sign of the number before anything else: `HTTPClient` returns its
own negative error codes, so **negative means it never reached the server**, `401` is the
device key, `204` is genuinely up to date.

A whole-box cold start fails this check by construction every time - the Pi needs ~36.6s
to reach a listening API and the device gives up at ~30s. Since 0.16.0 it re-checks two
minutes after boot and every thirty minutes, so it recovers itself. To test deliberately,
reset the XIAO alone against an already-running Pi.

## Boot output never appears

The S3's USB CDC is not a UART. Anything printed while no host has the port open is
**discarded, not buffered**. The device starts printing ~3.5s after power-on and the Pi's
transport can still be in reconnect backoff, so boot output routinely never reaches the
log. This is not intermittent and not the Pi's fault - and it makes a working code path
look like a dead one. Anything that must be seen has to be printed after the link is
proven, which is what `reportLastOtaResult()` does. The OLED is the only witness to the
boot window itself.

## Something froze mid-operation

A blocking peripheral read blocks everything. `mic.readBytes()` for a whole 2-second clip
made hold-to-talk impossible and froze the animation on its first frame. Read in ~100ms
chunks and do other work between them. **A frozen indicator is worse than none**: it
asserts the device is busy while it may be dead, which is this project's most expensive
failure mode.

A full U8g2 `sendBuffer()` costs ~10ms over I2C - state changes only, never every loop.

## Reading the device directly from Windows

`arduino-cli monitor` exits immediately when its output is not a terminal, so it cannot
be captured to a file. Use PowerShell:

```powershell
$p = New-Object System.IO.Ports.SerialPort 'COM6',115200,'None',8,'One'
$p.DtrEnable = $true; $p.ReadTimeout = 500; $p.Open()
```

To reset the board without reflashing - which is what testing an OTA pull requires -
pulse RTS, not DTR. DTR alone does nothing. A successful reset prints
`rst:0x15 (USB_UART_CHIP_RESET)`; a self-restart after an OTA install prints `rst:0xc`.

## Before moving on

If the cause turned out to be a hardware trap rather than a logic bug, write it into
`.github/instructions/xiao-esp32s3-firmware.instructions.md`. That file is why most of
these checks exist, and it only stays useful if it keeps growing.
