---
name: XIAO ESP32S3 Firmware
applyTo: "firmware/**/*.ino"
description: "Firmware guidance for the Seeed XIAO ESP32S3, including onboard LED polarity, touch GPIOs, upload settings, and hardware constraints."
---

# XIAO ESP32S3 Firmware Guidance

- Target board: `esp32:esp32:XIAO_ESP32S3`.
- The installed ESP32 board definition maps `LED_BUILTIN` to GPIO21.
- The onboard orange/amber charge or power indicator is separate from the programmable orange user LED and is expected to remain on when its power or charging condition is active.
- The XIAO user LED is active-low: use `LOW` to turn it on and `HIGH` to turn it off.
- The Seeed pin map labels D0-D5 and D8-D10 as touch-capable exposed pads: GPIO1-9. GPIO0 is the Boot strapping pin and is not a touch input for this test.
- **GPIO5 (D4) and GPIO6 (D5) are the I2C bus** (`SDA`/`SCL` in the `XIAO_ESP32S3` variant) and carry the Grove OLED. They are touch-capable on paper, but do not map them as touch pads - reading them fights the display. The usable touch pads are GPIO1-4 and GPIO7-9.
- The `RST` and `BOOT` controls are physical buttons, not capacitive touch inputs. Touch sensing requires an exposed touch-capable GPIO pad, such as GPIO1 / D0, or a separately wired capacitive electrode.
- Seeed documents a factory touch-light program for the regular XIAO ESP32-S3: touching an exposed touch pad turns on the orange user indicator.
- Touch thresholds should be calibrated from startup samples instead of relying on a fixed raw value.
- **Touch readings rise when a pad is touched on this chip.** The ESP32-S3 uses touch sensor v2, where the raw value goes *up* on contact - the opposite of the original ESP32, where it falls toward zero. The core's own header is explicit: `touchRead` is documented as "for ESP32 values close to 0 mean touch detected / for ESP32-S2/S3 higher values mean touch detected" (`cores/esp32/esp32-hal-touch.h`). A threshold written as `value < baseline * 0.7` never fires here and presents as touch being silently dead. Compare against `value > baseline * ratio` instead.
- **Discard the first ~10 `touchRead` calls after boot.** They come back roughly 8x high while the peripheral settles. Averaging them into a startup baseline puts the threshold above anything a real touch can reach, which looks identical to a dead pad. Measured on D0: a baseline taken from the first reads landed at 239,519 against a true idle value of ~18,340.
- **Do not read several pads back-to-back with no gap.** Scanning all nine pads in a tight loop made `touchRead` return a frozen constant (2,513,860 on every call, never varying) instead of live data. Scan only the pads you actually use, or space the reads out.
- Reference readings on D0, once calibrated correctly: **~18,300 idle, ~31,400 while touched** - a ~70% rise, so a trigger ratio of 1.15x baseline has wide margin.
- `touchInterruptSetThresholdDirection()` does **not** exist on the S3 - the core guards it with `#if SOC_TOUCH_SENSOR_VERSION == 1`, so it is ESP32-only. There is no direction to flip; the direction is fixed by the silicon.
- **Wi-Fi needs the external antenna.** The XIAO ESP32S3 has no usable onboard antenna; Seeed ships a small 2.4GHz antenna that clips onto the U.FL/IPEX socket near the USB-C port. Without it the radio sees networks at roughly -85 dBm and cannot hold an association - `WiFi.status()` cycles 6 (disconnected) then sits at 0 (idle) rather than reaching 4 (auth failed), which reads like a credentials problem but is not one. Scan first and check RSSI before suspecting the password.
- Use USB serial at 115200 baud for diagnostics and upload. The board may disconnect and re-enumerate briefly during reset or upload.
- Before debugging the Pi serial protocol, prove the board independently: GPIO21 off at boot, touch-controlled LED output, and serial touch-state output.
- **Never wait unbounded on `while (!Serial)`.** The XIAO is routinely powered up before the Pi service opens the port, and an unbounded wait hangs the sketch inside `setup()` before anything runs - no output, no touch, no display, indistinguishable from a dead board. Bound it: `while (!Serial && millis() - start < 3000)`.
- The Grove OLED is a **SSD1315**, which is SSD1306-compatible. `U8G2_SSD1306_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE)` with `Wire.begin()` drives it. `oled.begin()` returns a bool - guard on it, and print the result, or a missing display is silent.
- A full U8g2 buffer push (`sendBuffer()`) costs roughly 10ms over I2C. Call it on state changes only; every loop starves the serial poll.
- **Never put a guard before the parse in a line handler.** `handleIncomingLine` opened with `if (!awaitingResponse) return;` *before* it deserialized anything, while the heartbeat deliberately never claims the pending slot - so every reply to a `device/status` was discarded unread, and a boot handshake that waited for one could never complete however many times it retried. Parse first, then decide what the message is for. The bug is invisible by inspection because both halves are individually correct.
- **A blocking peripheral read blocks everything, including the ability to notice a button was released.** `mic.readBytes()` for a whole 2-second clip made hold-to-talk impossible and froze any animation on its first frame. Read in ~100ms chunks and do the other work between them. A frozen indicator is worse than none: it asserts the device is busy while it may be dead, which is this project's most expensive failure mode.
- **Do not call a poll function from inside a handler that poll function dispatched.** `recordAndReportMic` calling `pollTouch()` to watch for release re-entered the function that owns the press/release debounce, leaving that state describing a moment that had already passed. Read the pad directly and debounce locally instead.
- **Batch `Serial.write`.** Writing 4 bytes at a time to the native USB CDC is ~107,000 calls for a 10-second audio clip and turns a transfer into a stall. Stage into a few hundred bytes and flush.
- **A large payload cannot be built in RAM before sending.** Ten seconds of audio is 320 KB of samples and ~427 KB of base64 - more than this chip's 320 KB of SRAM. Write the JSON by hand in pieces and encode on the way to the wire, straight out of PSRAM.
- **`cdc_on_boot=1` is the default for this board, and it is load-bearing for recovery.** The core brings the USB CDC stack up *before* `setup()` runs, and TinyUSB sits on its own FreeRTOS task that a spinning Arduino task cannot starve. That is why `/dev/ttyACM0` survives a sketch that hangs on the first line of `setup()`, and therefore why the Pi can flash a bricked device at all. A build with CDC-on-boot disabled could hang before USB exists, leaving no port to open.

