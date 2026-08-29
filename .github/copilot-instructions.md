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
- **Dashboard**: a three-page web UI served by the API, used to manage drawers, tools,
  and the device

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
│   ├── public/                   # Dashboard pages, shared app.css and app.js
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
- **Communication**: XIAO ESP32S3 → API Server over **wired USB serial** for all normal operation. Wi-Fi is used *only* for OTA firmware updates, during `setup()`, and the radio is switched off before `loop()` runs. BLE is unused.

### Hardware Bring-Up Status

Updated 2026-08-27. This table is the single place to check what is physically working.

| Component | Status | Notes |
|---|---|---|
| XIAO ESP32S3 standalone | Verified | LED (GPIO21, active-low) and touch pads confirmed on hardware |
| USB serial XIAO to Pi | Verified | `device/status` boot request reaches the Pi service |
| Touch-triggered `tools/lookup` | Verified | Full round trip on hardware: touch, request, response, LED blink, drawer label on the OLED |
| Wi-Fi OTA updates | Verified | Device pulled and installed 0.4.0 from the Pi over Wi-Fi. **Requires the external antenna** - without it the radio sees ~-85 dBm and cannot associate |
| Grove Vision AI V2 link | Connected | Stacked on the expansion header; I2C link up |
| SenseCraft model | Not deployed | **Blocks Feature 3.** Nothing to detect until a model is trained and flashed |
| OLED (Grove SSD1315 0.96") | Verified | On the I2C connector, GPIO5/GPIO6. Driven with U8g2 (`U8G2_SSD1306_128X64_NONAME_F_HW_I2C`); the SSD1315 is SSD1306-compatible. Shows lookup status and the exact drawer label |
| Grove 8x8 matrix | Verified | Wired and working. Idle purple face; thinking face while a lookup is in flight; then the outcome - see Matrix States. Mounted a quarter turn out, so the firmware sets `DISPLAY_ROTATE_270` every boot - that setting lives on the panel and survives power cycles |
| Microphone | Records on hardware; audio not yet confirmed | The XIAO's own PDM mic on the Sense board, fitted 2026-08-28. GPIO 42 clock, GPIO 41 data. Proven 2026-08-28 in 0.15.0: `Mic ready=1`, and a full 32,000-sample two-second read into PSRAM. The mic rides on a **positive DC bias** (samples run ~+981 to +2568, never crossing zero), so RMS must be taken about the mean - measuring raw samples reads the offset, not the sound. Corrected in 0.17.0. The remaining gate is `docs/PLAN-mic-bringup.md` Step 1: DC-corrected RMS multiplying when spoken into. The feature it feeds is `docs/PLAN-voice-lookup.md` |
| PIR motion sensor | Deferred | Needs two GPIO. No longer necessarily blocked - the Pi's 40-pin header is free; see the Open Hardware Question |
| Grove Red LED Button | **Mis-wired** | Currently plugged into the Grove I2C Hub, where it cannot work: it is a passive switch and LED with no I2C chip, so its two pins land on SDA and SCL. The LED is lit only because a bus line idles high. **Pressing it disturbs the I2C bus** the OLED and matrix depend on. Unplug it until it has real GPIO |
| Pi 40-pin GPIO header | Free, unpopulated | 26 usable GPIO, nothing in this project uses them. `gpioget`/`gpiomon` (libgpiod) are installed and `/dev/gpiochip0` is present - confirmed 2026-08-27 |

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
- **Sensors**: Vision (Grove Vision AI + OV5647) and the on-board PDM microphone on the Sense board; external IMU hardware is not yet selected
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
- [x] Implement Wi-Fi OTA firmware updates (see Feature 4 in Firmware Specifications)
- [ ] Wire the I2C hub, OLED, and 8x8 matrix
- [x] Select microphone hardware - the XIAO's own PDM mic on the Sense board, fitted 2026-08-28
- [ ] Prove the microphone on hardware (`docs/PLAN-mic-bringup.md` Step 1)
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

**A tool name is one identity, case-insensitively.** Every read has always compared with
`COLLATE NOCASE`, but the unique index was BINARY, so "Hammer" and "hammer" could sit in
one drawer while every lookup treated them as the same tool - producing duplicate rows a
user could not tell apart and, once the index changed, a read-back that silently returned
null. `idx_tools_drawer_name` is now `(drawer_id, name COLLATE NOCASE)`, and
`selectToolByDrawerAndName` and `upsertTool`'s conflict target match that collation.

The first startup on an older database merges existing case-duplicates within a drawer:
the oldest row survives and its capitalisation becomes the display form, quantities are
summed because they count the same tool, and the first non-empty notes field is kept. The
merge and the index swap happen in one transaction, and the fold is ASCII-only to match
what `NOCASE` actually does - `toLowerCase()` would merge pairs the index would still
consider distinct.

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
  -- Set when the tool is moved out of this drawer. Non-null rows are history:
  -- excluded from current-location and canonical-name queries, never deleted.
  superseded_at TEXT,
  FOREIGN KEY(drawer_id) REFERENCES drawers(id) ON DELETE CASCADE
);

-- Every API request, for the dashboard's Recent Requests panel. Serial requests
-- land here too, with method 'SERIAL' and path 'serial:<endpoint>'. Diagnostics,
-- not an audit trail: pruned to 30 days, and a failed write never changes an
-- API result.
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

-- What the XIAO has told the Pi. One row: the serial protocol carries no device
-- identifier, and there is one device on one wire, so the id is the constant 'xiao'.
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  firmware_version TEXT NOT NULL DEFAULT '',
  last_endpoint TEXT NOT NULL DEFAULT '',
  last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  boot_count INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Mutable runtime settings. Deploy-time settings stay in the environment.
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- NOCASE: tool names are one identity case-insensitively, which is how every
-- read has always compared them. See the Tool Identity note below.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tools_drawer_name ON tools(drawer_id, name COLLATE NOCASE);
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
framework. Hono was once a dependency and was never used for routing; it has been
removed, and the API now has no runtime dependencies at all.

