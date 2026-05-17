---
title: SmartToolbox Project Instructions
scope: project-wide guidelines and specifications
status: active
updated: 2026-05-17
---

# SmartToolbox Project

## Project Overview

SmartToolbox is a monorepo containing two interconnected projects:
- **API**: Web server backend with SQLite database running on Raspberry Pi Zero 2
- **Firmware**: Arduino sketch for Seeed Xiao nRF52840 Sense microcontroller

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
└── firmware/                     # Arduino sketch for Xiao Sense
    ├── smarttoolbox/             # Seeed Xiao nRF52840 Sense sketch
    │   └── smarttoolbox.ino      # Main controller sketch
    └── README.md                 # Firmware documentation
```

## Architecture

### System Overview
- **API Server**: Raspberry Pi Zero 2 running Bun and SQLite
- **Main Controller**: Seeed Xiao nRF52840 Sense (sensors, camera, microphone, LED control)
- **Communication**: Xiao Sense ↔ API Server (WiFi/HTTP or BLE over local network)

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

### Firmware Project - Xiao Sense
- **Hardware**: Seeed Xiao nRF52840 Sense
- **Sensors**: Camera (OV2640), IMU (LSM6DS3), PDM Microphone
- **Connectivity**: WiFi or BLE 5.0 to Raspberry Pi Zero 2
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
- [ ] Establish BLE communication
- [ ] Add power management
- [ ] Test sensor accuracy

## Notes

- API and firmware should communicate via BLE or HTTP
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
CREATE TABLE IF NOT EXISTS drawers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drawer_id INTEGER UNIQUE NOT NULL,
  name TEXT,
  description TEXT,
  capacity INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tool movement history
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

- [ ] Define authentication strategy (API keys, JWT, etc.)
- [ ] Implement rate limiting
- [ ] Add CORS configuration
- [ ] Secure sensitive endpoints

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

**Main Controller**: Seeed Xiao nRF52840 Sense
- **MCU**: Nordic nRF52840 (ARM Cortex-M4 @ 64MHz)
- **Memory**: 256KB RAM, 1MB Flash
- **Connectivity**: BLE 5.0, USB-C
- **Power**: 3.3V, rechargeable battery support
- **Built-in Sensors**: OV2640 Camera, LSM6DS3 IMU, PDM Microphone

**Extension Board**: Grove Extension Board for Xiao
- **Purpose**: Expands I/O pins, provides Grove connectors
- **Display**: Built-in OLED/LCD display module
- **Use Cases**: User feedback, status display, debugging
- **Connectivity**: Multiple Grove ports for sensors

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

### Camera (OV2640)
- **Resolution**: 2MP (1600x1200 max)
- **Interface**: I2C for control, parallel for data
- **Use Cases**: Capture images, object detection
- **Library**: TBD

### IMU (LSM6DS3)
- **Type**: 6-axis (3-axis accelerometer + 3-axis gyroscope)
- **Interface**: I2C
- **Data Rate**: Up to 1.6kHz
- **Use Cases**: Motion detection, orientation tracking
- **Library**: TBD

### Microphone (PDM)
- **Type**: Digital PDM microphone
- **Interface**: PDM (Pulse Density Modulation)
- **Sample Rate**: Configurable (8kHz - 16kHz typical)
- **Use Cases**: Audio recording, sound detection, keyword detection
- **Library**: TBD

### PIR Motion Sensor (Grove PIR Sensor)
- **Type**: Passive Infrared Motion Detector
- **Model**: Grove PIR Motion Sensor (or compatible)
- **Interface**: Digital GPIO via Grove connector
- **Connection**: Plugs into Grove Extension Board
- **Use Cases**: Wake mode trigger, activity detection
- **Trigger**: HIGH signal on motion detection
- **Detection Range**: Configurable (typically 3-7 meters)
- **Power**: 3.3V-5V from Grove port

### LED Strips/Arrays

**Drawer LEDs**:
- **Type**: Addressable RGB LED strips (e.g., WS2812B/NeoPixel)
- **Quantity**: One strip per drawer (number TBD)
- **Interface**: Single-wire data line
- **Controller**: Xiao Sense (direct control)
- **Use Cases**: 
  - Drawer illumination during wake mode
  - Tool location indication (color-coded by certainty)
  - Status feedback (returns, errors)
- **Library**: FastLED or Adafruit_NeoPixel
- **Power**: External 5V supply (calculate based on LED count)

**Camera Illumination LED**:
- **Type**: High-brightness white LED or LED ring
- **Purpose**: Illuminate tools for image capture
- **Interface**: Digital GPIO with PWM for brightness control
- **Control**: Direct from Xiao Sense
- **Power**: Current-limiting resistor or constant current driver

**Display Module** (on Grove Extension Board):
- **Type**: OLED or LCD (check Grove board specs)
- **Interface**: I2C via Grove connector
- **Use Cases**: 
  - Display transcribed voice commands
  - Show system status
  - Error messages and notifications
  - Tool search results
- **Library**: U8g2 (OLED) or LiquidCrystal_I2C (LCD)

## Pin Mappings

### Xiao nRF52840 Sense Pin Assignments
```cpp
// Built-in peripherals
#define LED_PIN           13    // Built-in LED
#define CAMERA_SDA        4     // Camera I2C data (built-in)
#define CAMERA_SCL        5     // Camera I2C clock (built-in)
#define IMU_SDA           4     // IMU I2C data (shared with camera)
#define IMU_SCL           5     // IMU I2C clock (shared with camera)
#define MIC_PDM_DATA      TBD   // PDM microphone data (built-in)
#define MIC_PDM_CLK       TBD   // PDM microphone clock (built-in)

