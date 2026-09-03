---
title: Hardware - parts, bring-up status, and pin mappings
scope: the single record of what is in the box, what physically works, and which pin carries it
status: active
updated: 2026-09-02
---

# SmartToolbox Hardware

Every part owned, whether it physically works, and which pin carries it.
`.github/copilot-instructions.md` remains the project spec; it points here instead of
repeating any of this. The same status convention applies - see Document Conventions in
the spec - and note the spelling difference it records: a section carries
`**Status: ...**`, a component entry carries `**Status**: ...` with the asterisks closed.

`docs/wiring-2026-09-02.jpg` is a photograph of the box as wired below. When the words
and the photograph disagree, the photograph is older.

Firmware traps that are about *behaviour* rather than parts - touch sensor v2 semantics,
the first ten `touchRead` calls after boot, upload settings - live in
`.github/instructions/xiao-esp32s3-firmware.instructions.md`, which loads by file glob
when a sketch is open. Which pin carries what is here; how it misbehaves is there.

## The 2026-09-02 rewire

The box was taken apart and rebuilt on 2026-09-02. Everything below the bring-up table
describes the result. What changed, because several of these had been treated as fixed
constraints for weeks:

- **The Vision AI V2 came off the expansion header** and is now cabled to a Grove I2C
  port. It was never mechanically required to stack; that was convenience, and Seeed's
  own documentation offers the Grove route.
- **The Expansion Board Base took the header instead**, which is what unblocked every
  GPIO part in one move.
- **The Grove I2C Hub and the Grove Red LED Button came out of the box entirely.** The
  hub is unnecessary now the base carries two I2C ports, and the button was the
  mis-wired part that had been disturbing the bus.
- **The Grove OLED came off** in favour of the base's own screen, which the firmware
  drove with no change at all.
- **The WS2813 strip and the PIR are wired for the first time.**
- **The touch pad stopped being the trigger**, because the PIR now drives that pin. The
  base's button replaced it.

## Bring-Up Status

Updated 2026-09-02. This table is the single place to check what is physically working.
Each row is a summary; the detail lives in the section named beside it.

| Component | Status | Notes |
|---|---|---|
| XIAO ESP32S3 Sense | Verified | Seated in the Expansion Board Base with the Sense board still mated on top. LED on GPIO21, active-low |
| Expansion Board Base | Verified | On the expansion header. Carries the OLED, the button, an RTC and an SD slot, and all four Grove ports now in use |
| USB serial XIAO to Pi | Verified | Unchanged by the rewire. The XIAO's own USB-C stays exposed with the base fitted |
| Wi-Fi OTA updates | Verified | Device pulled and installed 0.24.0. Signal measured at -52 dBm on 2026-09-02, so the external antenna is fitted and working. **Without it the radio cannot associate** |
| OLED | Verified | The base's own SSD1306 at 0x3C, on the shared bus. It replaced the Grove SSD1315, which answered at the same address - the two cannot both be on the bus. Same U8g2 constructor, no firmware change |
| Grove 8x8 matrix | Verified | On one of the base's Grove I2C ports, no longer through the hub. Mounted a quarter turn out, so the firmware sets `DISPLAY_ROTATE_270` every boot - that setting lives on the panel and survives power cycles |
| WS2813 LED strip | Verified, under-volted | Pointed at a real drawer row on 2026-09-02, in 0.27.0. Data is GPIO44; see the strip section for how that was proven and why the supply is a problem |
| Push-to-talk button | Verified | The base's own button on D1, shipped in 0.24.0. Hold-to-talk confirmed end to end on 2026-09-02: press, speak, release, drawer on the screen and the row on the strip |
| Microphone (PDM, on the Sense board) | Verified | Reported ready on the 0.24.0 boot. **Known thin:** the audio sits at 4-10% of full scale. Detail and the DC-bias trap are under Microphone |
| PIR motion sensor | Wired, no firmware | On the base's A0/D0 Grove port, so its signal is GPIO1. **Nothing in the firmware reads it.** No longer blocked, merely unwritten |
| Grove Vision AI V2 link | Cabled, unused | Moved from the expansion header to a Grove I2C cable. No firmware has ever talked to it - there is no SSCMA include in the sketch and no such library in `sketch.yaml` |
| SenseCraft model | Not deployed | **Blocks Feature 3.** Nothing to detect until a model is trained and flashed |
| Camera (OV2640, on the Sense board) | Not initialised | Physically fitted and facing up. The sketch carries no camera driver. Tool identification is the Vision AI V2's job, not this camera's |
| Grove I2C Hub | Removed | Out of the box. The base's two I2C ports made it unnecessary |
| Grove Red LED Button | Removed | Out of the box. It was mis-wired into the I2C hub, where its switch pulled on lines the displays depend on. The base's own button does its job now |
| Touch pads | Unused | Still on the board and still touch-capable, but nothing reads them. GPIO1 carries the PIR |
| Pi 40-pin GPIO header | Free, unpopulated | 26 usable GPIO, nothing in this project uses them. `gpioget`/`gpiomon` are installed and `/dev/gpiochip0` is present |