### HTTP Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness check. Returns `{"status":"Ok"}` |
| GET | `/api/drawers` | All drawers with their tools and tool counts |
| POST | `/api/drawers` | Create a drawer (`name`, optional `label`, `rowNumber`). 400 when `rowNumber` is outside the configured row count |
| POST | `/api/drawers/:id/tools` | Add or update a tool in a drawer (upsert on name) |
| DELETE | `/api/drawers/:id` | Delete a drawer. **Cascades** to its tools *and* its `drawer_observations` history. 404 if the id does not exist |
| DELETE | `/api/drawers/:id/tools/:toolId` | Delete one tool **and its observations** for that drawer, in one transaction. Scoped by drawer, so a mismatched pair is a 404 rather than deleting a tool in another drawer |
| GET | `/api/tools/lookup?query=` | **Primary lookup.** Returns `primaryLocation` (the one location to act on), `hasMultipleLocations`, plus `drawers` and `rows` collapsed by certainty |
| POST | `/api/tools/assign` | **Move an existing tool to another drawer**, by `toolId`. 400 on a missing/invalid id, 404 on an unknown tool or drawer, 409 when the target drawer already holds that name. Does not create tools |
| POST | `/api/vision/observations` | Record camera detections for a drawer. **All or nothing**: the whole batch is validated before any of it is written, and written in one transaction |
| GET | `/api/firmware/latest?currentVersion=` | **OTA update check.** Requires an `X-Device-Key` header. 200 streams the newer `.bin`, 204 means already current, 401 rejects a bad key, 503 means `DEVICE_KEY` is unconfigured |
| GET | `/api/devices` | Device status: last contact, firmware version, boot count, plus the latest firmware on disk and whether the serial listener is running |
| GET | `/api/logs?limit=` | Recent request log (default 50, capped at 200). Includes serial traffic, logged with method `SERIAL` and path `serial:<endpoint>` |
| GET | `/api/settings/toolbox` | Toolbox row count and the panel's ceiling |
| PUT | `/api/settings/toolbox` | Set the row count. 400 outside 1-8, or when a drawer already uses a higher row |
| GET | `/api/settings/transcription` | Current transcription provider settings |
| PUT | `/api/settings/transcription` | Save provider and NAS URL |
| POST | `/api/settings/transcription/test` | Probe the configured provider |

