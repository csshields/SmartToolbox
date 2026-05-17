# SmartToolbox Firmware

Arduino firmware for the Seeed Xiao nRF52840 Sense microcontroller.

## Hardware

- **Board**: Seeed Xiao nRF52840 Sense
- **Processor**: Nordic nRF52840 (ARM Cortex-M4)
- **Sensors**:
  - Camera: OV2640 (2MP)
  - IMU: LSM6DS3 (6-axis accelerometer + gyroscope)
  - Microphone: PDM microphone
- **Connectivity**: Bluetooth Low Energy (BLE 5.0)

## Setup

### Arduino IDE

1. Install Arduino IDE 2.0 or later
2. Add Seeed board support:
   - Go to File > Preferences
   - Add to Additional Board Manager URLs:
     ```
     https://files.seeedstudio.com/arduino/package_seeeduino_boards_index.json
     ```
3. Install "Seeed nRF52 Boards" from Board Manager
4. Select **Tools > Board > Seeed nRF52 Boards > Seeed XIAO nRF52840 Sense**

### Libraries

Required libraries (install via Library Manager):
- TBD - Add libraries as needed for camera, sensors, BLE

## Flashing

1. Open `smarttoolbox/smarttoolbox.ino` in Arduino IDE
2. Connect Seeed Xiao Sense via USB-C
3. Select the correct COM port under Tools > Port
4. Click Upload

## Project Structure

```
firmware/
├── smarttoolbox/           # Main Arduino sketch
│   └── smarttoolbox.ino    # Main program file
└── README.md               # This file
```

## Development Notes

- Serial baud rate: 115200
- USB-C connection for programming and serial monitoring
- Board automatically enters bootloader mode on upload

## TODO

- [ ] Implement camera capture
- [ ] Implement IMU data reading
- [ ] Implement BLE communication with API server
- [ ] Add power management features