## Building and flashing

```
arduino-cli compile --upload -p COM<n> firmware/smarttoolbox
```

No `--fqbn` needed: `firmware/smarttoolbox/sketch.yaml` declares a `release` profile
and sets it as the default, so the board, the `PSRAM=opi` option, and the pinned core
and library versions all come from there. Pass `--profile release` explicitly if you
prefer it visible in the command.

**A profile build ignores `~/Documents/Arduino/libraries` entirely.** It fetches the
pinned versions into a sketch-local directory instead. That is the point of it - an
`#include <ArduinoJson.h>` otherwise resolves to whatever is installed on the machine,
so updating a library for an unrelated project silently changes what ships. The first
profile build downloads its own core and toolchain and takes many minutes; later ones
reuse that cache.

The Grove 8x8 RGB matrix driver is **vendored into the sketch folder**
(`grove_two_rgb_led_matrix.h/.cpp`, MIT) rather than pinned in the profile, because it
is not in the Arduino library registry. The registry's similarly named "Grove - LED
Matrix Driver" is a different part - an STM32-based 64x32 dual-colour driver - and is
not a substitute. Provenance is recorded in `docs/SOURCES.md`.

To re-pin after a deliberate upgrade, build the way you normally would and run
`arduino-cli compile --fqbn esp32:esp32:XIAO_ESP32S3:PSRAM=opi --dump-profile
firmware/smarttoolbox`, then copy the versions it prints into `sketch.yaml`.