## Hardware Platform

**Main Controller**: Seeed **XIAO ESP32S3 Sense** (not the plain XIAO ESP32S3 - see
`docs/xiao-screenshot.PNG` for the exact part)

- **MCU**: Espressif ESP32-S3
- **Connectivity**: Wi-Fi and BLE are available; the box connects to the Pi Zero 2 over **wired USB serial** (USB-C, CDC/ACM). Wi-Fi is used only for OTA updates.
- **Memory**: 8MB PSRAM, 8MB flash. **PSRAM is on as of 2026-08-28**, and was off before that: a bare `esp32:esp32:XIAO_ESP32S3` takes the first entry of every board menu, and for PSRAM that is `disabled`, so `ps_malloc` returned null in every binary this repo had released. The fqbn now lives in `firmware/smarttoolbox/sketch.yaml` as the default `release` profile, so `release-firmware.ps1` and a bare `arduino-cli compile firmware/smarttoolbox` both pick it up; verify with `arduino-cli compile --show-properties`, where the bare fqbn shows an empty `build.defines` and the corrected one shows `-DBOARD_HAS_PSRAM`. **A manual `arduino-cli` invocation that bypasses the profile must carry `:PSRAM=opi` itself** - the microphone buffer cannot be allocated without it, and the failure presents as a dead mic rather than a build error.
- **Power**: 3.3V from the Pi's USB feed, through the base.

**Physical stack, as rebuilt 2026-09-02.** Three boards, three different connectors:

```
   Sense board          camera (OV2640) + PDM mic, facing up
        |               board-to-board connector
   XIAO ESP32S3         the core board
        |               expansion header
   Expansion Board Base OLED, button, RTC, SD, four Grove ports
```

The Vision AI V2 used to occupy the bottom slot and now hangs off a Grove cable instead.
The Sense board has never been in competition with anything: it mates through the XIAO's
own board-to-board connector, not the expansion header. This is the one place the stack
is described; everything else refers back to it.

**Expansion Board Base for XIAO with Grove OLED**, SKU 103030356

The carrier the XIAO plugs into, and the part that resolved the GPIO question. It brings
its own 0.96 inch SSD1306 OLED at 0x3C, a user button on D1, a buzzer on A3, a microSD
slot with chip select on D2, and a PCF8563 real-time clock at 0x51. It has a LiPo
connector, a charging circuit and a power switch, none of which this project uses -
**but the switch is a new way for the box to look dead, so check it first when nothing
happens.** The XIAO's own USB-C stays accessible with the base fitted; seat the XIAO
first, then plug the cable.

**Grove port allocation.** All four are in use, which is the whole budget:

