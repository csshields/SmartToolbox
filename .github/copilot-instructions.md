---
title: SmartToolbox Project Instructions
scope: project-wide guidelines and specifications
status: active
updated: 2026-08-27
---

# SmartToolbox Project

## Document Conventions

This file mixes what is built with what is designed but not yet built. Every major
section carries a status line so the difference is never ambiguous:

- **Status: Implemented** - the code exists and runs. File references point at it.
- **Status: Partial** - some of it runs; the section says which part.
- **Status: Planned** - designed here, not written yet.
- **Status: Blocked** - planned, and something concrete is in the way. The blocker is named.

When a section's status changes, update the line in the same commit as the code.

## Project Overview

SmartToolbox is a monorepo containing three parts:
- **API**: Bun web server and SQLite database running on a Raspberry Pi Zero 2
- **Firmware**: Arduino sketch for the Seeed XIAO ESP32S3 microcontroller
- **Dashboard**: a single-page web UI served by the API, used to manage drawers and tools

## Project Structure

```
smarttoolbox/
├── .github/
│   ├── copilot-instructions.md   # This file - AI instructions and project spec
│   ├── instructions/             # Scoped guidance applied by file glob
│   │   └── xiao-esp32s3-firmware.instructions.md
│   └── skills/                   # Specialized knowledge modules
├── docs/
│   └── SOURCES.md                # Vendor datasheet index (PDFs are gitignored)
├── api/                          # Web server and database (runs on Pi Zero 2)
│   ├── src/                      # TypeScript source code
│   │   ├── index.ts              # Server entry point, HTTP + serial routing
│   │   ├── db.ts                 # SQLite schema and all queries
│   │   ├── serialProtocol.ts     # NDJSON request/response framing
│   │   └── serialTransport.ts    # Reads and writes the CDC ACM device
│   ├── data/                     # SQLite database files (gitignored)
│   ├── public/                   # Dashboard single-page app
│   ├── deploy/                   # smarttoolbox.service systemd unit
│   ├── scripts/                  # Build and utility scripts
│   ├── package.json              # Dependencies
│   ├── tsconfig.json             # TypeScript configuration
│   └── sync.ps1                  # Deploy script (Windows -> Pi)
└── firmware/                     # Arduino sketch for XIAO ESP32S3
    ├── smarttoolbox/             # Seeed XIAO ESP32S3 sketch
    │   └── smarttoolbox.ino      # Main controller sketch
    └── README.md                 # Firmware documentation
```

## Architecture

### System Overview
- **API Server**: Raspberry Pi Zero 2 running Bun and SQLite
- **Main Controller**: Seeed XIAO ESP32S3 (LED control, USB serial, Wi-Fi, and BLE)
- **Vision Hardware**: Seeed Grove Vision AI Module (V2) + OV5647 camera, **connected** - stacked on the XIAO expansion header (not a 4-pin Grove cable), talking I2C via the `Seeed_Arduino_SSCMA` library. On-device WiseEye2 inference is the default (only results, not raw frames, are read over the link). **No SenseCraft model is deployed yet**, so the link is live but returns nothing useful.
- **Transcription**: Self-hosted Whisper server running on a NAS on the local network (see Communication Protocol)
- **Communication**: XIAO ESP32S3 → API Server over **wired USB serial**. Wi-Fi and BLE are available on the controller but are not used in the MVP.

### Hardware Bring-Up Status

Updated 2026-08-27. This table is the single place to check what is physically working.