`arduino-cli board list` identifies the XIAO only as a generic "ESP32 Family Device"
with two candidate FQBNs. The COM port moves between sessions; compare the list with
the board unplugged to identify it.

### Resetting the board without reflashing

Some tests need a clean boot but must *not* reflash - checking that an OTA update is
picked up, for instance, where flashing over USB would install the new build directly
and prove nothing. Pulse RTS, which drives `EN` on the USB-Serial-JTAG bridge:

```powershell
$p = New-Object System.IO.Ports.SerialPort 'COM6',115200,'None',8,'One'
$p.Open()
$p.DtrEnable = $false; $p.RtsEnable = $true
Start-Sleep -Milliseconds 200
$p.RtsEnable = $false; $p.DtrEnable = $true
```

A successful reset prints `rst:0x15 (USB_UART_CHIP_RESET)` from the ROM bootloader.
Toggling DTR alone does **not** reset the board. After an OTA install the device
restarts itself, which shows as `rst:0xc (RTC_SW_CPU_RST)` - a useful way to confirm
the reboot came from `ESP.restart()` and not from something else.

### Flashing from the Pi over USB

The recovery path, for a build that OTA cannot replace - one that crashes in `setup()`,
wedges the loop, or breaks the serial link, where the thing that would accept the next
update is the thing that is broken. `api/scripts/flash-device.ps1` from Windows, or
`flash-device.sh` on the Pi. Proven against a real brick: a device silent for three
minutes came back in 47 seconds with nobody touching it.

- **`--no-stub` is mandatory on the Pi**, and its absence fails *late*. Debian ships
  `esptool` as `4.7.0+dfsg` with the precompiled stub flasher blobs stripped as non-free,
  so every command connects, resets the chip into download mode, identifies it, and only
  then dies with `FileNotFoundError: .../stub_flasher_32s3.json`. That reads like a
  corrupt installation rather than a licensing decision. Reaching that error is itself
  proof the hard part worked.
- **Install with `apt`, not `pip`.** The Pi's Python is externally managed under PEP 668.
  `sudo apt-get install -y esptool` gets 4.7.0; `--break-system-packages` is not worth it
  for a tool apt already has.
- **The binary is `/usr/bin/esptool`, not `esptool.py`,** and it is *not* on the PATH of a
  non-interactive SSH shell. Scripts must use the absolute path or they fail with
  `No such file or directory` while the same command works when typed by hand.
- **Flash the merged image, never the app binary.** `arduino-cli` writes
  `smarttoolbox.ino.merged.bin` beside `smarttoolbox.ino.bin`. The board is `default_8MB`
  with two app slots (`app0` at `0x10000`, `app1` at `0x340000`), so writing the app
  binary to `app0` while `otadata` points at `app1` reports complete success and changes
  nothing - the device boots the old image from the other slot. Writing the app binary at
  `0x0` is worse: it overwrites the bootloader and creates the brick you were fixing.
  `flash-device.sh` refuses anything under 2 MB for exactly this reason.
- The 8 MB image is not the transfer cost it looks like - it is mostly `0xFF` padding and
  compresses about 11:1, to ~736 KB. The ROM loader runs at ~2.6 Mbit/s: 26s writing, 48s
  wall clock including erase and reset.
- **Stop `smarttoolbox.service` first** to free the port, and restart it from a trap so it
  comes back even when the flash fails. A failed flash that also takes out the API, the
  dashboard and the serial link is worse than the failure it was reporting.
- The port re-enumerates during flashing - the USB device is provided by the chip being
  reprogrammed - so do not assume a stable device node across the whole operation.

### Testing an OTA update end to end

1. Note the version the device currently reports in its boot handshake.
2. `.\release-firmware.ps1 -Version <higher> -Push` from `api/scripts`.
3. Reset the board with the RTS pulse above - **not** by reflashing.
4. Watch for `OTA GET ... -> 200`, `OTA writing N bytes`, `OTA wrote N` (the two counts
   must match), then `rst:0xc`.
