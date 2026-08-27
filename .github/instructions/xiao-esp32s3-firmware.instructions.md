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
- **Never wait unbounded on `while (!Serial)`.** The XIAO is routinely powered up before the Pi service opens the port, and an unbounded wait hangs the sketch inside `setup()` before anything runs - no output, no touch, no display, indistinguishable from a dead board. Bound it: `while (!Serial && millis() - start < 3000)`.
- The Grove OLED is a **SSD1315**, which is SSD1306-compatible. `U8G2_SSD1306_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE)` with `Wire.begin()` drives it. `oled.begin()` returns a bool - guard on it, and print the result, or a missing display is silent.
- A full U8g2 buffer push (`sendBuffer()`) costs roughly 10ms over I2C. Call it on state changes only; every loop starves the serial poll.

## Building and flashing

```
arduino-cli compile --upload -p COM<n> --fqbn esp32:esp32:XIAO_ESP32S3 firmware/smarttoolbox
```

`arduino-cli board list` identifies the XIAO only as a generic "ESP32 Family Device"
with two candidate FQBNs, so pass `--fqbn` explicitly. The COM port moves between
sessions; compare the list with the board unplugged to identify it.
- Before debugging Pi serial protocol, prove the board independently with GPIO21 off at boot, touch-controlled LED output, and serial touch-state output.

## Reference

Seeed documentation URL checked on 2026-08-27:
`https://wiki.seeedstudio.com/xiao_esp32s3_getting_started/`

The page identifies GPIO21 as `USER_LED`, documents active-low behavior, maps the exposed touch pads, and describes the factory touch-light program. The installed `XIAO_ESP32S3` board variant also maps `LED_BUILTIN` to GPIO21.
