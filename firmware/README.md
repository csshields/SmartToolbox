# SmartToolbox Firmware

Arduino firmware for the Seeed XIAO ESP32S3 Sense that sits on the toolbox. It listens
for a request, sends the audio to the Pi over USB serial, and shows the answer on the
OLED, the 8x8 matrix and the LED strip.

Pins, wiring and the state of every part are in [docs/HARDWARE.md](../docs/HARDWARE.md).
The hardware traps worth knowing before changing anything are in
[.github/instructions/xiao-esp32s3-firmware.instructions.md](../.github/instructions/xiao-esp32s3-firmware.instructions.md).

## Hardware

- **Board**: Seeed XIAO ESP32S3 Sense, seated in the Expansion Board Base for XIAO
- **Carrier**: the Expansion Board Base brings the OLED (SSD1306, 0x3C), the
  push-to-talk button on D1, an RTC, an SD slot, and four Grove ports
- **Microphone**: the Sense board's PDM mic (GPIO 42 clock, GPIO 41 data). It feeds
  both push-to-talk and the "Hi ESP" wake word, and needs `PSRAM=opi` in the build
- **Indicators**: Grove 8x8 RGB LED matrix on a Grove I2C port; Grove WS2813 LED strip
  on the UART port, data GPIO44
- **Wired, not yet used**: Grove PIR motion sensor on the A0/D0 port (GPIO1), and the
  Grove Vision AI V2 on a Grove I2C port (0x62)
- **Link to the Pi**: USB serial to a Raspberry Pi Zero 2

## Building

The sketch builds with `arduino-cli`. `smarttoolbox/sketch.yaml` pins the ESP32 core
(3.3.11) and every library, and is the default profile, so a plain compile uses those
exact versions rather than whatever is installed on the machine:

```powershell
arduino-cli compile firmware/smarttoolbox
```

Libraries, all pinned in `sketch.yaml`:

- `ArduinoJson` - the serial messages
- `U8g2` - the OLED
- `Adafruit NeoPixel` - the WS2813 strip

The Grove matrix driver is not in the Arduino library registry, so it is vendored into
the sketch folder (`grove_two_rgb_led_matrix.*`). `ESP_SR` (the wake word), `ESP_I2S`,
`WiFi`, `HTTPClient` and `Update` ship with the ESP32 core.

`smarttoolbox/partitions.csv` replaces the board's default flash layout to make room
for the 3.3 MB speech model the wake word needs. Arduino picks it up from the sketch
folder automatically.

## Getting a build onto the device

Normally over Wi-Fi, from the `api/scripts` folder:

```powershell
.\release-firmware.ps1 -Version x.y.z -Push -Now   # the device fetches it within a heartbeat
.\flash-device.ps1 -Version x.y.z                  # over USB from the Pi, when OTA cannot help
```

Over-the-air updates need working firmware to receive them, and cannot change the
partition table. A bad build, or a partition change, goes on with `flash-device.ps1`,
which flashes through the XIAO's ROM bootloader over the USB cable it already shares
with the Pi. The `firmware-release` skill in `.claude/skills/` walks through all three.

Bump `FIRMWARE_VERSION` in `smarttoolbox.ino` for every release; the device compares it
with what the Pi offers.

## Talking to the Pi

The XIAO and the Pi exchange newline-delimited JSON over USB serial at 115200 baud. The
Pi sees the XIAO as `/dev/ttyACM0` and the `smarttoolbox` service opens it on start.
The device sends a `device/status` heartbeat every 30 seconds, which is how the Pi
knows it is alive and how it hands over queued commands such as "check for firmware".

To watch it:

```bash
tail -f ~/smarttoolbox/logs/service.log
```

```text
[serial] request id=status-12 endpoint=device/status
[serial] response written id=status-12
```

If the XIAO is unplugged, reset, or reflashed, the serial link reconnects on its own
with a growing backoff capped at 5s - no service restart needed. The full protocol is
in the spec.

## Project structure

```
firmware/
├── smarttoolbox/
│   ├── smarttoolbox.ino            # The firmware
│   ├── sketch.yaml                 # Pinned core and library versions
│   ├── partitions.csv              # Flash layout, with room for the speech model
│   ├── grove_two_rgb_led_matrix.*  # Vendored matrix driver
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

## TODO

- [x] USB serial link to the Pi, with lookups and a heartbeat
- [x] Push-to-talk voice lookup
- [x] "Hi ESP" wake word (0.28.0)
- [x] Wi-Fi OTA updates, and USB recovery flashing
- [ ] Recognise common tool names on the device, skipping Whisper
- [ ] Read the PIR on GPIO1 (wired, no firmware)
- [ ] Talk to the Grove Vision AI V2 (needs a trained model first)