Anything under `/api/` that does not match returns 404 JSON. Everything else falls
through to static files from `api/public/`. An extensionless path is tried as
`<path>.html` first, so `/drawers` and `/devices` resolve to their pages; `index.html`
remains the fallback for anything else.

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
  "primaryLocation": { "drawerId": 1, "label": "1A", "rowNumber": 1, "quantity": 2,
                       "confidence": 95, "observedAt": "2026-08-27 11:04:12" },
  "hasMultipleLocations": false,
  "drawers": [
    { "drawerId": 1, "label": "1A", "rowNumber": 1, "quantity": 2,
      "confidence": 95, "observedAt": "2026-08-27 11:04:12" }
  ],
  "rows": [ { "rowNumber": 1, "certainty": 95 } ]
}
```

**Display from `primaryLocation` and nothing else.** It is one location object, so the
row and the label it carries always describe the same drawer - which reading across
`rows` and `drawers` did not guarantee. See the invariant under Dashboard for what that
cost. `hasMultipleLocations` is true when the tool is on record in more than one drawer,
and the firmware appends a `+` to the OLED line rather than presenting one candidate as
the answer. `primaryLocation` is null only for a known tool with no location at all.

`drawers` and `rows` remain for callers that want every candidate: `drawers` carries the
exact labels, `rows` is collapsed so several matching drawers in one row produce a single
entry at the highest confidence. `confidence` is null when the tool is known from manual
entry but has never been observed by the camera.

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
                                     (DELETE of a tool is built - see HTTP Endpoints)
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

**Status: Implemented** - two pages under `api/public/`, sharing `app.css` (the whole
design, every colour a custom property on `:root` with a dark-mode override) and
`app.js` (`escapeHtml`, `setStatus`, `startHealthIndicator`).
Page-specific logic stays inline in each page. No build step, no framework, no
dependencies.

This is the primary way drawers and tools are managed today, and it is how the system
is usable at all while the firmware is unfinished.

**`index.html` - Dashboard**, served at `/`:

| Panel | Backed by |
|---|---|
| Stat tiles - drawers, tools, items on hand, drawers with a matrix row | `GET /api/drawers`, counted client-side |
| Toolbox Inventory - tools within each drawer | `GET /api/drawers`, `POST /api/drawers/:id/tools`, `DELETE /api/drawers/:id/tools/:toolId` |
| Transcription Settings | `GET`/`PUT /api/settings/transcription`, `POST .../test` |
| Recent Requests | `GET /api/logs?limit=40` |
| API Quick Reference | nothing - static text for the endpoints the page does not call |

**`drawers.html` - Drawers**, served at `/drawers`:

| Panel | Backed by |
|---|---|
| Add a drawer - name, optional label, optional matrix row | `POST /api/drawers` |
| Drawers - table with tool counts and delete | `GET /api/drawers`, `DELETE /api/drawers/:id` |

**`devices.html` - Devices**, served at `/devices`:

| Panel | Backed by |
|---|---|
| Stat tiles - firmware running, latest available, boots detected, last contact | `GET /api/devices` |
| XIAO ESP32S3 - version, last contact, last endpoint, uptime, boots detected | `GET /api/devices` |
| Device Activity - the device's serial requests | `GET /api/logs?limit=200`, filtered to `method = 'SERIAL'` |

The Devices page is **read-only, but "last contact" now means something.** The firmware
heartbeats every 30 seconds, so a last contact older than about a minute means the
toolbox is unplugged or wedged rather than merely idle. Restarts are counted from uptime
running backwards - see Communication Protocol for why the boot message is not trusted.

When no device row exists the page distinguishes two causes, using `serialDevice` from
`GET /api/devices`: the listener is running and the XIAO has not checked in, or this is
Windows and no listener was ever started. Blaming the device on a machine that never
opened the port would be a lie.

The split is deliberate: creating and destroying drawers is structural and rare, and
sat awkwardly next to the per-drawer tool forms it kept re-rendering. The Dashboard now
only ever adds and removes *tools*; drawer lifecycle lives on its own page. There is no
edit: the API has no `PATCH /api/drawers/:id`, so a drawer's name, label, and row are
fixed once created.

`app.js` sends the label and row number only when the fields are filled in, so `POST
/api/drawers` still defaults the label to the name and leaves `row_number` null.

`/drawers` resolves through `serveStaticFile`, which tries `<path>.html` for
extensionless requests before falling back to `index.html`. Adding a page means adding
the file and a nav link - no route in `serve()`.

**Deleting a tool must also delete its observations.** `selectCanonicalToolName`
UNIONs `drawer_observations`, and `selectToolLocations` matches on `tool.id IS NOT
NULL OR observation.drawer_id IS NOT NULL`, so a leftover observation keeps a deleted
tool answering `tools/lookup` at full confidence while the dashboard shows the drawer
empty - the device would keep pointing at a tool the user believes is gone, with
nothing in the UI revealing it. `deleteTool` handles both in one transaction; deleting
a drawer was never affected, since observations cascade on `drawer_id`. Guarded by
`api/src/db.test.ts`.

**Moving a tool must also supersede its old drawer's observations.** Same hazard as
deletion, on the other path. `selectToolLocations` admits a drawer when *either* a tool
row or a live observation points at it, so reassigning the tool row alone left the source
drawer reported as a current location - and reported as the *more confident* of the two,
because the stale observation carries the camera's confidence while the freshly moved
tool has none. The device would light the drawer the tool had just left. `assignToolToDrawer`
now sets `superseded_at` on the source drawer's observations in the same transaction as
the move, but only when no same-named tool remains there (`tools` is unique on
`(drawer_id, name)` under BINARY collation, so "Hammer" and "hammer" can share a drawer).

**A drawer's row must be one the panel can light, and the bound is configurable.**
Six is a fact about the toolbox in front of the matrix, not about the software, so it
lives in `config` as `toolbox_row_count` (default 6) rather than in the code. The API
rejected nothing before: a drawer could be created on row 99, the dashboard would show
it, and the device would silently fall into its "no row assigned" branch and light the
whole indicator band - saying *unknown* while the database said *row 99*.

`normalizeRowNumber` reads the setting at call time, so raising the count takes effect
without a restart, and the Drawers page takes the form's `max` from the same value.
`MAX_TOOLBOX_ROWS` is 8 because the panel is 8x8 - that ceiling *is* a property of the
hardware. Lowering the count is refused while a drawer still uses a higher row, naming
the drawers, rather than silently stranding them.

**The firmware still hardcodes rows 1-6** (`showMatrixRow`, and `MATRIX_FIRST_ROW_Y` /
`MATRIX_LAST_ROW_Y`, which reserve y=0 and y=7 as margins). Setting 7 or 8 rows is
therefore accepted and stored by the API but cannot yet be indicated by the device -
those rows fall into the same "no row" band. Teaching the sketch the count, and remapping
y to use the full panel when it exceeds 6, is outstanding work.

**An observation batch is all or nothing.** Both vision paths - HTTP and serial - go
through `recordDrawerObservations`, which validates every detection and every drawer id
before writing any of them, then writes the batch in one transaction. Inserting per
detection meant a batch whose third item was invalid left the first two committed and
still answered 400: the caller saw a failure, retried, and doubled the rows that had
already landed. Both paths call the same helper so their behaviour cannot drift.

**A displayed row and label must come from the same location object.** `drawers` and
`rows` are ordered independently: `drawers` comes back ordered by `row_number ASC` and
SQLite sorts NULLs *first*, while `rows` skips null row numbers entirely. Reading
`rows[0].rowNumber` beside `drawers[0].label` therefore paired a numbered drawer's row
with an unnumbered drawer's name - the OLED would read "Row 3  Drawer Odds and Ends" for
a tool that is in row 3 of a different drawer. `findToolLocations` now returns
`primaryLocation`, and the firmware reads label, row, and confidence from that object
alone. `hasMultipleLocations` marks the display with a `+` rather than presenting one
of several candidates as the answer.

The choice is `pickPrimaryLocation` in `api/src/db.ts`: a drawer with a row number beats
one without (the device can only indicate a row), then highest confidence with null
sorting last (never observed is not certainty), then lowest row number and drawer id so
the answer is stable rather than dependent on SQLite's row order. `drawers` and `rows`
are unchanged, so a device on older firmware behaves exactly as it did.

**Assignment is keyed on `toolId`, not on a name.** A tool name is not unique across
drawers, and the old name-based lookup took the lowest `id`, so asking to move "hammer"
could move a different drawer's "Hammer" - and then return `null`, because the read-back
was by `(drawer, name)` with no `COLLATE NOCASE`, which surfaced as a 400 for a write
that had already committed. The endpoint no longer creates tools by name; that is
`POST /api/drawers/:id/tools`. All of this is guarded by `api/src/db.test.ts`.

Deletes sit behind a `confirm()` on both pages. The drawer dialog, now on Drawer
Management, names the tool count and says that the observation history goes too,
because `drawer_observations` cascades on `drawer_id` as well and losing camera
history is not what "delete drawer" sounds like.

Neither page calls `/api/tools/lookup`, `/api/tools/assign`, or
`/api/vision/observations` - those exist for the firmware.

**Request logging must never change an API result.** Several routes log inside the same
`try` that performed the mutation, so a throw from the log write turned a completed
change into a 400 and invited the client to retry something that had already happened.
`writeRequestLog` swallows and reports its own failures. `request_logs` is pruned to 30
days from the write path - no timer to keep alive, and a server nobody is using does no
work. If the log is ever promoted to a real audit trail, that decision reverses: the
mutation and its entry would then belong in one transaction.

Note that the systemd unit still appends stdout and stderr to flat files under
`~/smarttoolbox/logs/`. Those are outside the database's retention and want logrotate or
journald on the Pi; nothing in this repo rotates them.

Because the pages are served from the same origin as the API, no CORS configuration is
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
| `DEVICE_KEY` | unset | Shared secret the XIAO sends as `X-Device-Key` on OTA update checks. **Fails closed**: while unset, `/api/firmware/latest` returns 503 and serves nothing. Must match `SECRET_DEVICE_KEY` in `firmware/arduino_secrets.h` |
| `NODE_ENV` | unset | Set to `production` by the systemd unit |

On the Pi these come from `~/smarttoolbox/.env`, loaded by the systemd unit via
`EnvironmentFile=-` (the `-` keeps the service starting when the file is absent).
Secrets go there rather than in `Environment=` lines, because
`api/deploy/smarttoolbox.service` is tracked in git. The file is gitignored and
`sync.ps1` never copies it, so it survives redeploys; `api/deploy/.env.example` is the
tracked template. Editing it needs `sudo systemctl restart smarttoolbox` to take effect.

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

### Releasing firmware for OTA

**Status: Implemented** - the device pulls and installs these images over Wi-Fi (see
Feature 4 in Firmware Specifications).

`api/scripts/release-firmware.ps1` replaces the manual `arduino-cli upload` trip to the
device. It owns both the version stamped into the sketch and the name of the built
file, because the device decides whether to update by comparing the two - letting a
human edit either one alone is how they drift apart.

```powershell
cd api\scripts
.\release-firmware.ps1 -Version 0.3.0          # stamp, compile, drop locally
.\release-firmware.ps1 -Version 0.3.0 -Push    # also copy it to the Pi
.\release-firmware.ps1 -Version 0.3.0 -Force   # overwrite an existing version
```

1. Rewrites `#define FIRMWARE_VERSION "x.y.z"` in `firmware/smarttoolbox/smarttoolbox.ino`.
   That exact line shape is the anchor - do not reformat it.
