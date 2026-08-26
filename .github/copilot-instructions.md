---
title: SmartToolbox Project Instructions
scope: project-wide guidelines and specifications
status: active
updated: 2026-08-26
---

# SmartToolbox Project

## Project Overview

SmartToolbox is a monorepo containing two interconnected projects:
- **API**: Web server backend with SQLite database running on Raspberry Pi Zero 2
- **Firmware**: Arduino sketch for Seeed XIAO ESP32S3 microcontroller

## Project Structure

```
smarttoolbox/
├── .github/
│   └── copilot-instructions.md  # This file - AI instructions and project spec
├── api/                          # Web server and database (runs on Pi Zero 2)
│   ├── src/                      # TypeScript source code
│   ├── data/                     # SQLite database files
│   ├── public/                   # Static web assets
│   ├── deploy/                   # Deployment configurations
│   ├── scripts/                  # Build and utility scripts
│   ├── package.json              # Node.js dependencies
│   ├── tsconfig.json             # TypeScript configuration
│   └── sync.ps1                  # Sync script
└── firmware/                     # Arduino sketch for XIAO ESP32S3
  ├── smarttoolbox/             # Seeed XIAO ESP32S3 sketch
    │   └── smarttoolbox.ino      # Main controller sketch
    └── README.md                 # Firmware documentation
```

## Architecture

### System Overview
- **API Server**: Raspberry Pi Zero 2 running Bun and SQLite
- **Main Controller**: Seeed XIAO ESP32S3 (LED control, USB serial, Wi-Fi, and BLE)
- **Vision Hardware**: Seeed Grove Vision AI Module (V2) + OV5647 camera, connected over I2C using the `Seeed_Arduino_SSCMA` library; on-device WiseEye2 inference is the default (only results, not raw frames, are read over the link).
- **Transcription**: Self-hosted Whisper server running on a NAS on the local network (see Communication Protocol)
- **Communication**: XIAO ESP32S3 → API Server over **wired USB serial**. Wi-Fi and BLE are available on the controller but are not used in the MVP.

### API Project
- **Host Device**: Raspberry Pi Zero 2
- **OS**: Raspberry Pi OS Lite (64-bit recommended)
- **Runtime**: Bun
- **Framework**: Hono
- **Database**: SQLite (located in `api/data/`)
- **Purpose**: RESTful API server for data storage and retrieval
- **Key Files**:
  - `api/src/db.ts` - Database interface and queries
  - `api/src/index.ts` - Server entry point

### Firmware Project - XIAO ESP32S3
- **Hardware**: Seeed XIAO ESP32S3 + Grove Vision AI Module (V2) with OV5647 camera
- **Sensors**: Vision (Grove Vision AI + OV5647); external IMU and microphone hardware are not yet selected
- **Connectivity**: Wired USB serial to Raspberry Pi Zero 2 (MVP scope; Wi-Fi and BLE are future-only)
- **Purpose**: Capture sensor data, control LEDs, communicate with API server

## Development Guidelines

### Code Style
- Use TypeScript strict mode for API project
- Follow async/await patterns for database operations
- Use clear, descriptive variable and function names
- Add comments for complex logic

### Database
- All database code should go in `api/src/db.ts`
- Use parameterized queries to prevent SQL injection
- Handle errors gracefully with try/catch blocks

### Firmware
- Arduino sketches must be in a folder with the same name as the .ino file
- Serial baud rate: 115200
- Initialize hardware in `setup()`
- Main logic in `loop()`

## Workflow for AI Assistants

When working on this project:

1. **Check this file first** - Always reference this document for project structure and requirements
2. **Scope awareness** - Determine if the task is for API or firmware
3. **Read existing code** - Check relevant files before making changes
4. **Maintain structure** - Keep code organized in the appropriate folders
5. **Test considerations** - Consider how changes affect both API and firmware components

## Current Goals

### API
- [ ] Define database schema
- [ ] Implement RESTful endpoints
- [ ] Add authentication/authorization
- [ ] Deploy configuration

### Firmware
- [ ] Implement sensor data capture
- [ ] Establish USB serial communication with the API
- [ ] Add power management
- [ ] Test sensor accuracy

## Notes

- API and firmware communicate via HTTP over WiFi (MVP); BLE is a future consideration only
- Consider data format compatibility between components
- Document API endpoints for firmware developers

## Future Considerations

- Add web dashboard for monitoring
- Implement over-the-air (OTA) firmware updates
- Add data visualization features
- Consider cloud deployment options

---

# API Project Specifications

## Technology Stack

- **Runtime**: Bun (JavaScript/TypeScript runtime)
- **Server Framework**: Hono (lightweight web framework)
- **Database**: SQLite3
- **Package Manager**: Bun
- **Build Tool**: Bun (native TypeScript support)

## Database Schema

### Tables

Define your database tables here. Example structure:

