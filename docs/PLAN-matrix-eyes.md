---
title: Plan of Attack - LED Matrix Idle Eyes
scope: implementation plan, written 2026-08-27, revised 2026-08-27 against the real driver
status: code written, unverified - matrix hardware is not wired
---

# Plan: idle "eyes" on the 8x8 matrix

## Context

**Decision made 2026-08-27**: eyes are the idle/default face. A tool lookup still uses
the spec's row-indicator behaviour; the face returns once the result's display
duration ends.

The matrix is **not wired**, so none of this has run. The code exists and compiles,
and it is inert without the hardware - see Verification below.

### What already existed (an earlier draft of this plan got this wrong)

- `Seeed_RGB_Led_Matrix 1.0.0` is **installed**, at
  `~/Documents/Arduino/libraries/Seeed_RGB_LED_Matrix-master/`.
- `firmware/motion_ino.ino` already drives it: `scanGroveTwoRGBLedMatrixI2CAddress()`,
  a `getDeviceVID()` presence check, `displayColorBlock()`, `stopDisplay()`.

So this is not greenfield, and there was never a need to design against a placeholder
API. The remaining hardware prerequisite is only the physical wiring.

## The driver's actual shape

This drove most of the design, and it is not what a pixel-addressed library looks
like:

- There is **no `setPixel`**. The per-pixel call is
  `displayFrames(uint8_t* buffer, uint16_t duration, bool forever, uint8_t frames)`,
  where one frame is **64 bytes - one byte per pixel**.
- That byte is a **palette index, not RGB**: `red = 0x00`, `orange = 0x12`,
  `yellow = 0x18`, `green = 0x52`, `cyan = 0x7f`, `white = 0xfe`, **`black = 0xff`**.
  Clearing with `memset(buffer, 0, 64)` lights the whole panel **red**; blank is
  `0xff`.
- Every display call takes a duration and a `forever_flag`. With `forever_flag = true`
  the panel holds the image on its own, so the MCU only writes on change - the "push
  only on change" behaviour is inherent, not something to build.
- `displayFrames` can switch up to 5 frames autonomously, but at **one fixed
  duration** for all of them. That is why the blink below is still driven from
  `loop()`: a natural blink is asymmetric (~2-6s open, ~130ms closed) and the
  device's own animation cannot express that.
- `enableAutoSleep()` / `wakeDevice()` exist. Whether auto-sleep is on by default is
  **unverified** and matters for a persistent idle face - check it on first power-up.

## Row mapping: six indicators on eight rows

The spec requires "six matrix positions represent rows 1-6". Settled here:

```
matrix y=0   (blank margin)
matrix y=1   toolbox row 1   <- 1A / 1B / 1C share this
matrix y=2   toolbox row 2
matrix y=3   toolbox row 3
matrix y=4   toolbox row 4
matrix y=5   toolbox row 5
matrix y=6   toolbox row 6
matrix y=7   (blank margin)
```

Toolbox row N lights matrix row `y = N`, full width. The blank top and bottom rows
centre the block, and the arithmetic stays trivial.

The eyes sit at y=2..3, inside that range. That is **not** a conflict: the idle face
and a lookup result are mutually exclusive modes, never drawn together.

## Certainty colours

`certainty` is `null` for any tool the camera has never observed - which today is
**every tool in the box**, since the SenseCraft model is not deployed. Null therefore
needs a real colour, not a fallback:

| Result | Colour |
|---|---|
| Found, certainty `null` (manually entered) | white |
| Found, certainty >= 75 | green |
| Found, certainty < 75 | orange |
| Not found | red, held |
| Error or timeout | red, held |

Not-found and error deliberately look the same on the matrix. The LED already
separates them (3 fast blinks vs 1 long) and the OLED names which it is, so making
the matrix flash would mean a second animation state machine for a panel nobody has
seen working yet. Revisit once it is wired.

## Implementation

All in `smarttoolbox.ino`, matching `showStatus()` and `startBlinkPlan()` rather than
introducing an abstraction.

1. **Frame buffer + primitives** - a 64-byte buffer, `matrixClear()`,
   `matrixSetPixel(x, y, colour)`, `matrixPush()`. `matrixPush()` skips the I2C write
   when the buffer has not changed.
2. **Idle eyes + blink** - `millis()`-driven, no `delay()`. Open by default, closed
   ~130ms at randomised ~2-6s intervals.
3. **Mode handoff** - `MatrixMode { MATRIX_EYES, MATRIX_RESULT }`, a plain `switch`.
   Results are drawn where the LED blink plan is already started, and revert to eyes
   after the result duration. The blink timer resets on the way back so the eyes do
   not blink the instant the face returns.
4. **Presence guard** - `matrixReady`, set from the VID check exactly as
   `motion_ino.ino` does it, mirroring `oledReady`. Every matrix call no-ops without
   it, so an unwired box behaves exactly as it does today.

## Verification

**Nothing here is hardware-verified.** What has been checked:

- It compiles for `esp32:esp32:XIAO_ESP32S3`.
- With no matrix attached, `matrixReady` stays false and every matrix call returns
  early, so touch, lookup, OLED, and OTA are unaffected.

Still to check on real hardware, in this order:

1. VID check succeeds and `matrixReady` goes true.
2. Blank is `0xff` - confirm the panel is dark at rest, not red.
3. Orientation: `setDisplayOrientation` / `setDisplayOffset` may mean y=1 is not the
   row you expect. Confirm which physical row lights before trusting the mapping.
4. Auto-sleep does not switch the idle face off.
5. Brightness at rest is tolerable in a dark garage.

Keep the spec's status tag `Blocked` until all five pass. Code existing is not the
same as verified.

## Documentation, once verified

Hardware Bring-Up Status table, the Libraries Required checklist, Feature 2's status
line, and the matrix bullet in `firmware/README.md`.