| Component | Status | Notes |
|---|---|---|
| XIAO ESP32S3 standalone | Verified | LED (GPIO21, active-low) and touch pads confirmed on hardware |
| USB serial XIAO to Pi | Verified | `device/status` boot request reaches the Pi service |
| Touch-triggered `tools/lookup` | Partial | Touch fires the request on hardware (D0 reads ~18.3k idle, ~31.4k touched). The blink-back half is untested - it needs the Pi, since the serial listener only starts on Linux |
| Grove Vision AI V2 link | Connected | Stacked on the expansion header; I2C link up |
| SenseCraft model | Not deployed | **Blocks Feature 3.** Nothing to detect until a model is trained and flashed |
| OLED (Grove SSD1315 0.96") | Verified | On the I2C connector, GPIO5/GPIO6. Driven with U8g2 (`U8G2_SSD1306_128X64_NONAME_F_HW_I2C`); the SSD1315 is SSD1306-compatible. Shows lookup status and the exact drawer label |
| Grove I2C Hub + 8x8 matrix | Not wired | Blocks the row-indicator half of Feature 2. The OLED covers drawer labels in the meantime |
| Microphone | Not selected | **Blocks Feature 2.** No part chosen |
| PIR motion sensor | Deferred | **Blocks Feature 1.** Needs GPIO the Vision AI V2 stack now occupies |

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

## Physical Layout

**Status: Implemented** - this is the real toolbox, not an example.

Six rows, eight drawers. Row 1 is split into three drawers that share one indicator;
rows 2-6 are a single drawer each.

```
Row 1 | 1A | 1B | 1C |   <- one shared LED / matrix position
Row 2 |       2       |
Row 3 |       3       |
Row 4 |       4       |
Row 5 |       5       |
Row 6 |       6       |
```

This drives two rules that appear throughout this document:

1. **Indicators are per row, not per drawer.** There are 6 indicator positions for 8
   drawers. If a tool is in any drawer of a row, that row lights.
2. **The OLED disambiguates what the matrix cannot.** The matrix can only say "row 1";
   the OLED shows the exact label, such as `1A`.

When several drawers in one row match a lookup, the API collapses them into a single
row entry carrying the highest confidence of the group (`findToolLocations` in
`api/src/db.ts`).

Rows and drawers are stored as data, not hardcoded: a drawer row carries a `label`
(`1A`, `3`) and a nullable `row_number`. The schema permits layouts other than the one
above; the physical box is what fixes it at 6 rows and 8 drawers.

## Development Guidelines

### Code Style
- Use TypeScript strict mode for API project
- Follow async/await patterns for database operations
- Use clear, descriptive variable and function names
- Comment only the non-obvious why (a hidden constraint, a subtle invariant), never
  the what. Keep each comment to 1-2 lines - if it needs more, put the reasoning in
  the commit message or this spec instead.

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
- [x] Define database schema (`api/src/db.ts`)
- [x] Implement drawer, tool, lookup, and observation endpoints
- [x] Deploy configuration (systemd unit + `api/sync.ps1`)
- [ ] Reconcile remaining planned endpoints (see API Endpoints)
- [ ] Authentication - deliberately deferred, see Authentication & Authorization

### Firmware
- [x] Establish USB serial communication with the API (`device/status` handshake)
- [x] Verify XIAO bring-up independently (LED + touch)
- [x] Send real `tools/lookup` requests from a touch pad, blinking the row number back
- [x] Connect Grove Vision AI V2 over I2C
- [ ] **Next: Deploy a SenseCraft model** so `vision/observe` carries real labels
- [ ] **Planned: Implement Wi-Fi OTA firmware updates** (see Feature 4 in Firmware Specifications)
- [ ] Wire the I2C hub, OLED, and 8x8 matrix
- [ ] Select microphone hardware
- [ ] Add power management

## Notes

- API and firmware communicate over **wired USB serial** for the MVP, using
  newline-delimited JSON. Wi-Fi and BLE are available on the XIAO but unused; revisit
  only if the wire becomes a real constraint.
- Keep data formats consistent between components - see Message Format Standards.
- Document API endpoints for firmware developers.

## Future Considerations

- Add data visualization features
- Per-instance tool tracking (checkout history, missing-tool alerts) - see Tool Identity
- Consider cloud deployment options
- Implement power management and deep sleep optimization

The web dashboard is no longer a future item; it is built and served today. See
Dashboard under API Project Specifications. Wi-Fi OTA firmware updates are now
planned; see **Firmware OTA Updates** under Firmware Project Specifications.

---

# API Project Specifications

## Technology Stack

- **Runtime**: Bun (JavaScript/TypeScript runtime)
- **Server Framework**: Hono (lightweight web framework)
- **Database**: SQLite3
- **Package Manager**: Bun
- **Build Tool**: Bun (native TypeScript support)

## Database Schema

**Status: Implemented** - the block below is what `api/src/db.ts` actually creates at
startup. It is the authority; if this section and the code disagree, the code wins and
this section is stale.

### Tool Identity

Tools are tracked **by type and quantity, not as individual physical instances.**
"Three Phillips screwdrivers in drawer 1A", never "screwdriver #2 is in 1A". There is
no per-tool checkout state, no `tool_id`, and no movement history. Per-instance
tracking is a Future Consideration, not a current gap to be filled in.

### Implemented Tables

```sql
-- Drawers. `label` is what the OLED shows (1A, 3); `row_number` drives the matrix.
CREATE TABLE IF NOT EXISTS drawers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  label TEXT,
  row_number INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Known contents of a drawer, entered by hand via the dashboard.
-- One row per (drawer, tool type); quantity carries the count.
CREATE TABLE IF NOT EXISTS tools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drawer_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(drawer_id) REFERENCES drawers(id) ON DELETE CASCADE
);

-- What the camera reported. Append-only; the newest row per (drawer, tool) wins.
-- Distinct from `tools`: `tools` is intent, `drawer_observations` is evidence.
CREATE TABLE IF NOT EXISTS drawer_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drawer_id INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity >= 1),
  confidence INTEGER NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
  model_version TEXT NOT NULL DEFAULT '',
  observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(drawer_id) REFERENCES drawers(id) ON DELETE CASCADE
);

-- Every API request, for the dashboard's Recent Requests panel.
CREATE TABLE IF NOT EXISTS request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  tool TEXT NOT NULL DEFAULT '',
  drawer_number INTEGER,
  status_code INTEGER NOT NULL,
  result TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Mutable runtime settings. Deploy-time settings stay in the environment.
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tools_drawer_name ON tools(drawer_id, name);
CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_observations_tool_drawer
  ON drawer_observations(tool_name, drawer_id, id DESC);
```

Config keys currently in use: `transcription_provider`, `transcription_nas_url`.

### Migrations

There is no migration framework. `db.ts` runs `CREATE TABLE IF NOT EXISTS`, then
patches older databases in place by checking `PRAGMA table_info` and issuing
`ALTER TABLE ... ADD COLUMN` for `label` and `row_number`. Follow that pattern when
adding a column: additive, idempotent, safe to run on every boot.

### Planned Tables

**Status: Planned** - none of these exist. Do not write code against them.

- `tool_movements` - checkout and return history. Needs per-instance identity first.
- `sensors` / `events` - generic sensor capture, from the original sketch of the
  project. Currently unused; `drawer_observations` covers the only sensor that exists.
- A dedicated `rows` table. Rows are presently just a nullable `row_number` column on
  `drawers`, which the code treats as sufficient.

**Schema Design Principles:**
- SQLite `TEXT` timestamps via `CURRENT_TIMESTAMP` for rows written by the API;
  Unix epoch integers only where the firmware supplies the time
- Use TEXT for JSON payloads
- Add indexes on frequently queried fields
- Always include created_at timestamps
- Enforce invariants with CHECK constraints rather than in application code

## API Endpoints

**Status: Implemented** - this list is generated from the router in
`api/src/index.ts`. The router is a plain `if` chain on pathname and method, not a
framework; Hono is a dependency but is not currently used for routing.

### HTTP Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness check. Returns `{"status":"Ok"}` |
| GET | `/api/drawers` | All drawers with their tools and tool counts |
| POST | `/api/drawers` | Create a drawer (`name`, optional `label`, `rowNumber`) |
| POST | `/api/drawers/:id/tools` | Add or update a tool in a drawer (upsert on name) |
| GET | `/api/tools/lookup?query=` | **Primary lookup.** Returns exact drawers plus rows collapsed by certainty |
| POST | `/api/tools/assign` | Move a tool to a drawer by name |
| POST | `/api/vision/observations` | Record camera detections for a drawer |
| GET | `/api/logs?limit=` | Recent request log (default 50, capped at 200) |
| GET | `/api/settings/transcription` | Current transcription provider settings |
| PUT | `/api/settings/transcription` | Save provider and NAS URL |
| POST | `/api/settings/transcription/test` | Probe the configured provider |

Anything under `/api/` that does not match returns 404 JSON. Everything else falls
through to static files from `api/public/`, with `index.html` as the SPA fallback.

### Deprecated

- `GET /api/tools/find?tool=` - superseded by `/api/tools/lookup`, which returns row
  data the indicators need. Nothing calls it: the dashboard does not, and the firmware
  uses the serial channel. Remove it and `findToolDrawer` in `db.ts` when convenient.
- `POST /query` - scaffold from the first commit. Logs the body and replies
  `{"reply":"Received"}`. Dead; remove.

### Lookup Response Shape

`GET /api/tools/lookup?query=needle-nose%20pliers`

```json
{
  "found": true,
  "tool": "Needle-nose Pliers",
  "drawers": [
    { "drawerId": 1, "label": "1A", "rowNumber": 1, "quantity": 2,
      "confidence": 95, "observedAt": "2026-08-27 11:04:12" }
  ],
  "rows": [ { "rowNumber": 1, "certainty": 95 } ]
}
```

`drawers` feeds the OLED (exact labels). `rows` feeds the 8x8 matrix, already
collapsed so that several matching drawers in one row produce a single entry at the
highest confidence. `confidence` is null when the tool is known from manual entry but
has never been observed by the camera.

Not found returns `{"found": false, "message": "Tool not found."}` with HTTP 200 -
a lookup that matched nothing is a successful lookup, not an error.

### Planned Endpoints

**Status: Planned** - specified below but not implemented. `identify` and
`identify-return` are the voice and vision flows described in Features 2 and 3; both
are blocked on hardware, so neither has been built.

```
POST   /api/tools/identify         - Identify tool from voice query
POST   /api/tools/identify-return  - Identify tool from image (return detection)
GET    /api/tools/:id              - Get tool details
GET    /api/tools/search           - Search tools by name/category
PUT    /api/tools/:id              - Update tool information
DELETE /api/tools/:id              - Remove tool from inventory
GET    /api/config                 - Get system configuration
POST   /api/config/keyword         - Update wake keyword
```

**POST /api/tools/identify** (planned)
```json
{
  "device_id": "xiao-001",
  "timestamp": 1234567890,
  "query": "phillips screwdriver"
}
```

Response, where `row_number` drives the indicator and `drawer_id` identifies the exact
drawer for logging:
```json
{
  "success": true,
  "found": true,
  "tool_name": "Phillips Screwdriver",
  "drawers": [
    { "drawer_id": 3, "row_number": 1, "certainty": 95 },
    { "drawer_id": 7, "row_number": 4, "certainty": 60 }
  ]
}
```

**POST /api/tools/identify-return** (planned)
```json
{
  "device_id": "xiao-001",
  "timestamp": 1234567890,
  "drawer_id": 5,
  "image_data": "base64-encoded-jpeg",
  "event_type": "drawer_closed"
}
```

```json
{
  "success": true,
  "tool_identified": true,
  "tool_name": "Phillips Screwdriver",
  "drawer_id": 5,
  "action": "returned",
  "confidence": 88
}
```

## Dashboard

**Status: Implemented** - `api/public/index.html`, a single self-contained page with
inline CSS and JS. No build step, no framework, no dependencies.

This is the primary way drawers and tools are managed today, and it is how the system
is usable at all while the firmware is unfinished. Four panels:

| Panel | Backed by |
|---|---|
| Inventory Overview | `GET /api/drawers` - counts and summary |
| Toolbox Inventory | `GET /api/drawers`, `POST /api/drawers`, `POST /api/drawers/:id/tools` |
| Transcription Settings | `GET`/`PUT /api/settings/transcription`, `POST .../test` |
| Recent Requests | `GET /api/logs?limit=40` |

It does not call `/api/tools/lookup`, `/api/tools/assign`, or
`/api/vision/observations` - those exist for the firmware.

Because the page is served from the same origin as the API, no CORS configuration is
needed. Keep it that way unless a separate front end is introduced.

## Authentication & Authorization

**Decision (MVP)**: No authentication. The XIAO ESP32S3 and API server are assumed to be on a trusted local network (home LAN), with no direct internet exposure. Revisit if the API is ever exposed beyond the LAN (e.g., remote dashboard access).

- CORS is not needed: the dashboard is served from the same origin as the API. Add it
  only if a front end moves to a different origin.
- [ ] Revisit auth if the network trust model changes, or if the Pi is ever reachable
  from outside the LAN

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

Settings split in two by lifetime. Deploy-time values come from the environment;
anything a user can change at runtime lives in the `config` table so it survives a
redeploy and can be edited from the dashboard.

**Environment variables** (read via `Bun.env`):

| Variable | Default | Used by |
|---|---|---|
| `PORT` | `3000` | `index.ts` |
| `SERIAL_DEVICE` | `/dev/ttyACM0` on Linux, otherwise unset | `index.ts`. When unset, the serial listener does not start - this is why the server runs fine on Windows with no XIAO attached |
| `OPENAI_API_KEY` | unset | Optional OpenAI transcription fallback |
| `NODE_ENV` | unset | Set to `production` by the systemd unit |

**Runtime settings** (`config` table): `transcription_provider`,
`transcription_nas_url`.

The database path is **not** configurable. `db.ts` hardcodes `<cwd>/data/smarttoolbox.sqlite`
and creates the directory if missing, so the server must be started from `api/` (or
from `~/smarttoolbox/` on the Pi, which mirrors it). `DATABASE_PATH` and `LOG_LEVEL`
were specified here previously but were never read by any code.

## Deployment

### Local Development
```bash
cd api
bun install
bun run start
```

The server starts without a XIAO attached: `SERIAL_DEVICE` is unset off Linux, so the
serial listener is skipped and only HTTP runs. The dashboard is then at
`http://localhost:3000`.

### Syncing to the Pi from Windows

`api/sync.ps1` is the deploy path. It is tracked in git and resolves all paths from its
own location, so it works from any clone.

```powershell
cd api
.\sync.ps1                    # push code, restart the service
.\sync.ps1 -SetupKey          # one-time: install the deploy public key on the Pi
.\sync.ps1 -InstallService    # also install/enable the systemd unit
.\sync.ps1 -Status            # service status plus the tail of both logs
.\sync.ps1 -PiHost user@host  # override the target Pi
```

What it does, so the flow can be reproduced by hand or from another OS:

1. Ensures an ed25519 deploy key exists at `~/.ssh/smarttoolbox_pi_ed25519`, creating
   one if needed. A dedicated key keeps syncs passwordless without depending on your
   default SSH identity.
2. `scp -r` of `package.json`, `tsconfig.json`, `src/`, `public/`, `scripts/` to
   `~/smarttoolbox/` on the Pi. Missing paths are skipped, since git does not track
   empty directories.
3. Optionally installs `api/deploy/smarttoolbox.service` to
   `/etc/systemd/system/` and enables it.
4. Restarts the `smarttoolbox` service, falling back to a bare `bun run start` if the
   unit is not installed.

Note it does **not** sync `bun.lock` or `node_modules`; run `bun install` on the Pi
when dependencies change.

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
- **Connection**: Stacked on the XIAO ESP32S3 expansion header, communicating over I2C. **Verified on hardware 2026-08-27** - the link is up. This also means the header is occupied; see the Open Hardware Question under Pin Mappings.
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
- **Connection**: I2C, stacked on the XIAO expansion header. Verified 2026-08-27.
- **Interface**: I2C (SCL, SDA, VCC 3.3V, GND) — confirmed via Seeed documentation
- **Use Cases**: Tool identification (voice-requested lookup context and drawer-return detection)
- **Identification Method (default)**: On-device inference on the module's WiseEye2 MCU via a SenseCraft AI-deployed model (send only tool name/confidence to the API). Cloud vision model fallback (e.g., Claude, GPT-4o) if needed — see Feature 3.
- **Model status**: **none deployed.** The module is connected and responds, but no
  model trained on the actual tools has been flashed to it, so it produces no useful
  labels. This is the next firmware milestone and the blocker for Feature 3.
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

**Status: Partial** - the XIAO's own pins are confirmed on hardware. Peripherals that
are not yet wired have no pin assignment, and none is invented here.

### Confirmed

```cpp
// Onboard user LED. Active-low: LOW turns it ON, HIGH turns it OFF.
// Verified on hardware; see .github/instructions/xiao-esp32s3-firmware.instructions.md
#define LED_PIN           LED_BUILTIN   // GPIO21 on the XIAO_ESP32S3 board definition

// I2C to the Grove Vision AI V2. The module is stacked on the XIAO expansion
// header rather than cabled to a Grove port, so it sits on the board's default
// I2C pair and `Wire.begin()` needs no arguments.
//   SDA = D4, SCL = D5
// Confirm the GPIO numbers against the Seeed board doc in docs/SOURCES.md before
// relying on the numeric values rather than the D-labels.
```

Touch-capable exposed pads are GPIO1-9 (D0-D5, D8-D10). GPIO0 is the BOOT strapping
pin and is not usable as a touch input. `RST` and `BOOT` are physical buttons, not
touch pads.

### Not Yet Assigned

These parts are owned but unwired, because the Vision AI V2 occupies the expansion
header that would carry their GPIO. Assign pins when the expansion question below is
resolved - not before.

```cpp
#define PIR_SENSOR_PIN    TBD   // Grove PIR motion sensor, digital in
#define BUTTON_PIN        TBD   // Grove Red LED Button, push-to-talk
#define BUTTON_LED_PIN    TBD   // Same module, status indicator
#define MIC_DATA          TBD   // No microphone part selected yet
#define MIC_CLK           TBD
```

### Deliberately Absent

- **No per-row LED GPIO pins.** Row indication is the I2C 8x8 RGB matrix, addressed
  over the shared bus. Earlier drafts of this document defined `ROW_LED_1`..`ROW_LED_6`
  as GPIO data pins; that design was replaced by the matrix and those defines should
  not reappear. The WS2813 strip, which would need a real GPIO data pin, is deferred.
- **No per-drawer sensors.** Drawer open/close detection is one of three candidate
  methods in Feature 3 and no hardware has been chosen.

### Open Hardware Question (blocking)

The Vision AI V2 sits on the XIAO expansion header, which is where the PIR sensor,
button, and LED strip would otherwise connect. Options not yet evaluated:

1. Use the owned Seeed Expansion Board Base (SKU 103030356) and verify it stacks with
   the Vision AI V2.
2. Solder to the XIAO's remaining exposed pads directly.
3. Move the Vision AI V2 to a Grove cable and free the header.

Features 1 and 3 stay blocked until one is chosen.

## Communication Protocol

### XIAO ESP32S3 ↔ Raspberry Pi Zero 2 Communication
- **Method**: Wired **USB serial** (USB-C, CDC/ACM virtual serial port) for MVP. The XIAO also supports Wi-Fi and BLE, but neither is used near-term.
- **Physical link**: Xiao's USB-C cable plugged into a USB port on the Pi Zero 2 (e.g., appears as `/dev/ttyACM0` on the Pi)
- **Protocol**: Newline-delimited JSON. Every Xiao request has a unique `id`, `type: "request"`, a supported `endpoint`, and a `body`. The Pi echoes the same `id` in every response. The Bun implementation reads/writes the CDC ACM device directly without a native serial-port addon.
- **The tty must be in raw mode.** Linux enumerates a ttyACM in *cooked* mode with echo on, which silently breaks the link in both directions: everything the XIAO transmits is echoed back into its own receive buffer, and `onlcr` rewrites outgoing newlines. The symptom is one-way traffic - the Pi logs `request` and `response written` normally while the XIAO times out having received nothing. `configureRawMode` in `api/src/serialTransport.ts` shells out to `stty -F <device> raw -echo` on every connect, because the settings reset each time the device re-enumerates on replug or reset.
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

### API Server ↔ Transcription

**Status: Partial** - provider selection, persistence, and the reachability test are
implemented (`/api/settings/transcription`). Actual audio transcription is not, because
no audio source exists yet.

- **Default provider**: self-hosted Whisper on the NAS, `http://192.168.50.10:9000`
  (Swagger docs at `/docs`). Stored in `config` as `transcription_nas_url`.
- **Fallback provider**: OpenAI, selected by setting `transcription_provider` to
  `openai`. Requires `OPENAI_API_KEY` in the environment.
- **Reachability test**: `nas_whisper` probes `<nasUrl>/docs`; `openai` probes
  `/v1/models` with the configured key. Both use a 5-second timeout.
- **Timeout/Retry** for real transcription calls: 5-second timeout, 2 retries.

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
- No Wi-Fi power budgeting needed; the radio stays off in the MVP
- The XIAO is USB-powered from the Pi in the current design, so battery life is not
  yet a live constraint. Revisit if the toolbox is ever untethered.

## Firmware Architecture

```cpp
void setup() {
  // 1. Initialize USB serial (115200) and wait for the host
  // 2. Initialize I2C peripherals (Grove Vision AI V2; OLED and matrix once wired)
  // 3. Configure power management
  // 4. Run self-test
  // 5. Send the device/status boot request to the Pi
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

**Status: Implemented** - the notes below are from bringing the touch-to-lookup path
up on real hardware on 2026-08-27, not from a checklist.

- Serial output at 115200 baud.

### Where the logs actually are

The service does **not** log to the journal. `smarttoolbox.service` redirects both
streams to files, so `journalctl -u smarttoolbox` shows only systemd's own start/stop
lines and looks misleadingly empty:

```bash
tail -f ~/smarttoolbox/logs/service.log         # requests, responses, device debug
tail -f ~/smarttoolbox/logs/service-error.log   # serial errors only
```

`service-error.log` has **no timestamps**. Check `ls -l --time-style=full-iso` on it
before believing an error is current - a stale EACCES from an earlier unplug reads
exactly like a live one, and will send you after the wrong problem.

### Telling which side of the serial link is broken

The link fails one side at a time, and a half-open link looks healthy from the Pi.
`[serial] request id=req-N` followed by `[serial] response written id=req-N` only
proves the Pi's *write* succeeded; it says nothing about whether the XIAO received it.
When the device reports a timeout but the Pi log looks clean, check the link itself:

```bash
sudo lsof /dev/ttyACM0        # want both an FD ending in r and one ending in w
stty -F /dev/ttyACM0 -a       # want raw mode: -echo, -icanon, -opost
```

A read FD with no write FD means responses are being dropped. `echo` being on means
the device is receiving its own transmissions back - see Communication Protocol.

To prove the device's receive path independently of touch hardware, write a bench
command straight to it and watch for a resulting request in the log:

```bash
printf "lookup Claw Hammer\n" > /dev/ttyACM0
```

That command is ignored while the firmware is mid-lookup or mid-blink, so send it a
few times spaced a few seconds apart before concluding the receive path is dead.

### Reading the device directly from Windows

`arduino-cli monitor` exits immediately when its output is not a terminal, so it
cannot be captured to a file. Read the port with PowerShell instead:

```powershell
$p = New-Object System.IO.Ports.SerialPort 'COM6',115200,'None',8,'One'
$p.DtrEnable = $true; $p.ReadTimeout = 500; $p.Open()
```

Note that the Windows API never starts the serial listener (`SERIAL_DEVICE` is unset
off Linux), so a lookup sent while the XIAO is on the laptop always times out. That is
correct behavior, not a fault - the round trip can only be tested against the Pi.

## Development Workflow

1. Test individual sensors first
2. Add USB serial communication
3. Integrate with API server
4. Optimize power consumption
5. Field testing

## Libraries Required

Add to Arduino Library Manager:
- [x] ArduinoJson (7.4.3) - encoding and parsing the NDJSON serial messages. In use by
      `firmware/smarttoolbox/smarttoolbox.ino` for the `tools/lookup` request and response.
- [ ] Seeed_Arduino_SSCMA - I2C communication with the Grove Vision AI Module V2.
      Needed for Feature 3.
- [x] U8g2 (2.35.30) - the SSD1315 OLED. In use by `firmware/smarttoolbox/smarttoolbox.ino`
      for lookup status. The OLED is on the I2C connector directly; the hub is not needed for it.
- [ ] Grove 8x8 RGB LED Matrix driver library. Needed once the I2C hub is wired.
- [ ] FastLED or Adafruit_NeoPixel - **not needed.** These are for the deferred WS2813
      strip only; the matrix is I2C and does not use them.

## Feature Specifications

### Feature 1: Wake Mode (Motion-Activated)

**Status: Blocked** - the PIR sensor is owned but has nowhere to connect. See the Open
Hardware Question under Pin Mappings. The design below is unvalidated: no part of it
has run on hardware.

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

**Status: Blocked** - no microphone hardware has been selected, and the OLED and matrix
are not wired. The wake-word and Whisper pipeline below is design only; none of it has
been built or tested. The API half of the flow does exist and works today via
`GET /api/tools/lookup` and the `tools/lookup` serial endpoint, so the lookup can be
exercised from the dashboard without any of this.

A **bench harness** for the request half now exists in the firmware: a touch pad (or
the `lookup <tool name>` serial command) stands in for the microphone and drives the
real `tools/lookup` round trip, blinking the row number on the onboard LED because the
matrix is not wired. It is a stand-in for the voice flow, not a step toward it - the
wake word, Whisper, and matrix work below are all still unstarted.

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
   - **Decision**: two providers, selectable at runtime. Self-hosted Whisper on the NAS
     is the default; OpenAI is a fallback for when the NAS is down or its accuracy is
     not good enough. Whisper does not run on the Pi Zero 2 itself - 512MB is not
     enough RAM.
   - Default: `http://192.168.50.10:9000` (Swagger docs at `/docs`)
   - Stored in the `config` table as `transcription_provider` (`nas_whisper` |
     `openai`) and `transcription_nas_url`, so both can change without a redeploy.
     Configurable from the dashboard's Transcription Settings panel.
   - The OpenAI path requires `OPENAI_API_KEY` in the environment. The API reports
     whether it is present as `openaiApiKeyConfigured` but never returns the key.
   - **Tradeoff to keep in mind**: `nas_whisper` keeps audio on the LAN and costs
     nothing but needs the NAS up; `openai` is more accurate but sends audio off the
     network. Default to `nas_whisper` for anything routine.
   - Include timeout and retry logic (5-second timeout, 2 retries). The reachability
     probe in `POST /api/settings/transcription/test` already uses a 5-second timeout.

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

**Status: Blocked** - the Vision AI V2 is connected and the I2C link works, but **no
SenseCraft model is deployed**, so there is nothing to detect. Deploying a model
trained on the actual tools is the single next step that unblocks this feature. The
API side is ready: `POST /api/vision/observations` and the `vision/observe` serial
endpoint both accept and store detections today.

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

### Feature 4: Firmware OTA Updates (Wi-Fi Over-The-Air)

**Status: Planned** - Design complete; implementation to begin Phase 1 (estimated 3-4 weeks).
This feature enables wireless firmware updates via Wi-Fi, eliminating manual USB cable 
management after initial deployment.

**Purpose**: Enable secure, remote firmware updates for the XIAO ESP32S3 without requiring 
physical access or manual re-flashing.

**Architecture Overview**:

1. **Device-side (XIAO)**:
   - Wi-Fi credentials stored in ESP32 NVS (Non-Volatile Storage)
   - Initial setup via AP (Access Point) mode on first boot
   - Periodic update checks (hourly default) via serial to Pi
   - Built-in rollback via ESP32 bootloader on failure

2. **Server-side (Pi API)**:
   - Firmware version management and binary hosting
   - Update checks via new serial endpoints
   - Binary serving with checksum validation
   - OTA event audit trail

3. **Integration**:
   - Extend serial protocol with `device/ota-check`, `device/ota-confirm`, `device/ota-reset` endpoints
   - Add firmware version, history, and status tables to SQLite
   - Dashboard UI for checking updates and viewing history

**Hardware Requirements**:
- Wi-Fi capability (already on XIAO ESP32S3)
- 3.5MB free flash space for OTA partition (8MB XIAO has this)

**Firmware Bootstrap Process**:
1. **First boot**: Check for Wi-Fi credentials in NVS
2. **If missing**: Enter AP mode (SSID: `SmartToolbox-{MAC}`, password: `12345678`)
3. **AP mode**: Host simple HTTP form on port 80 to accept credentials
4. **On save**: Reboot and attempt Wi-Fi connection
5. **On failure**: Retry 3 times with backoff, then return to AP mode
6. **On success**: Begin hourly update checks via serial

**Update Flow**:
1. Device sends `device/ota-check` request with current version via serial
2. Pi queries latest available version from database
3. Pi responds with version + download URL + SHA256 checksum (if update available)
4. Device downloads firmware binary over Wi-Fi (streaming to avoid RAM exhaustion)
5. Device validates checksum during download
6. Device flashes to OTA partition using Arduino `Update` class
7. Device reboots with new firmware
8. Device sends `device/ota-confirm` within 30 seconds to complete update
9. If no confirmation, bootloader auto-rollback to previous partition on next boot

**Configuration**:
- OTA check interval: configurable via serial (default 3600 seconds / 1 hour)
- Automatic update: opt-in via serial config
- Update can be triggered manually from dashboard or via serial `device/ota-reset` command

**Safety Features**:
- Checksum validation mandatory before flash (SHA256)
- Bootloader-level rollback (automatic on crash, explicit via serial)
- Explicit confirmation required after update (proves device booted successfully)
- Previous version stored in NVS for easy rollback via dashboard
- Exponential backoff on failures (prevents server spam)
- Device MAC address included in check requests (audit trail)

**Error Handling**:
- Download interrupted: retry with exponential backoff (max 3 attempts)
- Checksum mismatch: abort, retry later
- Wi-Fi disconnected: queue check, retry next check cycle
- Insufficient storage: report via serial, abort
- Server unreachable: exponential backoff (10min → 20min → 1hr cap)

**Dependencies**:
- WiFi (ESP32 built-in)
- Update (ESP32 built-in)
- WiFiClientSecure (ESP32 built-in)
- Preferences (ESP32 built-in) - wrapper around NVS
- ArduinoJson (already required)

**Implementation Files**:
- `firmware/smarttoolbox/WiFiManager.h` - NVS storage, AP mode, Wi-Fi connection
- `firmware/smarttoolbox/OTAManager.h` - Version checking, download, flash, rollback
- `api/src/serialProtocol.ts` - New OTA endpoints
- `api/src/index.ts` - OTA request handlers and binary serving
- `api/src/db.ts` - New firmware_versions and device_ota_history tables

**API Endpoints (New)**:
```
GET  /api/firmware/latest          - Latest firmware version + metadata
GET  /api/firmware/v{version}.bin  - Download firmware binary (validated by device)
POST /api/device/ota-check         - Check for updates (serial endpoint)
POST /api/device/ota-confirm       - Confirm update success (serial endpoint)
POST /api/device/ota-reset         - Reset Wi-Fi config (serial endpoint)
GET  /api/device/ota-status        - Current device OTA status (HTTP endpoint)
GET  /api/firmware/history         - OTA event history (HTTP endpoint)
```

**Serial Protocol Extensions**:
```json
// Check for update (device → Pi)
{"id":"ota-1","type":"request","endpoint":"device/ota-check","body":{"firmwareVersion":"1.2.3","macAddress":"...","wifiConnected":true}}

// Response: update available
{"id":"ota-1","success":true,"body":{"available":true,"version":"1.3.0","url":"http://192.168.50.30:3000/api/firmware/v1.3.0.bin","size":524288,"checksum":"sha256:abc123..."}}

// Confirm update (device → Pi)
{"id":"ota-2","type":"request","endpoint":"device/ota-confirm","body":{"previousVersion":"1.2.3","newVersion":"1.3.0"}}

// Response
{"id":"ota-2","success":true,"body":{"acknowledged":true}}
```

**Database Additions**:
```sql
-- New tables for OTA system
CREATE TABLE firmware_versions (
  id INTEGER PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  release_date TEXT NOT NULL,
  release_notes TEXT,
  bin_path TEXT NOT NULL,
  checksum TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE device_ota_history (
  id INTEGER PRIMARY KEY,
  device_id TEXT,
  from_version TEXT,
  to_version TEXT,
  status TEXT CHECK (status IN ('pending','checking','downloading','flashing','success','rollback','failed')),
  error_message TEXT,
  timestamp TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE device_wifi_config (
  device_id TEXT PRIMARY KEY,
  ssid TEXT,
  configured_at TEXT,
  last_connected TEXT,
  ip_address TEXT
);
```

**Dashboard Features**:
- Display current firmware version
- "Check for Updates" button (manual trigger)
- Update history table (timestamp, version, status)
- Rollback button (if previous version available)
- Wi-Fi connection status indicator
- OTA status live indicator (idle, checking, downloading, flashing)

**Implementation Phases**:
- **Phase 1 (Week 1)**: Core infrastructure (WiFiManager, OTAManager, serial endpoints)
- **Phase 2 (Week 1-2)**: Device-side implementation (AP mode, update loop, Wi-Fi connection)
- **Phase 3 (Week 2)**: Server-side implementation (binary hosting, version management)
- **Phase 4 (Week 2)**: Rollback & safety (bootloader verification, confirm flow)
- **Phase 5 (Week 3)**: Dashboard UI (status display, update triggers, history)
- **Phase 6 (Week 3)**: Testing & documentation

**Estimated Effort**: 3-4 weeks (split across phases 1-3 for MVP; phases 4-6 follow)

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
  // 1. Initialize USB serial (115200 baud)
  // 2. Initialize I2C bus and peripherals (Vision AI V2, OLED, 8x8 matrix)
  // 3. Initialize camera illumination LED
  // 4. Initialize Wi-Fi (load credentials from NVS, connect or start AP mode)
  // 5. Load configuration from NVS/flash
  // 6. Configure interrupts (PIR motion detection)
  // 7. Run self-test (verify all hardware)
  // 8. Send device/status to Pi over serial
  // 9. Enter idle state (OTA checks run hourly in loop)
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
      // Check for OTA updates (hourly)
      // Check for timeout
      if (microphoneHasData()) {
        checkForKeyword();
      }
      if (wifiConnected && millis() - lastOTACheck > OTA_CHECK_INTERVAL) {
        checkForUpdates();  // Sends device/ota-check via serial
        lastOTACheck = millis();
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
1. **XIAO ESP32S3 → Pi Zero 2**: Tool queries, detections, telemetry (USB serial)
2. **Pi Zero 2 → XIAO ESP32S3**: Tool locations, commands, configuration (USB serial response)
3. **XIAO ESP32S3**: Drives the OLED and matrix directly from API responses
4. **Dashboard → Pi Zero 2**: Drawer and tool management, settings, request log (HTTP,
   same origin). This is the only path fully working end to end today.

The serial and HTTP paths share handlers deliberately: `handleSerialRequest` in
`api/src/index.ts` calls the same `db.ts` functions the HTTP routes do, so a lookup
behaves identically whether it arrives over the wire or the network.

### Row-Aware Inventory Lookup

- A drawer has an exact display `label` (such as `1A`, `1B`, `1C`, or `3`) and a `row_number`.
- The Pi keeps the latest observation for each detected tool type and drawer, including quantity, confidence, model version, and timestamp.
- `GET /api/tools/lookup?query=needle-nose%20pliers` returns exact `drawers` for the OLED and a `rows` list collapsed by `row_number` for the matrix. When several drawers in one row match, the row takes the highest available confidence. The `tools/lookup` serial endpoint returns the same payload.
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

## Phase 1: Foundation - complete
- [x] Set up basic API with health endpoint
- [x] Create database schema
- [x] Test basic hardware initialization on the XIAO (LED + touch)
- [x] Establish serial communication (`device/status` handshake)

## Phase 2: Core Features - in progress
- [x] Implement drawer and tool storage endpoints
- [x] Implement the row-aware lookup (`/api/tools/lookup`, `tools/lookup`)
- [x] Implement observation storage (`/api/vision/observations`, `vision/observe`)
- [x] Establish the Grove Vision AI to XIAO link over I2C (`Seeed_Arduino_SSCMA`)
- [x] Build the management dashboard
- [x] Serial reconnect (`api/src/serialTransport.ts` retries with backoff up to 5s, unlimited attempts)
- [x] Make the firmware send real `tools/lookup` requests (touch pad bench harness)
- [ ] **Next: deploy a SenseCraft model** so observations carry real labels
- [ ] Wire the I2C hub, OLED, and 8x8 matrix
- [ ] Make the firmware send real `vision/observe` requests

## Phase 3: Advanced Features
- [ ] Resolve the GPIO expansion question (unblocks PIR and button)
- [ ] Select microphone hardware
- [ ] Implement microphone recording and the chunked audio transfer protocol
- [ ] Optimize power consumption

## Phase 4: Polish
- [ ] Implement error recovery mechanisms
- [ ] Performance testing and optimization
- [ ] Documentation and deployment guides