2. Compiles for `esp32:esp32:XIAO_ESP32S3` into a temp build directory.
3. Copies the result to `api/firmware/smarttoolbox-<version>.bin` (gitignored).
4. With `-Push`, `scp`s it to `~/smarttoolbox/firmware/` on the Pi using the same
   deploy key as `sync.ps1`.

It refuses to overwrite an existing version without `-Force`, and warns if a newer
image is already in the drop folder, since devices would keep pulling that one instead.

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

**Main Controller**: Seeed **XIAO ESP32S3 Sense** (not the plain XIAO ESP32S3 - see
`docs/xiao-screenshot.PNG` for the exact part)
- **MCU**: Espressif ESP32-S3
- **Connectivity**: Wi-Fi and BLE are available; the MVP connects to the Pi Zero 2 over **wired USB serial** (USB-C, CDC/ACM), not Wi-Fi
- **Memory**: 8MB PSRAM, 8MB flash. **PSRAM is on as of 2026-08-28**, and was off before that: a bare `esp32:esp32:XIAO_ESP32S3` takes the first entry of every board menu, and for PSRAM that is `disabled`, so `ps_malloc` returned null in every binary this repo had released. `release-firmware.ps1` now compiles `esp32:esp32:XIAO_ESP32S3:PSRAM=opi`; verify with `arduino-cli compile --show-properties`, where the bare fqbn shows an empty `build.defines` and the corrected one shows `-DBOARD_HAS_PSRAM`. **Any manual `arduino-cli` invocation must carry `:PSRAM=opi` too** - the microphone buffer cannot be allocated without it, and the failure presents as a dead mic rather than a build error.
- **Power**: 3.3V, rechargeable battery support
- **Physical stack, confirmed 2026-08-28.** Three boards, three different connectors, all
  fitted at once. Recorded because an earlier revision of this document asserted they
  competed and that assertion drove decisions for weeks:

```
   Sense board        camera (OV2640) + PDM mic, facing up
        |             board-to-board connector
   XIAO ESP32S3       the core board
        |             expansion header
   Grove Vision AI V2 stacked below, I2C
```

  `docs/xiao-screenshot.PNG` is the vendor photo showing the camera on the top face. The
  Sense board does **not** use the expansion header, so it has never been in competition
  with the Vision AI V2.

- **Built-in Sensors**: a **PDM digital microphone** and an **OV2640 camera**, both on the Sense board, which mates through the dedicated board-to-board connector rather than the expansion header - see the stack above. Neither has ever been initialised by this project's firmware. IMU is still external and unselected.

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

### Microphone (On board)
- **Type**: The XIAO's own digital microphone, on the **Sense expansion board**. No
  external part is needed or planned. **Attached as of 2026-08-28, alongside the Vision
  AI V2** - they use different connectors and do not conflict.
- **Interface**: PDM. Pins are fixed by the board, confirmed against Seeed's own
  documentation: **GPIO 42 = clock, GPIO 41 = data.**
- **Sample Rate**: 16 kHz mono, 16-bit. Not a preference - the ESP32-S3 supports *only*
  PDM mono at 16-bit, so the bit width and slot mode are the chip's, not a choice. The
  rate is adjustable; Seeed reports 16 kHz as the stable one, and it is also what Whisper
  wants, so there is no reason to move it.
- **Library**: `ESP_I2S.h` from the installed esp32 core (3.3.11), *not* the core-2.x
  `I2S.h` that Seeed's published examples still lead with. The two have different APIs
  and picking the wrong page is the likely first failure:

```cpp
// Core 3.x - what this project has.
I2S.setPinsPdmRx(42, 41);
I2S.begin(I2S_MODE_PDM_RX, 16000, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO);
```