| Port | Carries | Pins |
|---|---|---|
| I2C (1) | Grove Vision AI V2 | Shared bus, GPIO5/GPIO6 |
| I2C (2) | Grove 8x8 RGB matrix | Shared bus, GPIO5/GPIO6 |
| UART | WS2813 LED strip | GPIO44 data, GPIO43 backup |
| A0/D0 | Grove PIR motion sensor | GPIO1 |

**Every Grove port on this base supplies 3.3V**, which is silkscreened on the board. That
is correct for everything here except the strip, which wants 5V - see below.

**Vision Hardware**: Seeed Grove Vision AI Module (V2), SKU 101021112, + OV5647 Camera

- **Connection**: Grove I2C cable to the base, since 2026-09-02. It answers at address 0x62. Seeed documents both the header and the Grove route; stacking was convenience, not a requirement.
- **Onboard MCU**: Himax WiseEye2 (capable of on-device ML inference)
- **Storage**: 32GB microSD card on the module itself
- **Library**: `Seeed_Arduino_SSCMA`, which **this project has never used.** The link has been verified with other software; no shipped firmware has ever addressed the module.

**Owned, not in the box**

- **Grove I2C Hub (6 Port)**: removed 2026-09-02, unnecessary now the base has two I2C ports.
- **Grove Red LED Button**, SKU 111020044: removed 2026-09-02. It is a passive switch and LED with no I2C chip, and it had been plugged into the I2C hub, where its two pins landed on SDA and SCL and pressing it disturbed the bus. The base's own button replaced it.
- **Grove OLED Display 0.96 inch (SSD1315)**: removed 2026-09-02, displaced by the base's own screen at the same I2C address.

**API Server**: Raspberry Pi Zero 2

- **CPU**: Broadcom BCM2710A1 (ARM Cortex-A53 @ 1GHz, quad-core)
- **Memory**: 512MB RAM
- **Storage**: MicroSD card (16GB+ recommended)
- **OS**: Raspberry Pi OS Lite (64-bit recommended)
- **Connectivity**: WiFi 802.11n, Bluetooth 4.2
- **Power**: 5V via micro-USB (2.5A minimum recommended)
- **GPIO**: 40-pin header, entirely unused. 26 usable pins; libgpiod installed.
- **Purpose**: Host the Bun API server, the SQLite database, and the dashboard, and process tool identification requests.

## Sensors & Peripherals

### WS2813 LED strip - the row indicator

Grove WS2813 RGB LED Strip Waterproof, 30 LED/m, 1m, SKU 104020108. On the base's UART
Grove port.

- **Data is GPIO44 (D7). The backup line is GPIO43 (D6).** Proven on hardware 2026-09-02 by a firmware bring-up that drove each pin in turn in a different colour and let the strip say which one it answered on. Neither Seeed's wiki nor the connector markings settled it, and Grove UART cables differ over which signal sits on pin one.
- **The pixel that lights at power-up is the boot ROM.** The ROM prints its log on GPIO43 before the sketch starts, that pin is the strip's backup input, and a WS2813 falls back to the backup line when the main one is idle. The first write from the firmware clears it. This is not a fault and it was visible long before any strip code existed.
- **Nothing in the firmware uses UART0**, so the pins are free. `Serial` is the native USB CDC port.
- **Library**: `Adafruit NeoPixel`, pinned in `sketch.yaml`. It drives the timing from the ESP32's RMT peripheral, which is why this works on the XIAO and would not have worked from a Grove port on the Pi.
- **Power is the open problem.** The base's Grove ports supply 3.3V and a WS2813 wants 5V, so the strip runs under-volted: colours skew, the top of the brightness range is missing, and the blue that lights most readily is the one with the most headroom. It works well enough to prove the wiring. **Before the strip is mounted it should get its own regulated 5V supply with a shared ground**, sized for up to 1.8A at full white, because thirty LEDs drawing through the XIAO's regulator on the Pi's USB feed is not a supply, it is a fuse waiting to be found.
- **Brightness is deliberately low** in firmware for the same reason. Raise it only after the supply is sorted.
- **Row mapping is a placeholder.** Row N lights LED N-1. Which LED ends up beside which drawer is a physical decision nobody has made, because the strip is still coiled on the bench.
- **Status**: **working.** In 0.27.0 a spoken lookup lights the LED beside the matching row. First proven 2026-09-02 by asking for a Phillips head screwdriver and watching LED 1 come up white, white being what a record with no confidence gets.

