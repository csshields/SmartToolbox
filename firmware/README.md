# SmartToolbox Firmware

Arduino firmware for the Seeed XIAO ESP32S3 microcontroller.

## Hardware

- **Board**: Seeed XIAO ESP32S3
- **Processor**: Espressif ESP32-S3
- **Sensors**:
  - Vision: Grove Vision AI Module V2 (SKU 101021112) with OV5647 camera; on-device SenseCraft AI inference over I2C
  - Microphone: the XIAO's own PDM mic on the Sense expansion board (GPIO 42 clock, GPIO 41 data); needs `:PSRAM=opi` in the build
  - Additional IMU hardware: not yet selected
- **Connectivity**: USB serial to Raspberry Pi Zero 2
- **I2C topology**: the XIAO bus reaches the expansion base, which carries its own OLED (SSD1306, 0x3C) and RTC, plus two Grove I2C ports - one for the Grove Vision AI V2 (0x62), one for the Grove 8x8 RGB LED Matrix. The Grove I2C Hub was removed on 2026-09-02
- **MVP feedback**: Matrix highlights matching rows; OLED shows exact drawer labels such as `1A` and `3`.
- **GPIO parts**: Grove WS2813 RGB LED Strip (SKU 104020108) on the UART Grove port, data GPIO44; Grove PIR Motion Sensor (SKU 101020020) on the A0/D0 port, GPIO1, wired but read by nothing. The Grove Red LED Button (SKU 111020044) was removed.
- **Carrier**: Seeed Studio Expansion Board Base for XIAO with Grove OLED (SKU 103030356), on the expansion header since 2026-09-02. Brings the OLED, the push-to-talk button on D1, an RTC, an SD slot and four Grove ports. Full detail in `docs/HARDWARE.md`.

## Setup

### Arduino IDE

1. Install Arduino IDE 2.0 or later
2. Add Seeed board support:
   - Go to File > Preferences
   - Add to Additional Board Manager URLs:
     ```
     https://files.seeedstudio.com/arduino/package_seeeduino_boards_index.json
     ```
3. Install `esp32` by Espressif Systems from Board Manager
4. Select **Tools > Board > esp32 > XIAO_ESP32S3**

### Libraries

Required libraries (install via Library Manager):
- `Seeed_Arduino_SSCMA` for Grove Vision AI V2 communication
- `ArduinoJson` for USB serial messages
- `U8g2` for the OLED
- `Seeed_RGB_Led_Matrix` for the Grove 8x8 RGB matrix (row indicator and idle face)

`WiFi`, `HTTPClient`, and `Update` ship with the ESP32 core - no install needed.

## Flashing

1. Open `smarttoolbox/smarttoolbox.ino` in Arduino IDE
2. Connect the Seeed XIAO ESP32S3 via USB-C
3. Select the correct COM port under Tools > Port
4. Click Upload

The tested Windows command-line upload uses the ESP32 core's XIAO target. Replace `COM6` with the port assigned to the XIAO:

```powershell
C:\arduino\arduino-cli.exe compile --fqbn esp32:esp32:XIAO_ESP32S3:PSRAM=opi C:\code\smarttoolbox\firmware\smarttoolbox
C:\arduino\arduino-cli.exe upload --fqbn esp32:esp32:XIAO_ESP32S3:PSRAM=opi --port COM6 C:\code\smarttoolbox\firmware\smarttoolbox
```

## USB Serial Handshake

Connect the flashed XIAO to the Raspberry Pi over USB-C. The Pi detects it as `/dev/ttyACM0`, and the `smarttoolbox` systemd service opens that device automatically. On boot, the sketch sends this newline-delimited request:

```json
{"id":"boot-1","type":"request","endpoint":"device/status","body":{"firmwareVersion":"0.5.0"}}
```

Press `RST` after connecting and verify the Pi received it:

```bash
tail -f ~/smarttoolbox/logs/service.log
```

Expected output:

```text
[serial] request id=boot-1 endpoint=device/status
```

If the XIAO is unplugged, reset, or reflashed, the serial transport reconnects on its own with a growing backoff capped at 5s - no service restart needed. Reconnects are logged as `[serial] disconnected, retrying in Nms` followed by `[serial] connected`.

## Project Structure

```
firmware/
├── smarttoolbox/
│   ├── smarttoolbox.ino            # The firmware
│   ├── arduino_secrets.example.h   # Template - copy to arduino_secrets.h
│   └── arduino_secrets.h           # Wi-Fi and device key (gitignored)
└── README.md                       # This file
```

`arduino_secrets.h` must live beside the sketch: Arduino resolves `#include "..."`
from the sketch folder only.

### Arduino Cloud leftovers

`Untitled_apr15a.ino`, `motion_ino.ino`, `thingProperties.h`, `sketch.json`, and
`ReadMe.adoc` sit in `firmware/` and are **history, not live code**. They came from
an early Arduino Cloud project and nothing builds or references them.
`motion_ino.ino` is the one worth keeping for now: it is the PIR + OLED bring-up
sketch, and its `U8G2_SSD1306_128X64_NONAME_F_HW_I2C` constructor is where the
working OLED setup came from. The rest can be deleted whenever you like.

## Development Notes

- Serial baud rate: 115200
- USB-C connection for programming and serial monitoring
- Board automatically enters bootloader mode on upload

## TODO

- [x] Send the `device/status` USB serial boot request to the API server
- [x] Parse USB serial responses and send tool lookup requests
- [x] Wi-Fi OTA updates (see Releasing firmware in the spec)
- [ ] Read the PIR on GPIO1 (Feature 1 - wired, no firmware)
- [ ] Implement camera capture
- [ ] Implement IMU data reading
- [ ] Add power management features
