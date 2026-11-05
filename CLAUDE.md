# SmartToolbox

A physical toolbox that tells you which drawer a tool is in. A XIAO ESP32S3 talks to a
Raspberry Pi Zero 2 over USB serial; the Pi runs a Bun/TypeScript API over SQLite, and
serves a web dashboard used to manage toolboxes, drawers, tools and the device.

## Where things are documented

This file holds what applies everywhere. The rest of the spec is in `.claude/rules/`,
and each file loads only when you work on the paths it covers:

| Rule file | Loads for | Covers |
|---|---|---|
| `api.md` | `api/**` | Stack, database schema and migrations, every HTTP endpoint, the lookup response, data invariants, configuration |
| `dashboard.md` | `api/public/**` | The four pages and what backs each panel |
| `serial-protocol.md` | `api/src/**`, `firmware/**` | The NDJSON serial protocol, device commands, audio, transcription, data flow |
| `firmware.md` | `firmware/**` | The board's traps, building and flashing, firmware architecture, startup readiness, libraries, matrix states |
| `features.md` | `firmware/**` | Wake mode, voice lookup, vision, OTA, and the planned state machine |

Read the relevant rule file before a change that reaches past the paths it loads for -
a change to `db.ts` that alters what the device displays, for instance.

- **`docs/HARDWARE.md`** is the hardware record: every part owned, whether it
  physically works (the Bring-Up Status table), and which pin carries it. Read it
  before wiring anything or before assuming a component is live.
- **`docs/PLAN-*.md`** are implementation plans, each with a `status:` field in its
  frontmatter saying whether it is still active. Plans written before 2026-11-04 refer
  to the spec as `.github/copilot-instructions.md`; its sections kept their titles when
  they moved into the rules files.

## The status-tag convention

The spec mixes what is built with what is designed but not yet built. Every major
section carries a status line so the difference is never ambiguous:

- **Status: Implemented** - the code exists and runs. File references point at it.
- **Status: Partial** - some of it runs; the section says which part.
- **Status: Planned** - designed here, not written yet.
- **Status: Blocked** - planned, and something concrete is in the way. The blocker is named.

They are load-bearing. `Planned` means the code does not exist yet, however concrete
the surrounding design looks - do not assume a documented endpoint is real. **Keep the
tags current in the same commit as the code change.** A stale tag is worse than no tag,
because it is trusted. The `spec-status` skill audits them.

## Project Structure

```
smarttoolbox/
├── CLAUDE.md                     # This file
├── .claude/
│   ├── rules/                    # The spec, scoped by path (see above)
│   └── skills/                   # Procedures loaded when they apply
├── docs/
│   ├── HARDWARE.md               # Parts, bring-up status, pin mappings - hardware record
│   ├── SOURCES.md                # Vendor datasheet index (PDFs are gitignored)
│   └── PLAN-*.md                 # Implementation plans
├── api/                          # Web server and database (runs on Pi Zero 2)
│   ├── src/                      # TypeScript source code
│   │   ├── index.ts              # Server entry point, HTTP + serial routing
│   │   ├── db.ts                 # SQLite schema and all queries
│   │   ├── serialProtocol.ts     # NDJSON request/response framing
│   │   └── serialTransport.ts    # Reads and writes the CDC ACM device
│   ├── data/                     # SQLite database files (gitignored)
│   ├── public/                   # Dashboard pages, shared app.css and app.js
│   ├── deploy/                   # smarttoolbox.service systemd unit, .env.example
│   ├── scripts/                  # Release, flash and device-command scripts
│   └── sync.ps1                  # Deploy script (Windows -> Pi)
└── firmware/
    ├── smarttoolbox/             # Seeed XIAO ESP32S3 sketch
    │   └── smarttoolbox.ino      # Main controller sketch
    └── README.md                 # Firmware documentation
```

## Architecture