### Push-to-talk button

The Expansion Board Base's own button, on **D1 (GPIO2)**. It shorts the pin to ground
with no pull-up on the board, so the firmware holds it high internally and a press reads
LOW. Hold it, speak, release.

- **It replaced the D0 touch pad**, which the PIR now drives. Touch charges a pad while the sensor drives it, which is two drivers on one net.
- **The touch machinery went with the pad**: seven pads of baseline calibration, a trigger ratio, a warm-up discard, and a per-scan debug print, all of which existed to make a capacitive pad behave the way a button simply does. The traps they taught are still recorded in the firmware instructions, because the pads remain on the board.
- **Watch for it reading permanently pressed.** D1 is plausibly the second signal pin of the A0/D0 Grove port the PIR sits on. Single-signal Grove modules leave that pin unconnected, so it should be clear, but a box that starts recording on its own and never stops is that.
- **Status**: shipped in 0.24.0, confirmed on hardware 2026-09-02.

### Microphone (on board)

The XIAO's own digital microphone, on the **Sense expansion board**. No external part is
needed or planned.

- **Interface**: PDM. Pins are fixed by the board, confirmed against Seeed's own documentation: **GPIO 42 = clock, GPIO 41 = data.**
- **Sample Rate**: 16 kHz mono, 16-bit. Not a preference - the ESP32-S3 supports *only* PDM mono at 16-bit, so the bit width and slot mode are the chip's, not a choice. The rate is adjustable; Seeed reports 16 kHz as the stable one, and it is also what Whisper wants, so there is no reason to move it.
- **Library**: `ESP_I2S.h` from the installed esp32 core (3.3.11), *not* the core-2.x `I2S.h` that Seeed's published examples still lead with. The two have different APIs and picking the wrong page is the likely first failure:

```cpp
// Core 3.x - what this project has.
I2S.setPinsPdmRx(42, 41);
I2S.begin(I2S_MODE_PDM_RX, 16000, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO);
```

- **Two ways to read, and they are not interchangeable.** `recordWAV(seconds, &size)` returns a `ps_malloc`'d buffer with a WAV header already attached, but takes a fixed duration - fine for a bring-up, useless for hold-to-talk, where the length is not known when recording starts. That path reads in a loop instead and lets the Pi write the header. See `docs/PLAN-mic-bringup.md` and `docs/PLAN-voice-lookup.md`.
- **Buffers go in PSRAM.** Four seconds of 16 kHz 16-bit mono is 128 KB against the XIAO's 320 KB of SRAM, of which this sketch already uses 49 KB.
- **The mic rides on a positive DC bias.** Samples run roughly +981 to +2568 and never cross zero, so RMS must be taken about the mean - measuring raw samples reads the offset, not the sound. Corrected in 0.17.0. A DC-corrected RMS read 17 in a quiet room against 210 spoken into, on 2026-08-29.
- **Status**: carrying speech since 0.20.0, voice lookup shipped in 0.22.0. **Known thin:** the audio sits at 4-10% of full scale, with no gain applied and the DC offset not stripped.

### PIR motion sensor (Grove PIR Sensor, SKU 101020020)

- **Connection**: the base's A0/D0 Grove port, so the signal is **GPIO1 (D0)**. Wired 2026-09-02.
- **Type**: passive infrared, digital output, HIGH on motion. 3.3V-5V from the Grove port.
- **Detection Range**: configurable, typically 3-7 meters.
- **Status**: **wired and unread.** No firmware touches GPIO1. Feature 1 is no longer blocked on hardware; it is simply unwritten.