- **Two ways to read, and they are not interchangeable.** `recordWAV(seconds, &size)`
  returns a `ps_malloc`'d buffer with a WAV header already attached, but takes a fixed
  duration - fine for a bring-up, useless for hold-to-talk, where the length is not known
  when recording starts. That path reads in a loop instead and lets the Pi write the
  header. See `docs/PLAN-mic-bringup.md` and `docs/PLAN-voice-lookup.md`.
- **Buffers go in PSRAM.** Seeed's own example uses `ps_malloc` for exactly this reason:
  four seconds of 16 kHz 16-bit mono is 128 KB against the XIAO's 320 KB of SRAM, of
  which this sketch already uses 49 KB.
- **Status**: attached but never initialised by this project's firmware. Bring it up in
  isolation first - an uninitialised mic and a mic returning silence are
  indistinguishable everywhere else in this system.
- **Use Cases**: push-to-talk tool lookup (Feature 2). A wake word is out of scope.

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

**WS2813 Strip (Planned - this is where row indication is going)**:
- **Type**: Grove WS2813 RGB LED Strip Waterproof, 30 LEDs/m, 1 m (SKU 104020108). Owned.
- **Interface**: Single-wire data signal **from the Pi**, not the XIAO. See the Row
  Indication decision under Open Hardware Question.
- **Power**: External regulated 5V supply, sized for up to 1.8A at full white. Common
  ground with the Pi. Do not run the strip from the Pi's 5V pin.
- **Levels**: the Pi drives 3.3V and the strip wants 5V logic. Usually works, sometimes
  flaky; a 74AHCT125 is the proper fix.
