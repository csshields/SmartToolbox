---
title: Vendor Documentation Sources
scope: index of external datasheets and reference pages
status: active
updated: 2026-09-06
---

# Vendor Documentation Sources

Vendor PDFs are **not committed** — `.gitignore` excludes `docs/*.pdf`. This file is
the tracked index: it records what each document is, where to get it again, and when
the URL was last confirmed. Download what you need into `docs/` and it stays local.

## Why an index instead of the files

Datasheets are large, binary, and never change; committing them once sets a precedent
for the Vision AI V2, SSD1315, OV5647, and every part added later. A URL plus a
checked-on date versions cleanly and matches the citation style already used in
`.github/instructions/xiao-esp32s3-firmware.instructions.md`.

## Chip and board

| Document | Covers | URL | Checked | Local file |
|---|---|---|---|---|
| ESP32-S3 Datasheet (Espressif) | Silicon: GPIO matrix, pin multiplexing, electrical characteristics, strapping pins | `https://www.espressif.com/sites/default/files/documentation/esp32-s3_datasheet_en.pdf` | not verified | `esp32-s3_datasheet.pdf` (1.19 MB) |
| Seeed XIAO ESP32S3 Getting Started | Board: D0–D10 pin labels, `USER_LED` on GPIO21, active-low polarity, exposed touch pads | `https://wiki.seeedstudio.com/xiao_esp32s3_getting_started/` | 2026-08-27 | — (web) |

**These two are not interchangeable.** The Espressif datasheet describes the chip; the
Seeed wiki describes the board's silkscreen labels and wiring. Firmware guidance in
`.github/instructions/xiao-esp32s3-firmware.instructions.md` depends on the board doc.
Use the datasheet when you need per-GPIO capability (which pins do touch, I2C, or act
as strapping pins) and cross-reference it against Seeed's D-numbering.

## Peripherals