### Vision: Grove Vision AI Module (V2) + OV5647 Camera

- **Resolution**: OV5647, up to 5MP (2592x1944)
- **Connection**: Grove I2C cable to the base, address 0x62.
- **Identification Method (default)**: on-device inference on the module's WiseEye2 MCU via a model deployed through **SenseCraft AI** (no-code; supports MobileNet V1/V2, EfficientNet-lite, YOLOv5/v8). Only the label and confidence are read - Seeed's hardware cannot serve a live frame and results over the link at the same time. A cloud vision model remains a fallback, but it needs raw frames pulled a different way: the module's own SD card or its Type-C port.
- **Status**: **connected and unused.** No model is deployed, and no firmware in this repo has ever addressed the module. Both have to change before Feature 3 means anything.

### Camera (OV2640, on board)

On the Sense board, facing up. **No firmware has ever initialised it** and the sketch
carries no camera driver. Tool identification runs on the Vision AI V2's own camera and
MCU, so this one has no assigned job.

### IMU (external, TBD)

- **Type**: 6-axis (3-axis accelerometer + 3-axis gyroscope), I2C
- **Status**: no part selected, nothing bought. **Library**: TBD.

### Displays

**OLED**: the base's onboard 0.96 inch SSD1306 at 0x3C, on the shared I2C bus. Shows
status and exact drawer labels such as `1A` and `3`. Driven with U8g2
(`U8G2_SSD1306_128X64_NONAME_F_HW_I2C`).

**8x8 RGB matrix**: Grove, on a Grove I2C port. Six positions represent rows 1-6; row 1
is a single shared indicator for drawers 1A, 1B and 1C. Its address is discovered at boot
and confirmed against the VID, so a missing panel degrades rather than hangs. Superseded
in the long run by the strip - see the Row Indication decision.

**Camera illumination LED**: planned, not owned, not wired.

## Pin Mappings

**Status: Implemented** - every pin below is wired and confirmed on hardware, except
where the entry says otherwise.

```cpp
// Onboard user LED. Active-low: LOW turns it ON, HIGH turns it OFF.
#define LED_PIN           LED_BUILTIN   // GPIO21

// Push-to-talk: the expansion base's own button, switch to ground.
const uint8_t BUTTON_PIN = 2;           // D1

// WS2813 strip on the base's UART Grove port. DIN is the RX pin; the boot ROM's
// log lands on the TX pin, which is the strip's backup input.
const uint8_t STRIP_DATA_PIN = 44;      // D7, UART0 RX
//                              43      // D6, UART0 TX - backup in, driven by no one

// PDM microphone on the Sense board. Fixed by the board, not chosen.
#define MIC_CLOCK_PIN     42
#define MIC_DATA_PIN      41

// PIR motion sensor on the base's A0/D0 Grove port. Wired, and read by nothing.
//   GPIO1 (D0)

// I2C, shared by everything on the base's two Grove I2C ports plus the base's own
// devices. `Wire.begin()` needs no arguments.
//   SDA = D4 (GPIO5), SCL = D5 (GPIO6)
//   0x3C OLED (on the base)      0x51 RTC (on the base, unused)
//   0x62 Grove Vision AI V2      matrix address discovered at boot
```

### Also spoken for

The base wires these whether or not the firmware uses them, so treat them as taken:
**D2** is the microSD chip select, **A3** is the buzzer, and **D8/D9/D10** are the SPI
bus the SD slot sits on. The buzzer is the only sound hardware this project owns.

### Deliberately Absent

- **No per-row LED GPIO pins.** Row indication is the strip on a single data line, and the matrix over I2C. Earlier drafts defined `ROW_LED_1`..`ROW_LED_6`; those defines should not reappear.
- **No touch pad defines.** The pads are still on the board and nothing reads them.
- **No per-drawer sensors.** Drawer open/close detection is one of three candidate methods in Feature 3 and no hardware has been chosen.

## Resolved: the GPIO expansion question