```sql
-- Sensor data storage
CREATE TABLE IF NOT EXISTS sensors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  sensor_type TEXT NOT NULL,
  data BLOB,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Event logging
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  payload TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tool inventory
CREATE TABLE IF NOT EXISTS tools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  description TEXT,
  image_url TEXT,
  current_drawer_id INTEGER,
  last_seen INTEGER,  -- Unix timestamp
  status TEXT DEFAULT 'available',  -- available, checked_out, missing
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Drawer information
-- LED indicators are per ROW, not per drawer: row 1 has 3 drawers sharing a single LED;
-- rows 2-6 have exactly 1 drawer each with their own LED. If a tool lives in ANY drawer
-- within a row, that row's single LED lights up.
CREATE TABLE IF NOT EXISTS rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  row_number INTEGER UNIQUE NOT NULL,  -- 1-6
  led_index INTEGER UNIQUE NOT NULL,   -- physical LED strip/position for this row
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS drawers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drawer_id INTEGER UNIQUE NOT NULL,
  row_id INTEGER NOT NULL,
  name TEXT,
  description TEXT,
  capacity INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (row_id) REFERENCES rows(id)
);

-- Tool movement history
-- NOTE: image_url/audio_url are nullable and unused by default for MVP. Raw images/audio
-- are processed transiently (not persisted to disk or DB) unless a future debug/persist
-- flag is enabled in `config`. Only identification results and metadata are stored.
CREATE TABLE IF NOT EXISTS tool_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_id TEXT NOT NULL,
  drawer_id INTEGER,
  event_type TEXT NOT NULL,  -- checked_out, returned, moved
  timestamp INTEGER NOT NULL,
  confidence INTEGER,  -- 0-100 for identification confidence
  image_url TEXT,
  audio_url TEXT,
  query_text TEXT,
  device_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tool_id) REFERENCES tools(tool_id)
);

-- System configuration
-- Single source of truth for mutable runtime settings (wake keyword, certainty
-- thresholds, transcription_service_url, persist_media flag, etc.). Static/deploy-time
-- settings (PORT, DATABASE_PATH, NODE_ENV, LOG_LEVEL) stay in .env, not this table.
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_tools_drawer ON tools(current_drawer_id);
CREATE INDEX IF NOT EXISTS idx_tools_status ON tools(status);
CREATE INDEX IF NOT EXISTS idx_movements_tool ON tool_movements(tool_id);
CREATE INDEX IF NOT EXISTS idx_movements_timestamp ON tool_movements(timestamp);
CREATE INDEX IF NOT EXISTS idx_sensors_device_timestamp ON sensors(device_id, timestamp);
```

**Schema Design Principles:**
- Use INTEGER for timestamps (Unix epoch)
- Use BLOB for binary data (images, audio)
- Use TEXT for JSON payloads
- Add indexes on frequently queried fields
- Always include created_at timestamps

## API Endpoints

Define your REST API endpoints here:

### Core Endpoints

```
GET    /api/health              - Health check
POST   /api/sensors             - Store sensor data
GET    /api/sensors/:id         - Get specific sensor reading
GET    /api/sensors/device/:id  - Get all readings for a device
DELETE /api/sensors/:id         - Delete sensor reading
```

### Tool Management Endpoints

```
POST   /api/tools/identify      - Identify tool from voice query
POST   /api/tools/identify-return - Identify tool from image (return detection)
GET    /api/tools/:id           - Get tool details
GET    /api/tools/drawer/:id    - Get all tools in a specific drawer
POST   /api/tools               - Add new tool to inventory
PUT    /api/tools/:id           - Update tool information
DELETE /api/tools/:id           - Remove tool from inventory
GET    /api/tools/search        - Search tools by name/category
POST   /api/config/keyword      - Update wake keyword configuration
GET    /api/config              - Get system configuration
```

### Request/Response Formats

**POST /api/sensors**
```json
{
  "device_id": "xiao-001",
  "sensor_type": "imu|camera|microphone",
  "timestamp": 1234567890,
  "data": "base64-encoded-data"
}
```

**Response:**
```json
{
  "success": true,
  "id": 123,
  "message": "Sensor data stored"
}
```

**POST /api/tools/identify** (Tool drawer request)
```json
{
  "device_id": "xiao-001",
  "timestamp": 1234567890,
  "query": "phillips screwdriver",
  "audio_url": "optional-s3-url"
}
```

**Response:**
```json
{
  "success": true,
  "found": true,
  "tool_name": "Phillips Screwdriver #2",
  "drawers": [
    { "drawer_id": 3, "certainty": 95 },
    { "drawer_id": 7, "certainty": 60 }
  ]
}
```

**POST /api/tools/identify-return** (Tool return detection)
```json
{
  "device_id": "xiao-001",
  "timestamp": 1234567890,
  "drawer_id": 5,
  "image_data": "base64-encoded-jpeg",
  "event_type": "drawer_closed"
}
```

**Response:**
```json
{
  "success": true,
  "tool_identified": true,
  "tool_name": "Phillips Screwdriver #2",
  "tool_id": "tool-12345",
  "drawer_id": 5,
  "action": "returned",
  "confidence": 88
}
```

## Authentication & Authorization

