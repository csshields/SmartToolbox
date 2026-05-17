---
title: SmartToolbox Project Instructions
scope: project-wide guidelines and specifications
status: active
updated: 2026-05-17
---

# SmartToolbox Project

## Project Overview

SmartToolbox is a monorepo containing two interconnected projects:
- **API**: Web server backend with SQLite database for handling requests and data storage
- **Firmware**: Arduino sketch for Seeed Xiao nRF52840 Sense microcontroller

## Project Structure

```
smarttoolbox/
├── .github/
│   └── copilot-instructions.md  # This file - AI instructions and project spec
├── api/                          # Web server and database project
│   ├── src/                      # TypeScript source code
│   ├── data/                     # SQLite database files
│   ├── public/                   # Static web assets
│   ├── deploy/                   # Deployment configurations
│   ├── scripts/                  # Build and utility scripts
│   ├── package.json              # Node.js dependencies
│   ├── tsconfig.json             # TypeScript configuration
│   └── sync.ps1                  # Sync script
└── firmware/                     # Arduino project for Seeed Xiao Sense
    ├── smarttoolbox/             # Main sketch folder
    │   └── smarttoolbox.ino      # Arduino sketch file
    └── README.md                 # Firmware documentation
```

## Architecture

### API Project
- **Language**: TypeScript/Node.js
- **Database**: SQLite (located in `api/data/`)
- **Purpose**: RESTful API server for data storage and retrieval
- **Key Files**:
  - `api/src/db.ts` - Database interface and queries
  - `api/src/index.ts` - Server entry point

### Firmware Project
- **Hardware**: Seeed Xiao nRF52840 Sense
- **Sensors**: Camera (OV2640), IMU (LSM6DS3), PDM Microphone
- **Connectivity**: Bluetooth Low Energy (BLE 5.0)
- **Purpose**: Capture sensor data and communicate with API server

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

- **Runtime**: Node.js with TypeScript
- **Server Framework**: Express.js or similar (TBD)
- **Database**: SQLite3
- **Package Manager**: Bun or npm
- **Build Tool**: TypeScript compiler (tsc)

## Database Schema

### Tables

Define your database tables here. Example structure:

```sql
-- Example table structure
CREATE TABLE IF NOT EXISTS sensors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  sensor_type TEXT NOT NULL,
  data BLOB,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  payload TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
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
npm install
npm run dev
```

### Production Deployment
- Use systemd service (see `api/deploy/smarttoolbox.service`)
- Deploy to Linux server (Raspberry Pi, VPS, etc.)
- Configure reverse proxy (nginx/caddy) if needed
- Set up log rotation
- Configure automatic backups for SQLite database

## Testing

- [ ] Unit tests for database operations
- [ ] Integration tests for API endpoints
- [ ] Load testing for concurrent requests
- [ ] Test database migrations

---

# Firmware Project Specifications

## Hardware Platform

**Board**: Seeed Xiao nRF52840 Sense
- **MCU**: Nordic nRF52840 (ARM Cortex-M4 @ 64MHz)
- **Memory**: 256KB RAM, 1MB Flash
- **Connectivity**: BLE 5.0, USB-C
- **Power**: 3.3V, rechargeable battery support

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
- **Use Cases**: Audio recording, sound detection
- **Library**: TBD

## Pin Mappings

Document critical pin assignments:
```cpp
// Example pin definitions
#define LED_PIN       13
#define CAMERA_SDA    4
#define CAMERA_SCL    5
#define IMU_SDA       4
#define IMU_SCL       5
// Add more as needed
```

## Communication Protocol

### BLE Communication
- **Service UUID**: TBD
- **Characteristics**:
  - Sensor Data: Read/Notify
  - Commands: Write
  - Status: Read

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
- [ ] Seeed Arduino LSM6DS3 (IMU)
- [ ] Seeed Arduino Camera (OV2640)
- [ ] ArduinoBLE or Nordic BLE library
- [ ] Add others as needed

---

# Integration & Communication

## Data Flow

```
Firmware (Xiao Sense) 
  ↓ [BLE or HTTP]
API Server (Node.js)
  ↓ [SQLite]
Database (Storage)
  ↓ [REST API]
Client Applications
```

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