**Closed 2026-09-02.** For weeks this section asked where the PIR and a button could
possibly go, on the premise that the Vision AI V2 owned the expansion header and could
not be moved. Both halves of that premise were wrong, and the correction cost a Grove
cable:

- **The module did not need to stack.** It is an I2C peripheral at 0x62 and Seeed's own documentation offers the Grove route. The proof was already sitting in the old build, where the I2C hub chained off the module's own Grove port - the bus was coming back out of that connector the whole time.
- **The header was better spent on the Expansion Board Base**, which turns one occupied slot into four Grove ports, a button, a screen and a clock.

Two earlier corrections in this section are worth keeping, because both had been shaping
decisions:

- **GPIO never had to come from the XIAO.** The Pi's 40-pin header is unused. That option was never taken, but it was the observation that unstuck the thinking.
- **The Sense board never competed with anything.** It mates through the XIAO's own board-to-board connector. An earlier revision of the spec claimed otherwise and that claim drove decisions for weeks.

What is still constrained: the base has one digital Grove port and the PIR has it, so
another digital part means the Pi's header, a soldered wire, or the buzzer's pin.

## Decision: row indication runs on the strip, driven from the XIAO

**Status: Partial** - decided 2026-08-28, moved to the XIAO 2026-09-02, code written and
not yet released. **This reverses the earlier decision to drive the strip from the Pi
over SPI**, which was made when the XIAO's expansion header looked unavailable. Once the
base freed a real GPIO, the Pi route lost every argument it had:

- The ESP32 generates WS2812 timing in its RMT peripheral. On the Pi the same job needs either a native addon this project does not want inside Bun, or a bit-banging trick over SPI on a pin that is not a Grove port.
- The protocol argument was a wash. The Pi route needed no new message because the Pi computes the `rows` array; the XIAO route needs none either, because that array is already delivered to the device and already lights the matrix.
- One fewer moving part, and the strip lights from the same code path as every other indicator.

The reason for using a strip at all is unchanged. The 8x8 matrix indicates a row by
lighting matrix row N for toolbox row N, which has two faults that are the same fault
seen from two sides:

- **It caps at eight.** The unit of meaning is the panel's own height, so a toolbox with more rows than the panel has cannot be addressed. `MAX_TOOLBOX_ROWS` is 8 for this reason - a symptom of the design, not a hardware limit worth keeping.
- **It is hard to read.** A single lit row gives the eye no scale to count against, so it reads as "higher" or "lower" rather than as row 3.

The strip removes both by not encoding position at all. One LED sits beside each row, so
the light **is** the answer. Thirty LEDs is thirty rows.

**What this does to the other outputs.** Each ends up with one job and no overlap:

| Output | Job |
|---|---|
| WS2813 strip | Points at the row, physically |
| 8x8 matrix | The face: idle, thinking, not found, not understood |
| OLED | Names the exact drawer - `1A` against `1B`, which the strip cannot distinguish |

Once the strip is mounted the matrix stops encoding numbers, so the digit phase and
`MATRIX_RESULT_ROW_MS` can go. Do not invest further in making the matrix legible as a
row indicator.

## Open items

1. **A 5V supply for the strip**, with a shared ground. Until then it stays dim and
   under-volted.
2. **Mount the strip and fix the row mapping.** `STRIP_ROW_FIRST_LED` and the row-to-LED
   arithmetic are placeholders until the physical layout exists.
3. **Give the microphone some gain.** The audio sits at 4-10% of full scale with the DC
   offset not stripped, and it mis-hears: "screwdriver" came back from Whisper as "We're
   screwing driver" on 2026-09-02, and the box correctly found nothing for it. The fix is
   Step 1 of `docs/PLAN-mic-bringup.md`, and it is now the weakest link in the box.
4. **Read the PIR.** It is wired and nothing looks at it, which is all that stands
   between here and Feature 1.
5. **Deploy a SenseCraft model**, without which the Vision AI V2 is a connected part with
   nothing to say.