**Decision (MVP)**: No authentication. The XIAO ESP32S3 and API server are assumed to be on a trusted local network (home LAN), with no direct internet exposure. Revisit if the API is ever exposed beyond the LAN (e.g., remote dashboard access).

- [ ] Add CORS configuration (only if a browser-based dashboard on a different origin is added)
- [ ] Revisit auth if network trust model changes

## Error Handling

All errors should return consistent format:

```json
{
  "success": false,
  "error": "Error message",
  "code": "ERROR_CODE"
}
```

**HTTP Status Codes:**
- 200: Success
- 201: Created
- 400: Bad Request
- 401: Unauthorized
- 404: Not Found
- 500: Internal Server Error

## Configuration

Environment variables (use .env file):
```
PORT=3000
DATABASE_PATH=./data/smarttoolbox.sqlite
NODE_ENV=development|production
LOG_LEVEL=debug|info|warn|error
```

## Deployment

### Local Development
```bash
cd api
bun install
bun run start
```

### Raspberry Pi SSH Access

From the Windows development machine, connect to the Pi with:
```powershell
ssh -i "$env:USERPROFILE\.ssh\smarttoolbox_pi_ed25519" shields@192.168.50.30
```

- The Pi user is `shields`; the deploy script uses the same host and dedicated SSH key.
- If key access has not been installed, run `cd api; .\sync.ps1 -SetupKey` once and enter the Pi password directly in the terminal when prompted.
- Never store the Pi password or private-key contents in the repository.

### Production Deployment

**Raspberry Pi Zero 2 Setup**:
1. **Install OS**:
   - Flash Raspberry Pi OS Lite (64-bit) to microSD card
   - Enable WiFi and SSH during setup
   - Boot and update: `sudo apt update && sudo apt upgrade -y`

2. **Install Bun**:
   ```bash
   curl -fsSL https://bun.sh/install | bash
   # Add to PATH (follow installation instructions)
   source ~/.bashrc
   ```

3. **Deploy Application**:
   ```bash
   cd /home/pi
   git clone <repository-url> smarttoolbox
   cd smarttoolbox/api
   bun install
   ```

4. **Configure Systemd Service**:
   - Copy `api/deploy/smarttoolbox.service` to `/etc/systemd/system/`
   - Enable: `sudo systemctl enable smarttoolbox`
   - Start: `sudo systemctl start smarttoolbox`

5. **Networking**:
   - Configure static IP or use mDNS (smarttoolbox.local)
   - Open port 3000 (or configured port) in firewall
   - Consider setting up mDNS: `sudo apt install avahi-daemon`

6. **Maintenance**:
   - Set up log rotation for `/var/log/smarttoolbox/`
   - Configure automatic backups of SQLite database
   - Monitor disk space (microSD cards can fill up)

**Performance Notes**:
- Pi Zero 2 has limited RAM (512MB) - Bun uses less memory than Node.js
- Bun's native TypeScript support eliminates build step
- Consider disabling unused services to free resources
- MicroSD card speed affects database performance

## Testing

- [ ] Unit tests for database operations
- [ ] Integration tests for API endpoints
- [ ] Load testing for concurrent requests
- [ ] Test database migrations

---

# Firmware Project Specifications

## Hardware Platform

**Main Controller**: Seeed XIAO ESP32S3
- **MCU**: Espressif ESP32-S3
- **Connectivity**: Wi-Fi and BLE are available; the MVP connects to the Pi Zero 2 over **wired USB serial** (USB-C, CDC/ACM), not Wi-Fi
- **Power**: 3.3V, rechargeable battery support
- **Built-in Sensors**: None assumed. Vision, IMU, and microphone hardware are external peripherals.