5. Confirm the next boot reports the new version and gets `-> 204`.

Step 5 is the actual proof. Steps 3 and 4 only show that bytes moved.

### Early boot output is written into a void

The S3's USB CDC is not a UART: anything `Serial.print`ed while no host has the port
open is **discarded, not buffered**. The device starts printing ~3.5s after power-on,
and the Pi's transport can still be in its reconnect backoff then, so boot-time output
routinely never reaches the log. This is not intermittent and it is not the Pi's fault.

The trap is that it makes a working code path look like a dead one. The OTA check
prints at every branch, and none of it survived - which was read for some time as "the
update check is not running". Anything that must be seen from the Pi has to be printed
*after* the link is proven, which is what `reportLastOtaResult()` is for: it holds the
outcome and prints it from `promoteToReady`, on the Pi's first reply. It used to fire on
the first heartbeat, which was an approximation of the same thing and is now wrong - the
waiting retry sends its first status two seconds after boot, and printing there would put
the log straight back into the void it was rescued from. The OLED is the only witness to
the boot window itself.

### The OTA boot check cannot win a cold start

Powering the whole box on at once guarantees a failed update check. The Pi needs 36.6s
to reach a listening API (5.2s kernel + 31.4s userspace); the device asks at ~3.5s and
gives up at ~30s, on the Wi-Fi timeout. It loses by about ten seconds, by construction,
every time.

It presents as `Update failed` on the OLED with a **negative** number - `HTTPClient`
returns its own error codes, so anything below zero means "never reached the server"
rather than a real HTTP status. Read the sign before anything else: negative is the
network or a server that is not up yet, `401` is the device key, `204` is genuinely up
to date.

To test an update deliberately, reset the XIAO **alone** against an already-running Pi.
Since 0.16.0 the device also re-checks two minutes after boot and every thirty minutes
while idle, so a cold start now recovers on its own rather than needing a second reset.

### HTTPClient discards response headers

`http.header("X-Firmware-Version")` returns an empty string unless the header was
requested *before* the request is sent:

```cpp
const char* wantedHeaders[] = {"X-Firmware-Version"};
http.collectHeaders(wantedHeaders, 1);
```

It fails silently, not loudly - the update still installs, it just cannot name the
version it installed.

### A large reply overflows the USB receive buffer, silently

The USB CDC receive buffer defaults to **256 bytes**. A found-tool reply from the Pi is
about a kilobyte and lands in under a millisecond, while the loop blocks for roughly
10ms at a time pushing a frame to the matrix over I2C. When the two coincide, one
buffer's worth of bytes is lost from the middle of the line - and the newline goes with
them, so what remains fuses with the next reply and `deserializeJson` rejects the pair.

Raise it before `Serial.begin()`, which is the only time it can be set:

```cpp
Serial.setRxBufferSize(4096);
Serial.begin(115200);
```

**The symptom names the wrong culprit.** The dropped line leaves the request pending, so
a hundred seconds later the voice timeout puts "No response - Is the Pi service up?" on
the screen, against a Pi that answered correctly and logged doing so. Small replies
survive and large ones do not, so "not found" works perfectly while every successful
lookup fails - which reads as a lookup bug rather than a transport one.

Found 2026-09-02, and only after `handleIncomingLine` was made to print what it could
not parse. It had been returning in silence, which is what made a damaged reply and a
missing reply indistinguishable. Keep that print.

## Reference

Seeed documentation URL checked on 2026-08-27:
`https://wiki.seeedstudio.com/xiao_esp32s3_getting_started/`

The page identifies GPIO21 as `USER_LED`, documents active-low behavior, maps the exposed touch pads, and describes the factory touch-light program. The installed `XIAO_ESP32S3` board variant also maps `LED_BUILTIN` to GPIO21.