### System Overview
- **API Server**: Raspberry Pi Zero 2 running Bun and SQLite
- **Main Controller**: Seeed XIAO ESP32S3 (LED control, USB serial, Wi-Fi, and BLE)
- **Vision Hardware**: Seeed Grove Vision AI Module (V2) + OV5647 camera, **cabled** to a Grove I2C port on the expansion base since the 2026-09-02 rewire, at address 0x62. On-device WiseEye2 inference is the intended method. **No SenseCraft model is deployed and no firmware here has ever addressed the module**, so the link is live and says nothing.
- **Transcription**: Self-hosted Whisper server running on a NAS on the local network (see `serial-protocol.md`)
- **Communication**: XIAO ESP32S3 → API Server over **wired USB serial** for all normal operation. Wi-Fi is used *only* for OTA firmware updates, during `setup()`, and the radio is switched off before `loop()` runs. BLE is unused.
- **Hardware record**: `docs/HARDWARE.md` holds the parts list, the bring-up status
  table, and the pin mappings. It is the single source for what is in the box; the
  spec covers how the software uses it.


### API Project
- **Host Device**: Raspberry Pi Zero 2
- **OS**: Raspberry Pi OS Lite (64-bit recommended)
- **Runtime**: Bun
- **Framework**: none. Routing is a hand-rolled `if` chain in `api/src/index.ts`.
  Hono was a dependency once, never routed anything, and has been removed - the API has
  no runtime dependencies at all
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

This drives two rules that appear throughout the spec:

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

### Toolboxes

**Status: Implemented** - API and dashboard. The firmware half is in the sketch and
compiles, but reaches the device only with the next firmware release; see below.

Drawers belong to a **toolbox**, and there can be several - a chest, a cart, a shed.
It is an inventory feature, not a second device: there is still one XIAO on one wire,
and it is mounted on exactly one box, the one marked `has_device`. A lookup searches
every box, and:

- **The device's box wins.** `pickPrimaryLocation` ranks a drawer on the device's box
  above any other, before row or confidence - the tool within reach is the useful answer.
- **Only the device's box lights.** `rows` counts only that box, and each location
  carries `onDevice`, `toolboxId` and `toolboxName`. Row 3 of the garage cart must not
  light row 3 of the chest.
- **A tool only elsewhere is still found.** The firmware takes its "found, no row"
  path - the whole indicator band, three fast blinks - and the OLED reads
  `Found elsewhere` with the box name and drawer label.

Firmware from before this change reads `primaryLocation.rowNumber` regardless, so until
the next release a tool that is *only* in another box lights that box's row number here.
Nothing changes while there is one toolbox.

Creating a toolbox takes a **drawer count** and creates `Drawer 1` to `Drawer N`,
labelled `1` to `N`, with rows 1 to N for as many as the box has rows (default: the
drawer count, capped at 8). That is a starting point to relabel, not a layout: no count
could have guessed that 1A, 1B and 1C share row 1. The device's box cannot be deleted or
unmarked; move the device to another box first, so the panel always answers for one.

## Code Style

- TypeScript strict mode for the API; async/await for database operations.
- The codebase is deliberately plain - a hand-rolled `if` chain for routing rather than
  a framework, prepared statements at module scope. Match what is already there rather
  than introducing new patterns.
- Comment only the non-obvious why (a hidden constraint, a subtle invariant), never
  the what. Keep each comment to 1-2 lines - if it needs more, put the reasoning in
  the commit message or the spec instead.

## Working here

- `cd api && bun run start` runs the server; `bun test` runs the tests.
- On Windows the serial listener does not start, so the API and dashboard run fine with
  no XIAO attached. The device round trip can only be tested against the Pi.
- Deploy with `cd api && .\sync.ps1`. Release firmware with
  `cd api\scripts && .\release-firmware.ps1 -Version x.y.z -Push` - add `-Now` and the
  device fetches it within one heartbeat instead of up to 30 minutes.