| Document | Covers | URL | Checked | Local file |
|---|---|---|---|---|
| Grove Vision AI Module V2 (SKU 101021112) | I2C protocol, SSCMA library usage, SenseCraft model deployment | `https://wiki.seeedstudio.com/grove_vision_ai_v2/` | not verified | — |
| Seeed_Arduino_SSCMA | Arduino library API for the Vision AI V2 link | `https://github.com/Seeed-Studio/Seeed_Arduino_SSCMA` | not verified | — |
| Grove OLED Display 0.96" (SSD1315) | I2C address, init sequence, U8g2 constructor | `https://wiki.seeedstudio.com/Grove-OLED-Display-0.96K/` | not verified | — |
| Grove 8x8 RGB LED Matrix w/ Driver | I2C address, frame format, brightness control | `https://wiki.seeedstudio.com/Grove-RGB_LED_Matrix_w-Driver/` | not verified | — |
| Seeed_RGB_LED_Matrix (Arduino library) | The `grove_two_rgb_led_matrix.h/.cpp` driver, **vendored into `firmware/smarttoolbox/`** (MIT, v1.0.0). Not in the Arduino library registry, so `sketch.yaml` cannot pin it. The registry's "Grove - LED Matrix Driver" is a **different part** - an STM32-based 64x32 dual-colour driver - and is not a substitute | `https://github.com/Seeed-Studio/Seeed_RGB_LED_Matrix` | 2026-08-31 | vendored in-tree |
| Seeed XIAO ESP32S3 Sense - product photo | The physical stack: camera and mic face up on the board-to-board connector, leaving the expansion header free for the Vision AI V2. Evidence that the two boards do not compete | Amazon listing, saved locally | 2026-08-28 | `xiao-screenshot.PNG` |
| Seeed XIAO ESP32S3 Sense - PDM microphone | On-board mic: GPIO 42 clock / 41 data, `ESP_I2S.h` init calls, PDM-mono-16-bit-only constraint, `ps_malloc` buffering. **Documents core 2.x and 3.x side by side and leads with 2.x — read the 3.0.x half** | `https://wiki.seeedstudio.com/xiao_esp32s3_sense_mic/` | 2026-08-28 | — (web) |
| Expansion Board Base for XIAO (SKU 103030356) | Grove port list and voltage (all ports 3V3), onboard OLED, button, buzzer, RTC and SD slot, and the note that the XIAO's own USB-C stays usable when seated | `https://wiki.seeedstudio.com/Seeeduino-XIAO-Expansion-Board/` | 2026-09-02 | - (web) |
| Expansion Board Base - Zephyr shield definition | The pin facts the wiki leaves out, as a devicetree overlay: button on D1, SD chip select on D2, SSD1306 at 0x3C, PCF8563 RTC at 0x51 | `https://github.com/zephyrproject-rtos/zephyr/blob/main/boards/shields/seeed_xiao_expansion_board/seeed_xiao_expansion_board.overlay` | 2026-09-02 | - (web) |
| Grove Vision AI V2 - connection methods | Confirms the module is an ordinary I2C peripheral at 0x62 and can be cabled to a Grove port rather than stacked on the expansion header | `https://wiki.seeedstudio.com/grove_vision_ai_v2a/` | 2026-09-02 | - (web) |
| Adafruit NeoPixel (Arduino library) | WS2813 timing on the ESP32's RMT peripheral. Pinned at 1.15.5 in `sketch.yaml` | `https://github.com/adafruit/Adafruit_NeoPixel` | 2026-09-02 | - (web) |
| SmartToolbox photographs | The box as built over time - see the index in `docs/photos/README.md` | taken locally | 2026-10-04 | `photos/` |
| Grove Base Hat for Raspberry Pi Zero (SKU 103030276) | Grove port list, BCM pin mapping (digital 5/16, PWM 12/13, UART 14/15), the 3.3V-only port voltage, and the onboard 12-bit ADC read over I2C. **Lists three analog ports where the product page advertises four** | `https://wiki.seeedstudio.com/Grove_Base_Hat_for_Raspberry_Pi_Zero/` | 2026-09-06 | - (web) |
| Grove Base Hat for Pi Zero - product page | The SKU, and the advertised port count that disagrees with the wiki. Also the claim that this revision is the MM32 chip, which decides whether the ADC answers at 0x04 or 0x08 | `https://www.seeedstudio.com/Grove-Base-Hat-for-Raspberry-Pi-Zero.html` | 2026-09-06 | - (web) |
| Grove System - size of Grove | The five standard Grove board footprints: 20x20, 20x40, 20x60, 40x40 and 40x60 mm. **The page itself gives no hole coordinates** - those are in the mechanical-drawing ZIP it links. The PIR is the 20x40 size, but its hole positions come from the Eagle file below, not from here | `https://wiki.seeedstudio.com/Grove_System/#size-of-grove` | 2026-09-06 | - (web) |
| Grove PIR Motion Sensor v1.2 - Eagle files | Board outline and the three 2.2 mm mounting holes, read from the `.brd`: centred on the board's edges at (-10, -10), (-10, 10) and (20, 0) mm from the board centre, x towards the sensor end. The LHI778 element is at (13.3, 0) | `https://files.seeedstudio.com/wiki/Grove_PIR_Motion_Sensor/res/Grove%20PIR%20Motion%20Sensor_v1_2.zip`, linked from `https://wiki.seeedstudio.com/Grove-PIR_Motion_Sensor/` | 2026-09-27 | - (web) |
| OV5647 camera sensor | Resolution modes, MIPI interface (used via the Vision AI V2, not driven directly) | vendor datasheet — source not yet identified | not verified | — |

## Printed parts

Models printed for this box that were drawn by someone else. Same rule as the
datasheets: the files stay out of the repo and this table says where to get them
again. Parts drawn for this project live in `cad/` instead, with their generator.

| Model | Covers | URL | Checked | Local file |
|---|---|---|---|---|
| Foldable Holder for Grove Vision AI V2 Kit, by seeedstudio | The enclosure the Vision AI V2 and its OV5647 sit in. Three STLs: a 49.0 x 31.2 x 7.5 mm base, a cap that tilts on a screwed hinge, and a camera holder. Printed and in use. **Licensed CC BY-SA**, so any part that merges this geometry inherits that licence and its attribution requirement - one reason to bracket the enclosure rather than build it into the plate | `https://www.thingiverse.com/thing:6989378` | 2026-09-06, files in hand | `~/Downloads/3D Printed Foldable Holder for Grove Vision AI Module V2 Kit - 6989378/` |

## Examples
https://github.com/HimaxWiseEyePlus/Seeed_Grove_Vision_AI_Module_V2


## Conventions

- **Checked** is the date a human opened the URL and confirmed it resolves to the
  document described. `not verified` means the URL is recorded from memory or a
  product page and has not been opened — treat it as a lead, not a citation.
- When you cite one of these in an instructions file, copy the URL **and** the
  checked date, as the XIAO firmware instructions file already does.
- Record the revision or version string in the Covers column if the document has one
  and a behavioral detail depends on it.