// Grove Extension Board connections
#define GROVE_I2C_SDA     TBD   // Grove I2C data (for display, sensors)
#define GROVE_I2C_SCL     TBD   // Grove I2C clock
#define PIR_SENSOR_PIN    TBD   // Grove PIR sensor digital input
#define CAMERA_LED_PIN    TBD   // Camera illumination LED (PWM capable)

// LED Strip Control (multiple strips, one per drawer)
#define DRAWER_LED_1      TBD   // First drawer LED strip data pin
#define DRAWER_LED_2      TBD   // Second drawer LED strip data pin
#define DRAWER_LED_3      TBD   // Third drawer LED strip data pin
// Add more as needed per drawer count

// Optional Drawer Sensors (hall effect or photointerrupters)
#define DRAWER_SENSOR_1   TBD   // First drawer open/close sensor
#define DRAWER_SENSOR_2   TBD   // Second drawer sensor
#define DRAWER_SENSOR_3   TBD   // Third drawer sensor
```

## Communication Protocol

### Xiao Sense ↔ Raspberry Pi Zero 2 Communication
- **Method**: HTTP REST API over WiFi (primary) or BLE (alternative)
- **Network**: Local WiFi network
- **Protocol**: JSON over HTTPS/HTTP
- **Endpoints**: See API Endpoints section
- **Connectivity**:
  - Xiao Sense connects to WiFi network
  - Discovers Pi Zero 2 API server via mDNS or static IP
  - Makes HTTP requests for tool queries, returns sensor data
- **Alternative BLE Mode**:
  - Service UUID: TBD
  - Characteristics: Sensor Data (Read/Notify), Commands (Write), Status (Read)

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
- Optimize BLE connection intervals
- Target: XX hours/days on battery

## Firmware Architecture

```cpp
void setup() {
  // 1. Initialize serial
  // 2. Initialize sensors (camera, IMU, mic)
  // 3. Initialize BLE
  // 4. Configure power management
  // 5. Run self-test
}