- The Pi cannot push; it can only leave a command to be collected.
  `.\push-to-device.ps1 check-firmware` (or `reboot`) queues one, delivered on the
  device's next heartbeat.
- `.\flash-device.ps1 -Version x.y.z` flashes the XIAO from the Pi over USB, through
  the ROM bootloader. That is the only path that survives a bad build, because OTA
  needs working firmware to receive an update. See `docs/PLAN-usb-flashing.md`.
- Secrets are untracked: `firmware/smarttoolbox/arduino_secrets.h` locally and
  `~/smarttoolbox/.env` on the Pi. Never commit either; the `.example` files are the
  tracked templates.

## Skills

`.claude/skills/` holds the procedures that are long enough to be worth loading only
when they apply:

- **`firmware-release`** - releasing over OTA, making the device collect a build, and
  flashing over USB when OTA cannot help.
- **`deploy-api`** - `sync.ps1`, the service, where the logs actually are, setting up a
  new Pi, and checking a secret is really untracked.
- **`hardware-debug`** - triaging "nothing happens" on the box.
- **`spec-status`** - keeping the status tags honest against the code.

## Debugging hardware

Most failures in this project present identically as "nothing happens" - a wrong touch
threshold, a frozen peripheral, a tty in the wrong mode, and a missing antenna all look
the same from the outside. The `hardware-debug` skill records the checks that tell them
apart. Reach for those before reading code; nearly every bug found here was found by
making the system observable, not by inspection.

## Roadmap

### Done
- [x] API with health endpoint and database schema (`api/src/db.ts`)
- [x] Drawer, tool, toolbox, lookup and observation endpoints
- [x] Row-aware lookup (`/api/tools/lookup`, `tools/lookup`)
- [x] Observation storage (`/api/vision/observations`, `vision/observe`)
- [x] Management dashboard
- [x] Deploy configuration (systemd unit + `api/sync.ps1`)
- [x] XIAO bring-up on its own (LED + touch)
- [x] USB serial communication (`device/status` handshake), with reconnect
      (`api/src/serialTransport.ts` retries with backoff up to 5s, unlimited attempts)
- [x] Real `tools/lookup` requests from a touch pad, blinking the row number back
- [x] Grove Vision AI V2 to XIAO link over I2C (bring-up only; the sketch does not yet
      include `Seeed_Arduino_SSCMA`)
- [x] Wi-Fi OTA firmware updates (Feature 4 in `features.md`)
- [x] OLED and 8x8 matrix on the shared I2C bus - both initialised in `setup()` and running
- [x] GPIO expansion question resolved - the expansion base took the header and the
      Vision AI V2 moved to a Grove cable, 2026-09-02. PIR, button and strip are all wired
- [x] Microphone selected - the XIAO's own PDM mic on the Sense board, fitted 2026-08-28
- [x] Microphone proven on hardware - RMS 17 quiet against 210 spoken into, 2026-08-29
      (`docs/PLAN-mic-bringup.md` Step 1)
- [x] Audio carried to the Pi as a single base64 line, 0.20.0 (the chunked protocol was
      rejected - see `serial-protocol.md`); voice lookup end to end in 0.22.0

### Next
- [ ] **Deploy a SenseCraft model** so `vision/observe` carries real labels
- [ ] Make the firmware send real `vision/observe` requests
- [ ] Reconcile remaining planned endpoints (see Planned Endpoints in `api.md`)
- [ ] Power management
- [ ] Authentication - deliberately deferred, see Authentication & Authorization in `api.md`
- [ ] Error recovery mechanisms
- [ ] Performance testing and optimization

### Future Considerations
- Per-instance tool tracking (checkout history, missing-tool alerts) - see Tool Identity
  in `api.md`
- Data visualization
- Cloud deployment
- Deep sleep optimization
- Wi-Fi or BLE for requests instead of the wire - only if the wire becomes a real
  constraint