**Vision Hardware**: Seeed Grove Vision AI Module (V2), SKU 101021112, + OV5647 Camera
- **Connection**: Connects to the XIAO ESP32S3 over I2C; physical expansion-header compatibility must be verified before stacking it.
- **Onboard MCU**: Himax WiseEye2 (capable of on-device ML inference)
- **Storage**: 32GB microSD card on the module itself
- **Identification Method (default)**: On-device inference on the WiseEye2 MCU via a model deployed through **SenseCraft AI** (no-code; supports MobileNet V1/V2, EfficientNet-lite, YOLOv5/v8). Only inference results (label/confidence) are read by the Xiao — Seeed's hardware doesn't support reading both a live frame and results simultaneously over the link. Cloud vision model fallback (e.g., Claude, GPT-4o) remains an option if on-device accuracy is insufficient, but requires pulling raw frames a different way (e.g., the module's own SD card or Type-C port) since they aren't available over the I2C results link.
- **Xiao ↔ Vision AI Link**: **I2C** (4-pin cable: SCL, SDA, VCC 3.3V, GND), using the `Seeed_Arduino_SSCMA` Arduino library — confirmed via Seeed's Grove Vision AI (V2) documentation

**I2C Expansion**: Grove - I2C Hub (6 Port)
- **Connection**: Plugs into the Grove Vision AI V2's I2C Grove port.
- **Connected Devices**: Grove OLED Display 0.96 inch (SSD1315) and Grove 8x8 RGB LED Matrix with Driver.
- **Constraint**: All attached devices share the I2C bus and must have compatible I2C addresses.

**MVP Feedback Hardware**
- **OLED**: Shows status and exact drawer labels, such as `1A` and `3`.
- **8x8 RGB LED Matrix**: Acts as the six-row location indicator; matching rows illuminate on a tool lookup.
- **Power**: These low-power I2C devices run from the existing Pi/Xiao USB-powered setup; no separate LED-strip supply is required for the MVP.

**Owned, Deferred GPIO Hardware**
- **Grove PIR Motion Sensor**, SKU 101020020: digital motion output; planned for wake detection.
- **Grove Red LED Button**, SKU 111020044: planned push-to-talk control and capture-status indicator.
- **Grove WS2813 RGB LED Strip Waterproof, 30 LEDs/m, 1 m**, SKU 104020108: deferred; it needs a dedicated GPIO data path and an external 5V power supply.
- **Seeed Studio Expansion Board Base for XIAO with Grove OLED**, SKU 103030356: owned; provides Grove I2C, UART, and A0/D0 ports, plus an onboard OLED, button, and buzzer. Its physical stacking and pin compatibility with the Vision AI V2 must be verified before use.
- **Constraint**: The Vision AI V2 is stacked on the XIAO expansion header, so these non-I2C components are not yet wired. Do not connect them to the I2C Hub.

**API Server**: Raspberry Pi Zero 2
- **CPU**: Broadcom BCM2710A1 (ARM Cortex-A53 @ 1GHz, quad-core)
- **Memory**: 512MB RAM
- **Storage**: MicroSD card (16GB+ recommended)
- **OS**: Raspberry Pi OS Lite (64-bit recommended)
- **Connectivity**: WiFi 802.11n, Bluetooth 4.2
- **Power**: 5V via micro-USB (2.5A minimum recommended)
- **Purpose**: Host Bun API server and SQLite database
- **Use Cases**:
  - Process tool identification requests
  - Store sensor data and tool inventory
  - Manage system configuration
  - Serve web dashboard (optional)

## Sensors & Peripherals

### Vision: Grove Vision AI Module (V2) + OV5647 Camera
- **Resolution**: OV5647, up to 5MP (2592x1944)
- **Connection**: I2C connection to the XIAO ESP32S3; physical stacking remains to be verified.
- **Interface**: I2C (SCL, SDA, VCC 3.3V, GND) — confirmed via Seeed documentation
- **Use Cases**: Tool identification (voice-requested lookup context and drawer-return detection)
- **Identification Method (default)**: On-device inference on the module's WiseEye2 MCU via a SenseCraft AI-deployed model (send only tool name/confidence to the API). Cloud vision model fallback (e.g., Claude, GPT-4o) if needed — see Feature 3.
- **Library/SDK**: `Seeed_Arduino_SSCMA` (Arduino library for I2C communication with the module)

### IMU (External, TBD)
- **Type**: 6-axis (3-axis accelerometer + 3-axis gyroscope)
- **Interface**: I2C
- **Data Rate**: Up to 1.6kHz
- **Use Cases**: Motion detection, orientation tracking
- **Library**: TBD

### Microphone (External, TBD)
- **Type**: Digital microphone
- **Interface**: PDM (Pulse Density Modulation)
- **Sample Rate**: Configurable (8kHz - 16kHz typical)
- **Use Cases**: Audio recording, sound detection, keyword detection
- **Library**: TBD

### PIR Motion Sensor (Grove PIR Sensor, SKU 101020020)
- **Type**: Passive Infrared Motion Detector
- **Model**: Grove PIR Motion Sensor
- **Interface**: Digital GPIO via Grove connector
- **Connection**: Deferred pending a GPIO expansion/wiring solution compatible with the stacked Vision AI V2
- **Use Cases**: Wake mode trigger, activity detection
- **Trigger**: HIGH signal on motion detection
- **Detection Range**: Configurable (typically 3-7 meters)
- **Power**: 3.3V-5V from Grove port

### Display and Indicators

**Row Indicator Matrix (MVP)**:
- **Type**: Grove 8x8 RGB LED Matrix with Driver
- **Interface**: I2C through the Grove - I2C Hub (6 Port)
- **Behavior**: Six matrix positions represent rows 1-6. Matching rows light by certainty; row 1 remains a single shared indicator for drawers 1A, 1B, and 1C.
- **Use Cases**: Row location indication and status feedback.

**OLED Display (MVP)**:
- **Type**: Grove OLED Display 0.96 inch (SSD1315)
- **Interface**: I2C through the Grove - I2C Hub (6 Port)
- **Use Cases**: Status, errors, and exact drawer labels, such as `1A` and `3`.

**WS2813 Strip (Future)**:
- **Type**: Grove WS2813 RGB LED Strip Waterproof, 30 LEDs/m, 1 m (SKU 104020108)
- **Interface**: Single-wire GPIO data signal; not I2C
- **Power**: External regulated 5V supply, sized for up to 1.8A at full white
- **Status**: Deferred until a compatible GPIO breakout/expansion design is selected.

**Camera Illumination LED**:
- **Type**: High-brightness white LED or LED ring
- **Purpose**: Illuminate tools for image capture
- **Interface**: Digital GPIO with PWM for brightness control
- **Control**: Direct from XIAO ESP32S3
- **Power**: Current-limiting resistor or constant current driver


## Pin Mappings

### XIAO ESP32S3 Pin Assignments
```cpp
// Confirm pin assignments against the physical XIAO ESP32S3 wiring before use.
#define LED_PIN           TBD
#define VISION_I2C_SDA    TBD
#define VISION_I2C_SCL    TBD
#define IMU_I2C_SDA       TBD
#define IMU_I2C_SCL       TBD
#define MIC_DATA          TBD
#define MIC_CLK           TBD

// Grove Extension Board connections (separate from the Grove Vision AI Module)
#define GROVE_I2C_SDA     TBD   // Grove I2C data (for display, sensors)
#define GROVE_I2C_SCL     TBD   // Grove I2C clock
#define PIR_SENSOR_PIN    TBD   // Grove PIR sensor digital input

// Row Indicator LED Control (one strip per ROW, not per drawer; 6 rows total)
#define ROW_LED_1         TBD   // Row 1 LED data pin (covers 3 drawers)
#define ROW_LED_2         TBD   // Row 2 LED data pin
#define ROW_LED_3         TBD   // Row 3 LED data pin
#define ROW_LED_4         TBD   // Row 4 LED data pin
#define ROW_LED_5         TBD   // Row 5 LED data pin
#define ROW_LED_6         TBD   // Row 6 LED data pin

// Optional Drawer Sensors (hall effect or photointerrupters)
#define DRAWER_SENSOR_1   TBD   // First drawer open/close sensor
#define DRAWER_SENSOR_2   TBD   // Second drawer sensor
#define DRAWER_SENSOR_3   TBD   // Third drawer sensor
// Add more as needed per drawer count (8 drawers across 6 rows)
```

## Communication Protocol

### XIAO ESP32S3 ↔ Raspberry Pi Zero 2 Communication
- **Method**: Wired **USB serial** (USB-C, CDC/ACM virtual serial port) for MVP. The XIAO also supports Wi-Fi and BLE, but neither is used near-term.
- **Physical link**: Xiao's USB-C cable plugged into a USB port on the Pi Zero 2 (e.g., appears as `/dev/ttyACM0` on the Pi)
- **Protocol**: Newline-delimited JSON. Every Xiao request has a unique `id`, `type: "request"`, a supported `endpoint`, and a `body`. The Pi echoes the same `id` in every response. The Bun implementation reads/writes the CDC ACM device directly without a native serial-port addon.
- **Initial endpoints**:
  - `device/status`: Xiao reports its firmware version and readiness.
  - `tools/lookup`: Xiao sends recognized or transcribed text; Pi returns matching drawer labels and row indicators.
  - `vision/observe`: Xiao sends `drawerLabel`, model version, and a `detections` array of tool-type labels, confidence, quantity, and optional bounding boxes.
- **Successful response**: `{"id":"req-001","success":true,"body":{...}}`
- **Error response**: `{"id":"req-001","success":false,"error":{"code":"INVALID_REQUEST","message":"drawer_label is required"}}`
- **Audio**: Do not embed multi-second WAV data in a JSON line. Push-to-talk audio will use a separate chunked transfer protocol after ordinary serial requests are working.
- **Connectivity**:
  - XIAO ESP32S3 writes/reads framed JSON messages over its USB serial connection
  - Pi Zero 2 process listens on the serial device and dispatches to the same handlers used for the HTTP API
  - No network discovery needed (mDNS/static IP) since the link is a direct wire, not WiFi

### API Server ↔ Whisper Transcription (NAS)
- **Method**: HTTP call from the Pi Zero 2 to a self-hosted Whisper server on the local NAS
- **Example**: `http://192.168.50.10:9000` (Swagger docs at `/docs`) — stored as `transcription_service_url` in the `config` table, not hardcoded
- **Timeout/Retry**: 5-second timeout, 2 retries (per Feature 2 spec)

### Data Format
Define binary or JSON format for sensor data transmission:
```cpp
// Example structure
struct SensorPacket {
  uint32_t timestamp;
  uint8_t sensor_type;  // 1=IMU, 2=Camera, 3=Mic
  uint16_t data_length;
  uint8_t data[];
};
```

## Power Management

- Use deep sleep between readings
- Wake on sensor interrupt or timer
- Monitor battery level
- Optimize WiFi connection/sleep intervals
- Target: XX hours/days on battery

## Firmware Architecture

```cpp
void setup() {
  // 1. Initialize serial
  // 2. Initialize sensors (Grove Vision AI, IMU, mic)
  // 3. Initialize WiFi
  // 4. Configure power management
  // 5. Run self-test
}

void loop() {
  // 1. Check for sensor events
  // 2. Capture data if triggered
  // 3. Process data (compression, filtering)
  // 4. Transmit via HTTP or queue
  // 5. Enter low power state
}
```

## Code Organization

- Use separate .h/.cpp files for each sensor module
- Create utility functions for common operations
- Implement non-blocking code (avoid delay())
- Use state machine for complex logic

## Debugging & Testing

- Serial output at 115200 baud
- Add verbose mode for debugging
- Implement self-test routines
- Log error codes for troubleshooting

## Development Workflow

1. Test individual sensors first
2. Add USB serial communication
3. Integrate with API server
4. Optimize power consumption
5. Field testing

## Libraries Required

Add to Arduino Library Manager:
- [ ] FastLED or Adafruit_NeoPixel (LED control)
- [ ] ArduinoJson (JSON parsing/encoding of messages sent over USB serial)
- [ ] Seeed_Arduino_SSCMA (I2C communication with the Grove Vision AI Module V2)
- [ ] Add others as needed

## Feature Specifications

### Feature 1: Wake Mode (Motion-Activated)

**Purpose**: Automatically activate the toolbox when motion is detected, providing illumination and readying the camera for tool identification.

**Hardware Requirements**:
- PIR motion sensor (deferred until GPIO expansion is available)
- 8x8 RGB LED matrix (MVP row indication)
- OLED display (MVP status display)

**Behavior**:
1. **Idle State**: System in low-power mode, only PIR sensor active
2. **Motion Detection**: PIR sensor triggers interrupt
3. **Wake Activation**:
  - Show ready status on the OLED and matrix
   - Power up camera module
   - Initialize microphone for keyword detection
   - Start activity timer
4. **Active State**: All systems ready, monitoring for user interaction
5. **Timeout**: After **10 minutes** of no motion detected, return to idle state
6. **Activity Extension**: Any new motion detection resets the 10-minute timer

**Configuration Options**:
- Timeout duration (default: 10 minutes, configurable via API or serial)
- LED brightness levels
- PIR sensitivity (if supported by hardware)

**Power Considerations**:
- Use PIR interrupt to wake from deep sleep
- The OLED and matrix operate from the existing low-power I2C setup
- Revisit power budgeting when the deferred WS2813 strip is added

---

### Feature 2: Tool Drawer Requests (Voice-Activated)

**Purpose**: Allow users to request tool locations via voice commands, with visual feedback via color-coded LED indicators.

**Hardware Requirements**:
- External microphone module
- 8x8 RGB LED matrix (one position per row; 6 rows total)
- OLED display for exact drawer labels
- USB serial connectivity to the API (see Communication Protocol)

**Workflow**:

1. **Keyword Detection**:
   - Continuously listen for wake word: **configurable** (e.g., "Smart Toolbox")
   - Default keyword: "Smart Toolbox" (stored in configuration)
   - Support for alternative keywords via API configuration endpoint

2. **Audio Capture**:
   - After keyword detected, record next **3-5 seconds** of audio
   - Format: WAV or compressed audio (e.g., Opus)
   - Buffer audio in RAM before transmission

3. **Audio-to-Text Conversion**:
   - **Decision**: Self-hosted Whisper server running on a NAS on the local network (not on the Pi Zero 2 — it doesn't have the RAM to run Whisper itself)
   - Example: `http://192.168.50.10:9000` (Swagger docs at `/docs`); stored as `transcription_service_url` in the `config` table so it can change without a redeploy
   - Include timeout and retry logic (5-second timeout, 2 retries)

4. **API Request**:
   - Send transcribed text to API endpoint: `POST /api/tools/identify`
   - Request format:
   ```json
   {
     "device_id": "xiao-001",
     "timestamp": 1234567890,
     "query": "screwdriver",
     "audio_url": "optional-storage-url"
   }
   ```

5. **API Response**:
   - **Unknown Tool**:
   ```json
   {
     "success": true,
     "found": false,
     "message": "Tool not found"
   }
   ```
   - **Tool Identified** (`row_number` is what actually drives the LED; `drawer_id` is the specific drawer for logging):
   ```json
   {
     "success": true,
     "found": true,
     "tool_name": "Phillips Screwdriver",
     "drawers": [
       { "drawer_id": 3, "row_number": 1, "certainty": 95 },
       { "drawer_id": 7, "row_number": 4, "certainty": 60 },
       { "drawer_id": 12, "row_number": 6, "certainty": 25 }
     ]
   }
   ```
   - If multiple drawers within the **same row** match (relevant for row 1's 3 drawers), the API collapses them to a single entry using the highest certainty for that row.

6. **Visual Feedback**:
   - **Unknown Tool**: 
     - Flash all row positions on the matrix **red** 3 times
     - Display "UNKNOWN" on the OLED
     - Play error tone (optional buzzer)
   
   - **Tool Found**: 
     - Light up each matching row's matrix position based on certainty:
       - **High certainty (80-100%)**: **Solid Green**
       - **Medium certainty (40-79%)**: **Solid Orange**
       - **Low certainty (10-39%)**: **Solid Blue** (or Purple/Cyan as alternative)
       - **Very low certainty (<10%)**: Do not illuminate
     - Show exact drawer labels on the OLED, such as `1A, 3`
     - Keep indicators lit for **30 seconds** or until a new interaction

7. **User Feedback**:
   - Optional: Play confirmation beep when keyword detected
   - Optional: Pulse LED during audio recording
   - Optional: Display transcribed text on OLED/LCD if available

**Configuration Options**:
- Wake word/keyword (string, stored in config)
- Transcription service URL and API key
- Certainty thresholds for LED colors
- LED color scheme (customizable RGB values)
- Timeout durations (recording, API call)
- Audio quality settings (sample rate, bit depth)

**Error Handling**:
- Network timeout: Flash yellow, retry once
- Transcription failure: Flash red, log error
- Microphone failure: Log to serial, disable feature
- Invalid API response: Log and display error code

---

### Feature 3: Watch for Tool Returns

**Purpose**: Automatically detect when tools are returned to drawers and log the event for inventory tracking.

**Hardware Requirements**:
- Grove Vision AI Module (V2) + OV5647 camera
- Row indicator LEDs (for feedback)
- Optional: Hall effect sensors or photointerrupters per drawer (for drawer open/close detection)

**Workflow**:

1. **Drawer Event Detection**:
   - **Method A (Sensors)**: Use hall effect sensors or photointerrupters to detect drawer opening/closing
   - **Method B (Periodic)**: Periodically scan all drawers when in wake mode
   - **Method C (Manual Trigger)**: User presses button to trigger return scan

2. **Tool Identification**:
   - When drawer closes (or on trigger), capture image of drawer contents
   - Send image to API endpoint: `POST /api/tools/identify-return`
   - Request format:
   ```json
   {
     "device_id": "xiao-001",
     "timestamp": 1234567890,
     "drawer_id": 5,
     "image_data": "base64-encoded-jpeg",
     "event_type": "drawer_closed"
   }
   ```

3. **API Processing**:
   - **Default**: Identification happens on-device on the Grove Vision AI Module's WiseEye2 MCU (SenseCraft AI-deployed model), which sends only the tool name/confidence to the API — raw images do not leave the device. Cloud vision fallback (e.g., Claude, GPT-4o) remains an option if on-device accuracy proves insufficient.
   - Compare with inventory database
   - Detect if tool is new, returning, or duplicate
   - Response format:
   ```json
   {
     "success": true,
     "tool_identified": true,
     "tool_name": "Phillips Screwdriver #2",
     "tool_id": "tool-12345",
     "drawer_id": 5,
     "action": "returned",
     "confidence": 88
   }
   ```

4. **Visual Feedback**:
   - **Successful Return**: 
     - Flash the drawer's row LED **green** 2 times
     - Log event to database
   - **New Tool Detected**: 
     - Flash the drawer's row LED **blue** 3 times
     - Prompt user for tool name (via app or display)
   - **Unknown Object**: 
     - Flash the drawer's row LED **yellow** once
     - Log for manual review
   - **Identification Failure**: 
     - No LED change
     - Log error to serial

5. **Inventory Update**:
   - Update tool location in database
   - Record timestamp of return
   - Update tool usage statistics (time out, time returned)
   - Optional: Generate usage report

**Configuration Options**:
- Enable/disable automatic scanning
- Image capture resolution (balance quality vs. upload time)
- Identification confidence threshold
- Scan interval (if using periodic method)
- Drawer sensor configuration (if using hardware sensors)

**Advanced Features** (Future):
- Machine learning model on-device for faster identification
- Tool condition assessment (wear, damage)
- Missing tool alerts
- Usage pattern analysis

---

## Firmware State Machine

To manage the complex interactions between features, implement a state machine:

```cpp
enum SystemState {
  STATE_IDLE,           // Low power, PIR only
  STATE_WAKE,           // Motion detected, initializing
  STATE_ACTIVE,         // Fully active, monitoring
  STATE_LISTENING,      // Keyword detected, recording audio
  STATE_PROCESSING,     // Waiting for API response
  STATE_INDICATING,     // Displaying LED feedback
  STATE_SCANNING,       // Capturing images for tool return
  STATE_ERROR           // Error state, requires reset
};

SystemState currentState = STATE_IDLE;
unsigned long lastActivityTime = 0;
const unsigned long WAKE_TIMEOUT = 600000; // 10 minutes in ms
```

**State Transitions**:
- `IDLE → WAKE`: PIR interrupt triggered
- `WAKE → ACTIVE`: Initialization complete
- `ACTIVE → LISTENING`: Keyword detected
- `LISTENING → PROCESSING`: Audio captured, sent to API
- `PROCESSING → INDICATING`: API response received
- `INDICATING → ACTIVE`: Feedback complete
- `ACTIVE → SCANNING`: Drawer closed event
- `SCANNING → ACTIVE`: Image captured and sent
- `ANY → IDLE`: Timeout exceeded (10 min no activity)
- `ANY → ERROR`: Critical failure detected

---

## Updated Firmware Architecture

```cpp
void setup() {
  // 1. Initialize serial (115200 baud)
  // 2. Initialize sensors (camera, IMU, mic, PIR)
  // 3. Initialize LED strips (row LEDs, camera LEDs)
  // 4. Initialize network (WiFi)
  // 5. Load configuration from EEPROM/flash
  // 6. Configure interrupts (PIR motion detection)
  // 7. Run self-test (verify all hardware)
  // 8. Enter idle state
}

void loop() {
  // State machine execution
  switch(currentState) {
    case STATE_IDLE:
      // Deep sleep, wake on PIR interrupt
      enterDeepSleep();
      break;
    
    case STATE_WAKE:
      // Turn on LEDs, initialize camera
      initializeWakeMode();
      currentState = STATE_ACTIVE;
      break;
    
    case STATE_ACTIVE:
      // Monitor for keyword detection
      // Check for timeout
      if (microphoneHasData()) {
        checkForKeyword();
      }
      if (millis() - lastActivityTime > WAKE_TIMEOUT) {
        shutdownWakeMode();
        currentState = STATE_IDLE;
      }
      break;
    
    case STATE_LISTENING:
      // Record audio buffer
      // Send to transcription service
      recordAndTranscribeAudio();
      currentState = STATE_PROCESSING;
      break;
    
    case STATE_PROCESSING:
      // Wait for API response (with timeout)
      // Parse response
      if (apiResponseReady()) {
        processToolRequest();
        currentState = STATE_INDICATING;
      }
      break;
    
    case STATE_INDICATING:
      // Display LED feedback
      // Wait for timeout or user interaction
      updateDrawerLEDs();
      if (feedbackComplete()) {
        currentState = STATE_ACTIVE;
      }
      break;
    
    case STATE_SCANNING:
      // Capture image of drawer
      // Send to API for identification
      captureAndIdentifyTool();
      currentState = STATE_ACTIVE;
      break;
    
    case STATE_ERROR:
      // Flash error code
      // Log to serial
      // Wait for reset or timeout recovery
      handleError();
      break;
  }
  
  // Reset activity timer on any interaction
  if (motionDetected() || drawerEventDetected()) {
    lastActivityTime = millis();
  }
}
```

---

# Integration & Communication

## Data Flow

```
Firmware (XIAO ESP32S3)
  ↓ [USB serial]
API Server (Bun on Raspberry Pi Zero 2)
  ↓ [SQLite]
Database (Storage in api/data/)
  ↓ [REST API]
Client Applications (Web Dashboard, Mobile App, etc.)
```

**Communication Paths**:
1. **XIAO ESP32S3 → Pi Zero 2**: Tool queries, images, audio, telemetry (USB serial)
2. **Pi Zero 2 → XIAO ESP32S3**: Tool locations, commands, configuration (USB serial response)
3. **XIAO ESP32S3**: Controls LEDs directly based on API responses
4. **Web Clients → Pi Zero 2**: Dashboard access, manual tool management (HTTP)

### Row-Aware Inventory Lookup

- A drawer has an exact display `label` (such as `1A`, `1B`, `1C`, or `3`) and a `row_number`.
- The Pi keeps the latest observation for each detected tool type and drawer, including quantity, confidence, model version, and timestamp.
- `GET /api/tools/lookup?query=needle-nose%20pliers` returns exact `drawers` for the OLED and a `rows` list collapsed by `row_number` for the matrix. When several drawers in one row match, the row takes the highest available confidence.
- `POST /api/vision/observations` accepts a `drawerId`, `modelVersion`, and `detections` array. Each detection contains `label`, `confidence` (0-100), and optional `quantity`.
- Tool identity is by type, not by individual physical instance. Multiple detections of a type in one drawer are represented by quantity.

## Message Format Standards

Use consistent data formats across both projects:
- Timestamps: Unix epoch (seconds or milliseconds)
- Device IDs: String format (e.g., "xiao-001")
- Binary data: Base64 encoding for transmission
- Metadata: JSON format

## Error Handling & Retries

- Firmware should queue data if connection lost
- API should validate all incoming data
- Implement exponential backoff for retries
- Log all communication errors

---

# Development Priorities

## Phase 1: Foundation
- [ ] Set up basic API with health endpoint
- [ ] Create database schema and migrations
- [ ] Test basic sensor initialization on Xiao
- [ ] Establish serial communication

## Phase 2: Core Features
- [ ] Implement sensor data storage endpoints
- [ ] Add IMU data capture in firmware
- [ ] Establish Grove Vision AI ↔ Xiao link over I2C (`Seeed_Arduino_SSCMA`)
- [ ] Implement USB serial data transmission pipeline

## Phase 3: Advanced Features
- [ ] Add tool identification via on-device SenseCraft AI model (cloud vision fallback if needed)
- [ ] Implement microphone recording
- [ ] Optimize power consumption

## Phase 4: Polish
- [ ] Add web dashboard for monitoring
- [ ] Implement error recovery mechanisms
- [ ] Performance testing and optimization
- [ ] Documentation and deployment guides
