# SmartToolbox

A monorepo project combining a web API server with Arduino firmware for the Seeed XIAO ESP32S3 microcontroller.

## Project Structure

```
smarttoolbox/
├── api/                    # Web server backend (TypeScript/Node.js)
│   ├── src/               # TypeScript source code
│   ├── data/              # SQLite database files
│   ├── public/            # Static web assets
│   ├── deploy/            # Deployment configurations
│   └── scripts/           # Build and utility scripts
│
└── firmware/              # Arduino project (Seeed XIAO ESP32S3)
    ├── smarttoolbox/      # Main sketch folder
    │   └── smarttoolbox.ino
    └── README.md          # Firmware-specific documentation
```

## Quick Start

### API Server

```bash
cd api
bun install
bun run start
```

On the Pi, the production service opens the connected XIAO at `/dev/ttyACM0` by default. Its log is at `~/smarttoolbox/logs/service.log`.

### Firmware

1. Open `firmware/smarttoolbox/smarttoolbox.ino` in Arduino IDE 2.0+
2. Install `esp32` by Espressif Systems from Board Manager
3. Select **Tools > Board > esp32 > XIAO_ESP32S3**
4. Upload to your device
5. Connect the XIAO to the Pi, then press `RST` to send its `device/status` boot request

See [firmware/README.md](firmware/README.md) for detailed firmware documentation.

## Architecture

- **API**: RESTful server with SQLite database for data storage and retrieval
- **Firmware**: Captures sensor data from camera, IMU, and microphone
- **Communication**: Wired USB serial between firmware and API for the MVP

## USB Serial Check

The initial XIAO-to-Pi handshake uses newline-delimited JSON. After the Pi service is running and the XIAO is connected, press `RST` on the XIAO. A successful request appears in the Pi log:

```text
[serial] request id=boot-1 endpoint=device/status
```

If the XIAO is unplugged and reconnected while the service is running, restart the service before resetting the XIAO because the current serial transport does not reconnect automatically:

```bash
sudo systemctl restart smarttoolbox
```

## Development

This project uses GitHub Copilot with custom instructions. The AI assistant will automatically reference:

- [.github/copilot-instructions.md](.github/copilot-instructions.md) - Project-wide specifications
- [.github/skills/](.github/skills/) - Specialized knowledge modules

## Tech Stack

### API
- **Runtime**: Node.js with Bun or npm
- **Language**: TypeScript
- **Database**: SQLite3
- **Server**: Express.js or similar

### Firmware
- **Hardware**: Seeed XIAO ESP32S3
- **MCU**: Espressif ESP32-S3
- **Connectivity**: USB serial to the Pi for the MVP; Wi-Fi and BLE are available for future use
- **Sensors**: 
  - Grove Vision AI Module V2 with OV5647 camera
  - Additional sensors to be connected externally as needed

## Contributing

1. Check [.github/copilot-instructions.md](.github/copilot-instructions.md) for project guidelines
2. Follow the established patterns in each subproject
3. Test changes thoroughly before committing

## License

[Add your license here]