- **Status**: Planned. Not wired, no code.

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
```

The microphone used to sit in this list. It does not belong here: it is on the Sense
board's underside connector, not the expansion header, so it was never blocked by the
Vision AI V2. Its pins are fixed by the board and recorded under Microphone below.

### Deliberately Absent

- **No per-row LED GPIO pins.** Row indication is the I2C 8x8 RGB matrix, addressed
  over the shared bus. Earlier drafts of this document defined `ROW_LED_1`..`ROW_LED_6`
  as GPIO data pins; that design was replaced by the matrix and those defines should
  not reappear. The WS2813 strip needs a real data pin and is planned on the *Pi's*
  header, not the XIAO's - see the Row Indication decision under Open Hardware Question.
- **No per-drawer sensors.** Drawer open/close detection is one of three candidate
  methods in Feature 3 and no hardware has been chosen.

### Open Hardware Question

**Revised 2026-08-27.** This section used to say Features 1 and 3 stayed blocked until
the XIAO's expansion header was freed. That framing was wrong, and it was wrong because
of an assumption nobody had stated: **that GPIO has to come from the XIAO.** It does
not. The Pi Zero 2 W's 40-pin header is entirely unused - 26 usable pins - and the Pi is
already in the box, already running, and already talking to the XIAO.

**Corrected 2026-08-28.** This section used to say the Vision AI V2 and the Sense board
compete for the same space and that only one could be there. **That was wrong, and it had
been shaping decisions.** They use different connectors: the Sense board mates with the
XIAO's dedicated board-to-board connector and carries the camera and mic on top, while
the Vision AI V2 stacks on the expansion header below. **Both are fitted and both work.**

What remains true is narrower and unchanged: **the Vision AI V2 occupies the expansion
header**, so parts wanting GPIO from it - the PIR, the Red LED Button - still have
nowhere to go. That is the only conflict, and the options below address it.

Two things follow from the correction:

- **The microphone was never blocked.** Its pins are fixed by the Sense board - GPIO 42
  clock, GPIO 41 data - and are recorded under Microphone. `docs/PLAN-mic-bringup.md`
  can start.
- **The Expansion Board Base (SKU 103030356) is still out, but not for the reason
  recorded earlier.** It is a carrier the XIAO plugs into, so it wants the expansion
  header the Vision AI V2 is using; it has no quarrel with the Sense board. The buzzer it
  carries is the only sound hardware owned, so sound still means putting a transducer on
  the Pi - the same conclusion as the LED strip, reached by a different route.

**Options, and what each costs:**

| Option | Cost | Gets you |
|---|---|---|
| **Put GPIO parts on the Pi's header** | Two wires per part, or a Grove Base Hat for Pi Zero (SKU 103030276, ~$6) for solderless Grove ports | Button and PIR both work, with no XIAO surgery. Costs a Pi-to-XIAO message for anything the firmware must react to |
| **Touch pads on the XIAO** | Nothing | A trigger with no connector at all. D0 is proven. Not a mechanical button feel |
| Seeed Expansion Board Base (SKU 103030356, owned) | Wants the expansion header the Vision AI V2 is on - so it costs the camera, not the mic | Grove I2C and a digital port without soldering, plus the only buzzer owned |
| Solder to the XIAO's exposed pads | One soldering session | Everything on one device, no cross-device coordination |
| Move the Vision AI V2 to a Grove cable | A cable | Frees the header - but the hub currently chains off the Vision AI's Grove port, so this also moves the I2C path |

### Decision: row indication moves to the LED strip, driven from the Pi

**Status: Planned** - decided 2026-08-28. Nothing is wired and no code exists.

The 8x8 matrix indicates a row by lighting matrix row N for toolbox row N. That has two
faults, and they are the same fault seen from different sides:

- **It caps at eight.** The unit of meaning is the panel's own height, so a toolbox with
  more rows than the panel has cannot be addressed at all. `MAX_TOOLBOX_ROWS` is 8 for
  this reason - it is a symptom of the design, not a hardware limit worth keeping.
- **It is hard to read.** A single lit row gives the eye no scale to count against, so it
  reads as "higher" or "lower" rather than as row 3. Every fix for that - a ruler column,
  a sweep animation, filling to the row - adds machinery to make a number legible that
  the box should not have been asking anyone to read.

The WS2813 strip removes both by not encoding position at all. One LED sits beside each
row, so the light **is** the answer; nobody counts anything, and thirty LEDs is thirty
rows. Grid coordinates on the matrix were considered - the existing `1A`/`1B`/`1C` labels
are already a row and a column - and rejected: it scales only to 64, still has to be
read, and costs a schema change for a column concept the strip makes unnecessary.

**The strip hangs off the Pi, not the XIAO.** The XIAO's expansion header is occupied by
the Vision AI V2, which is the same wall the PIR and the Red LED Button hit, and the
answer is the same one this section already reached: the Pi's 40-pin header is unused.

**This needs no protocol change, which is the surprising part.** Everything else
interactive is blocked on the device speaking first - see Communication Protocol. Row
indication is not. The Pi already receives `tools/lookup`, already computes the `rows`
array, and can light the strip inside `handleSerialRequest` before it composes the
response. The one output that ought to be hardest to move is the one that moves for free.

**Drive it over SPI, not `rpi_ws281x`.** The usual library uses PWM+DMA on GPIO18 and
ships as a native addon; the API is Bun, and native Node addons under Bun are a gamble
worth not taking. Encoding each WS2812 bit as three SPI bits at ~2.4MHz and writing the
buffer to `/dev/spidev0.0` is plain file I/O - no native module, no root, and the strip
stays inside the existing Bun process instead of behind a Python sidecar.

**What this does to the other outputs.** Each ends up with one job and no overlap:

| Output | Job |
|---|---|
| WS2813 strip | Points at the row, physically |
| 8x8 matrix | The face: idle, thinking, not found, not understood |
| OLED | Names the exact drawer - `1A` against `1B`, which the strip cannot distinguish |

Once the strip exists the matrix stops encoding numbers, so the digit phase and
`MATRIX_RESULT_ROW_MS` can go. Do not invest further in making the matrix legible as a
row indicator; that work is superseded by this decision.

**Do not connect a passive Grove module to the I2C Hub.** Every Grove connector is the
same four-pin shape, but an I2C port's two signal pins are SDA and SCL. A module with no
I2C chip - the Red LED Button, the PIR - cannot be addressed there, and its switch pulls
on a line the OLED and matrix are using. See the Grove Red LED Button row in the
Hardware Bring-Up table for what that looks like in practice.

**Current decision**: touch pad for the voice trigger, no new hardware. See
`docs/PLAN-voice-lookup.md`, Decision 2.

## Communication Protocol

### XIAO ESP32S3 ↔ Raspberry Pi Zero 2 Communication
- **Method**: Wired **USB serial** (USB-C, CDC/ACM virtual serial port) for all request traffic. Wi-Fi carries OTA firmware updates only, during `setup()`; BLE is unused.
- **Physical link**: Xiao's USB-C cable plugged into a USB port on the Pi Zero 2 (e.g., appears as `/dev/ttyACM0` on the Pi)
- **Protocol**: Newline-delimited JSON. Every Xiao request has a unique `id`, `type: "request"`, a supported `endpoint`, and a `body`. The Pi echoes the same `id` in every response. The Bun implementation reads/writes the CDC ACM device directly without a native serial-port addon.
- **The tty must be in raw mode.** Linux enumerates a ttyACM in *cooked* mode with echo on, which silently breaks the link in both directions: everything the XIAO transmits is echoed back into its own receive buffer, and `onlcr` rewrites outgoing newlines. The symptom is one-way traffic - the Pi logs `request` and `response written` normally while the XIAO times out having received nothing. `configureRawMode` in `api/src/serialTransport.ts` shells out to `stty -F <device> raw -echo` on every connect, because the settings reset each time the device re-enumerates on replug or reset.
- **Initial endpoints**:
  - `device/status`: heartbeat. Firmware version and `uptimeMs`, sent at boot and then
    every 30 seconds. Fire and forget - the firmware does not wait on the reply.
  - `tools/lookup`: Xiao sends recognized or transcribed text; Pi returns matching drawer labels and row indicators.
  - `vision/observe`: Xiao sends `drawerLabel`, model version, and a `detections` array of tool-type labels, confidence, quantity, and optional bounding boxes.
- **The device speaks first, always.** The protocol models requests from the XIAO and
  responses from the Pi; there is no Pi-initiated message type and the transport only
  ever writes responses. Nothing on the dashboard can push to the device. Any future
  control - "check for updates now", "use this Wi-Fi" - has to be queued and collected
  on the device's next request. **That is now practical**: `device/status` repeats every
  30 seconds (`DEVICE_STATUS_INTERVAL_MS`), so a queued command waits at most one
  interval instead of until the next reboot or touch.
- **The boot announcement cannot be relied on, and the design assumes it will be lost.**
  It is sent from `setup()`, while the USB serial port is still re-enumerating after a
  reset, so the Pi is often mid-reconnect-backoff and never sees it. This is not
  hypothetical: `boot_count` sat at zero through several confirmed reboots on hardware,
  and the OTA debug output for one of those boots is absent from the journal for the same
  reason. **Restarts are therefore detected from `uptimeMs` running backwards**, which
  rides on every heartbeat and so survives a lost announcement. `recordDeviceContact`
  owns that comparison; `millis()` wrapping at ~49.7 days reads as one spurious reboot,
  which is the accepted cost.
- **Heartbeats are not written to `request_logs`.** At one every 30 seconds they would
  add ~2,880 rows a day and bury the requests a person actually wants to read. The
  `devices` table already holds everything a heartbeat carries. Every other serial
  endpoint is still logged.
- **Every serial request is recorded.** `handleSerialLine` calls `recordDeviceContact`
  before dispatching - a request that is then rejected is still proof the XIAO is on the
  wire - and logs the outcome to `request_logs` with method `SERIAL`. Only
  `device/status` counts as a boot, and only it carries `firmwareVersion`, so the upsert
  must not let the other endpoints' empty string blank out the stored version. Guarded
  by `api/src/db.test.ts`.
- **Successful response**: `{"id":"req-001","success":true,"body":{...}}`
- **Error response**: `{"id":"req-001","success":false,"error":{"code":"INVALID_REQUEST","message":"drawer_label is required"}}`
- **Audio**: **Status: Planned.** Push-to-talk audio is carried on this same link as a single base64 line on a `voice/audio` request - raw 16 kHz 16-bit mono PCM, roughly 171 KB of base64 for four seconds. The recording runs for as long as the button is held (300 ms minimum, 10 s cap), so its length is not known when the transfer starts: the device sends samples plus `sampleRate`/`channels` and **the Pi prepends the WAV header**. An earlier draft of this document called for a separate chunked transfer protocol; that was reconsidered and rejected in `docs/PLAN-voice-lookup.md`, which records why (a chunked protocol needs reassembly state, partial-upload timeouts, and a resync path, where a single line needs only a retry - and the retry is pressing the button again). Raw binary framing was also rejected: the transport splits on newlines and PCM is full of `0x0A`. This means `SerialLineBuffer` must grow a maximum line length, and the `[serial-debug]` log must truncate.
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

### Startup Readiness

**Status: Implemented** - `startWaitingForPi` / `promoteToReady` /
`pollWaitingRetry` / `pollWaitingLong` in `firmware/smarttoolbox/smarttoolbox.ino`.
Written 2026-08-29, **not yet run on hardware**; see `docs/PLAN-startup-readiness.md`.

Both halves of the box boot from the same power and do not arrive together:

| | time from power-on |
|---|---|
| XIAO starts asking for a firmware update | ~3.5s |
| XIAO gives up on that check (25s Wi-Fi timeout) | ~30s |
| **Pi finishes booting** (5.2s kernel + 31.4s userspace) | **36.6s** |
| Pi's API accepts its first request | later still |

The device used to say `Ready` for that whole window and mean nothing by it. A touch
went into a void and painted `No response - Is the Pi service up?`, which is a question
it is not entitled to ask while the Pi is merely booting, and the boot `device/status`
went to a port nobody had open, so the dashboard showed no firmware version at all.

The fast half waits. **No change to the Pi** - there is nothing it can do about a
31-second userspace, and a device that copes is worth more than a server that hurries.

- `setup()` ends in **WAITING**, not READY, and enters it **before** the OTA check.
  That check blocks for up to `WIFI_CONNECT_TIMEOUT_MS`, so entering WAITING at the end
  of `setup()` would put the spinner up at ~30s - six seconds before the Pi answers, in
  the one case the state exists for.
- While waiting, `device/status` goes out every **2 seconds** (`WAITING_RETRY_MS`),
  deliberately without the `awaitingResponse` guard `pollDeviceStatus` uses: that guard
  is right for a heartbeat and fatal here, where one unanswered request would wedge the
  device in WAITING forever.
- **Any parsed reply promotes**, success or error. This is about proving the wire works
  end to end, not about the Pi liking the message.
- Touches during WAITING do not send lookups. The guard sits *inside* the lookup path,
  not at the top of `onTouchStart`, because with `MIC_BRINGUP` set the pad records
  instead and recording never involves the Pi.
- **No timeout that gives up.** Past `WAITING_LONG_MS` (90s) the spinner stops and the
  face drops, but the retry continues - a change of expression, not a failure state.
  `pollWaitingLong` runs from `loop()`, deliberately not from `updateMatrix`: that
  function returns early when no matrix is attached, and a box with no matrix is exactly
  the one whose OLED needs to say something.

**`handleIncomingLine` parses before it checks `awaitingResponse`, and that ordering is
load-bearing.** `sendDeviceStatus` never claims the pending slot - by design, so a
heartbeat cannot cancel a lookup someone is waiting on - so with the guard first, the
Pi's reply to it was dropped before anything looked at the line. The handshake this
whole path waits for could not arrive. Anything that reorders that function must keep
the parse first.

**`reportLastOtaResult` fires from `promoteToReady`, not from the first heartbeat.**
Promotion is the moment a host is provably reading; the first heartbeat was an
approximation of it that the 2-second waiting retry invalidates. See OTA Updates for why
the boot-time OTA log has to be held at all.

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

### Verifying a secret is really untracked

`git check-ignore -v <path>` is **not** a reliable check on its own. It exits 0 when
*any* pattern matches, including a negation like `!.env.example`, so a file that is
very much trackable can look ignored. Ask the question that actually matters instead:

```bash
git add --dry-run <path>       # "The following paths are ignored" = safe
git ls-files --error-unmatch <path>   # errors = not tracked
git log --all -p | grep -F '<the secret>'   # nothing = never committed
```

The last one is the only check that covers history. Untracking a file with
`git rm --cached` stops future commits but does nothing about the ones already made -
if a real secret was ever committed, it stays in history until the history is rewritten,
and it should be rotated rather than trusted.

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
- [x] `Seeed_RGB_Led_Matrix` (1.0.0) - the Grove 8x8 RGB matrix. In use by
      `firmware/smarttoolbox/smarttoolbox.ino` for the row indicator and the idle face.
      The driver is frame-based, not pixel-addressed: `displayFrames` takes 64 bytes,
      one **palette index** per pixel, and blank is `0xFF` - zeroing the buffer lights
      the panel red.
#### Matrix States

**Status: Implemented** - `updateMatrix` in `firmware/smarttoolbox/smarttoolbox.ino`.
Four modes: `MATRIX_WAITING`, `MATRIX_EYES`, `MATRIX_THINKING`, `MATRIX_RESULT`. The
listening state below is the one exception and is marked as such.

| State | Shown | Colour | Meaning |
|---|---|---|---|
| Waiting | A 16-cell ring with six lit, turning one step every 90ms | Purple, white leading cell | Powered on, the Pi has not answered yet |
| Still waiting | The spinner stops; face with a frown | Purple | Past 90s with no reply - not an error, see Startup Readiness |
| Idle | Face with a smile, blinking every 2-6s | Purple | Nothing happening |
| Listening | **Status: Planned.** An irregular 8-column wave, one step every 100ms | Ramped cyan/blue/purple/pink by row | Recording while the pad is held - see `docs/PLAN-mic-bringup.md` |
| Thinking | Mismatched eyes - the left a row taller than the right - and a mouth cycling through 0-3 dots every 280ms | Purple | A lookup is in flight |
| Found | The lit row for 2s, then the row digit for 4s | Green / orange by certainty | The tool is in that row |
| Found, no row | The whole indicator band | Green / orange by certainty | Known drawer, no row assigned |
| Not found | Face with a frown | Red | Understood the word, the tool is in no drawer |
| Not understood | Question mark | Orange | The Pi could not interpret the request |
| No response | A filled triangle with the exclamation mark knocked out | Red | The Pi never answered within the timeout |

The waiting spinner is deliberately not a face. The idle smiley means "I am fine"
everywhere else in the sketch, and during the boot window the box is not fine - it is
early. Six of the ring's sixteen cells are lit so the gap is what reads; the leading
cell is white because a uniform arc does not say which way it is turning.

The alert triangle is filled with the exclamation mark left *unlit* rather than drawn.
At 8x8 an outline triangle loses its shape and a drawn-on mark has nowhere to sit. It
replaced a solid red band, which was the loudest thing the panel can do and the least
specific - it said "bad" and nothing else, and read more like a hardware fault than a
message.

The digit gets twice the row's time: it is the half you have to read and carry to the
box, and two seconds was gone before you had looked up. The faces and the alert band
have no second phase and nothing to read, so they hold on `MATRIX_NOTICE_HOLD_MS`
rather than inheriting the digit's.

The thinking face's eyes are deliberately mismatched, the trick Cozmo and Vector use:
asymmetry reads as quizzical where two matched eyes read as merely awake. Both eyes
share a baseline so the left one looks like it is widening, not like the face is
sliding. Purple stays out of the result palette so the idle and thinking faces can
never be read as an answer. The thinking face is held for exactly as long as `awaitingResponse`
- every exit from it (answer, rejection, timeout) sets another mode, so there is no
timer to fall out of sync.

**The row indicator is on its way out.** Lighting matrix row N for toolbox row N caps at
eight rows and is hard to read - see the Row Indication decision under Open Hardware
Question. The face states below are unaffected and are what the matrix keeps.

**Not found and not understood are different answers and must look different.** All
three failure paths used to draw the same red band, so "it isn't in any drawer", "I
could not make sense of that", and "the Pi is not responding" were indistinguishable
from across a workshop. The last of those is now a triangle rather than a band, so no
two of them share a picture at all. The frown is the idle smile inverted, which reads as the box's
own reaction; the question mark is deliberately *not* a face, because failing to
understand the word is a different kind of statement from having no answer to it.

Once voice lands, a failed transcription surfaces as a `success: false` response and so
gets the question mark for free - that is the case it was drawn for.

- [ ] FastLED or Adafruit_NeoPixel - **not needed, and now never will be.** These are
      Arduino libraries for the WS2813 strip, which is planned on the Pi rather than the
      XIAO; the Pi drives it over SPI from the Bun process. The matrix is I2C and has
      never used them.

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

**Status: Partial** - the microphone is no longer the blocker: it is the XIAO's own PDM
mic on the Sense board, and the firmware initialises it as of 2026-08-28, though that
code has not yet been run on hardware. The matrix is wired; the LED strip that row
indication is moving to is not. The wake-word and Whisper pipeline below is design
only; none of it has been built or tested. The API half of the flow does exist and
works today via `GET /api/tools/lookup` and the `tools/lookup` serial endpoint, so the
lookup can be exercised from the dashboard without any of this.

`docs/PLAN-voice-lookup.md` is the implementation plan for this feature. It uses the
XIAO's **on-board PDM microphone**, and the audio travels to the Pi **over the USB serial
link** as a single base64 line on a new `voice/audio` endpoint - not over Wi-Fi, so the
radio keeps its one job of OTA updates and the voice path depends on only one device
being on the network. The plan re-scopes the wake word out in favour of the push-to-talk
button, and orders the work so the transcript-to-tool matching - the only genuinely hard
part - is built and tested first, with no hardware.

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

**Status: Implemented** - working end to end as of 2026-08-27. The device pulled
`smarttoolbox-0.4.0.bin` (1,046,256 bytes) from the Pi over Wi-Fi, verified it, rebooted
into it, and reported `currentVersion=0.4.0` on the next check. No cable involved.

The design below describes a broader system (AP-mode provisioning, rollback tracking,
a `firmware_updates` table). What is actually built is deliberately smaller:

- `GET /api/firmware/latest?currentVersion=X` on the Pi, guarded by `X-Device-Key`.
- A drop folder at `~/smarttoolbox/firmware/`, filled by `api/scripts/release-firmware.ps1`.
- A check in the firmware's `setup()` only. Wi-Fi is joined, the check runs, and the
  radio is switched off again before `loop()` starts - USB serial remains the link for
  all normal operation.
- No AP-mode provisioning and no update history table. Credentials come from
  `arduino_secrets.h` at compile time.

**Untested:** recovery from a transfer interrupted mid-write. The mechanism is sound -
the ESP32 writes to the inactive OTA slot and `Update.end(true)` only marks it bootable
after verifying the image - but that path has not been deliberately exercised.

**Hardware requirement:** the external antenna must be attached. See
`.github/instructions/xiao-esp32s3-firmware.instructions.md`.

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
- [x] Select microphone hardware - the XIAO's own PDM mic on the Sense board, fitted 2026-08-28
- [ ] Prove the microphone on hardware (`docs/PLAN-mic-bringup.md` Step 1)
- [ ] Carry the audio to the Pi as a single base64 line (the chunked protocol was rejected - see Communication Protocol)
- [ ] Optimize power consumption

## Phase 4: Polish
- [ ] Implement error recovery mechanisms
- [ ] Performance testing and optimization
- [ ] Documentation and deployment guides