void loop() {
  // 1. Check for sensor events
  // 2. Capture data if triggered
  // 3. Process data (compression, filtering)
  // 4. Transmit via BLE or queue
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
2. Add BLE communication
3. Integrate with API server
4. Optimize power consumption
5. Field testing

## Libraries Required

Add to Arduino Library Manager:
- [ ] FastLED or Adafruit_NeoPixel (LED control)
- [ ] HTTPClient or WiFi library (for API communication)
- [ ] ArduinoJson (JSON parsing for API responses)
- [ ] Add others as needed

## Feature Specifications

### Feature 1: Wake Mode (Motion-Activated)

**Purpose**: Automatically activate the toolbox when motion is detected, providing illumination and readying the camera for tool identification.

**Hardware Requirements**:
- PIR motion sensor
- Drawer LED strips (addressable RGB)
- Camera LED strips

**Behavior**:
1. **Idle State**: System in low-power mode, only PIR sensor active
2. **Motion Detection**: PIR sensor triggers interrupt
3. **Wake Activation**:
   - Turn on drawer LED strips (white light for visibility)
   - Turn on camera LED strips (adequate lighting for image capture)
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
- Implement gradual LED brightness (fade in) to avoid power spikes
- Monitor current draw to prevent brownouts

---

### Feature 2: Tool Drawer Requests (Voice-Activated)

**Purpose**: Allow users to request tool locations via voice commands, with visual feedback via color-coded LED indicators.

**Hardware Requirements**:
- PDM microphone
- Drawer LED strips (addressable RGB)
- Network connectivity (WiFi or BLE to API)

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
   - Send audio to **configurable** transcription service:
     - **Option A**: Local Whisper server (HTTP endpoint)
     - **Option B**: Cloud service (OpenAI Whisper API, Google Speech-to-Text, etc.)
     - **Option C**: Azure Cognitive Services
   - Configuration stored in API database or local config file
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
   - **Tool Identified**:
   ```json
   {
     "success": true,
     "found": true,
     "tool_name": "Phillips Screwdriver",
     "drawers": [
       { "drawer_id": 3, "certainty": 95 },
       { "drawer_id": 7, "certainty": 60 },
       { "drawer_id": 12, "certainty": 25 }
     ]
   }
   ```

6. **Visual Feedback**:
   - **Unknown Tool**: 
     - Flash all drawer LEDs **red** 3 times
     - Display "UNKNOWN" on optional display module
     - Play error tone (optional buzzer)
   
   - **Tool Found**: 
     - Light up drawer LEDs based on certainty:
       - **High certainty (80-100%)**: **Solid Green**
       - **Medium certainty (40-79%)**: **Solid Orange**
       - **Low certainty (10-39%)**: **Solid Blue** (or Purple/Cyan as alternative)
       - **Very low certainty (<10%)**: Do not illuminate
     - Keep LEDs lit for **30 seconds** or until drawer is opened
     - Brightness proportional to certainty (higher = brighter)

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
- Camera module (OV2640)
- Drawer LED strips (for feedback)
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
   - API uses computer vision (OpenCV, TensorFlow, or cloud API) to identify tool
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
     - Flash drawer LED **green** 2 times
     - Log event to database
   - **New Tool Detected**: 
     - Flash drawer LED **blue** 3 times
     - Prompt user for tool name (via app or display)
   - **Unknown Object**: 
     - Flash drawer LED **yellow** once
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
  // 3. Initialize LED strips (drawer LEDs, camera LEDs)
  // 4. Initialize network (WiFi or BLE)
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
```3 (IMU)
- [ ] Seeed Arduino Camera (OV2640)
- [ ] ArduinoBLE or Nordic BLE library
- [ ] Add others as needed

---

# Integration & Communication

## Data Flow

```
Firmware (Xiao Sense)
  ↓ [WiFi/HTTP or BLE]
API Server (Bun on Raspberry Pi Zero 2)
  ↓ [SQLite]
Database (Storage in api/data/)
  ↓ [REST API]
Client Applications (Web Dashboard, Mobile App, etc.)
```

**Communication Paths**:
1. **Xiao Sense → Pi Zero 2**: Tool queries, images, audio, telemetry (HTTP/WiFi)
2. **Pi Zero 2 → Xiao Sense**: Tool locations, commands, configuration (HTTP response)
3. **Xiao Sense**: Controls LEDs directly based on API responses
4. **Web Clients → Pi Zero 2**: Dashboard access, manual tool management (HTTP)

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
- [ ] Test BLE communication
- [ ] Implement data transmission pipeline

## Phase 3: Advanced Features
- [ ] Add camera capture and image storage
- [ ] Implement microphone recording
- [ ] Add authentication to API
- [ ] Optimize power consumption

## Phase 4: Polish
- [ ] Add web dashboard for monitoring
- [ ] Implement error recovery mechanisms
- [ ] Performance testing and optimization
- [ ] Documentation and deployment guides
