---
title: Vendor Documentation Sources
scope: index of external datasheets and reference pages
status: active
updated: 2026-08-28
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
| Seeed XIAO ESP32S3 Sense - product photo | The physical stack: camera and mic face up on the board-to-board connector, leaving the expansion header free for the Vision AI V2. Evidence that the two boards do not compete | Amazon listing, saved locally | 2026-08-28 | `xiao-screenshot.PNG` |
| Seeed XIAO ESP32S3 Sense - PDM microphone | On-board mic: GPIO 42 clock / 41 data, `ESP_I2S.h` init calls, PDM-mono-16-bit-only constraint, `ps_malloc` buffering. **Documents core 2.x and 3.x side by side and leads with 2.x — read the 3.0.x half** | `https://wiki.seeedstudio.com/xiao_esp32s3_sense_mic/` | 2026-08-28 | — (web) |
| OV5647 camera sensor | Resolution modes, MIPI interface (used via the Vision AI V2, not driven directly) | vendor datasheet — source not yet identified | not verified | — |

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
