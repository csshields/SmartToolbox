# SmartToolbox

A monorepo project combining a web API server with Arduino firmware for the Seeed Xiao nRF52840 Sense microcontroller.

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
└── firmware/              # Arduino project (Seeed Xiao Sense)
    ├── smarttoolbox/      # Main sketch folder
    │   └── smarttoolbox.ino
    └── README.md          # Firmware-specific documentation
```

## Quick Start

### API Server

```bash
cd api
npm install
npm run dev
```

See [api/README.md](api/README.md) for detailed API documentation (if available).

### Firmware

1. Open `firmware/smarttoolbox/smarttoolbox.ino` in Arduino IDE 2.0+
2. Install Seeed nRF52 Boards from Board Manager
3. Select **Tools > Board > Seeed XIAO nRF52840 Sense**
4. Upload to your device

See [firmware/README.md](firmware/README.md) for detailed firmware documentation.

## Architecture

- **API**: RESTful server with SQLite database for data storage and retrieval
- **Firmware**: Captures sensor data from camera, IMU, and microphone
- **Communication**: BLE or HTTP between firmware and API

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
- **Hardware**: Seeed Xiao nRF52840 Sense
- **MCU**: Nordic nRF52840 (ARM Cortex-M4 @ 64MHz)
- **Connectivity**: Bluetooth Low Energy (BLE 5.0)
- **Sensors**: 
  - OV2640 Camera (2MP)
  - LSM6DS3 IMU (6-axis)
  - PDM Microphone

## Contributing

1. Check [.github/copilot-instructions.md](.github/copilot-instructions.md) for project guidelines
2. Follow the established patterns in each subproject
3. Test changes thoroughly before committing

## License

[Add your license here]
