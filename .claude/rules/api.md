---
paths:
  - "api/**"
---

# API

The Bun server, its SQLite database, and the HTTP routes. The serial side of the API is
in `serial-protocol.md`; the dashboard pages are in `dashboard.md`. Deploying is the
`deploy-api` skill.

## Technology Stack

- **Runtime**: Bun (JavaScript/TypeScript runtime)
- **Server Framework**: none - `serve()` imported from `bun`, with a hand-rolled `if` chain in `api/src/index.ts`. Hono was removed; the API has no runtime dependencies
- **Database**: SQLite3
- **Package Manager**: Bun
- **Build Tool**: Bun (native TypeScript support)

## Database Conventions
- All database code should go in `api/src/db.ts`
- Use parameterized queries to prevent SQL injection
- Handle errors gracefully with try/catch blocks


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
tracking is a Future Consideration (CLAUDE.md), not a current gap to be filled in.

### Implemented Tables

```sql
-- Toolboxes. Exactly one has has_device = 1: the box the XIAO is mounted on, the
-- only one whose rows the device lights. row_count bounds its drawers' rows.
CREATE TABLE IF NOT EXISTS toolboxes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  row_count INTEGER NOT NULL DEFAULT 6 CHECK (row_count >= 1 AND row_count <= 8),
  has_device INTEGER NOT NULL DEFAULT 0 CHECK (has_device IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Drawers. `label` is what the OLED shows (1A, 3); `row_number` drives the matrix.
-- Names are unique per toolbox (idx_drawers_toolbox_name), not globally.
CREATE TABLE IF NOT EXISTS drawers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  toolbox_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  label TEXT,
  row_number INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(toolbox_id) REFERENCES toolboxes(id) ON DELETE CASCADE
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
-- read has always compared them. See the Tool Identity note above.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tools_drawer_name ON tools(drawer_id, name COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS idx_toolboxes_device ON toolboxes(has_device) WHERE has_device = 1;
-- BINARY, matching the UNIQUE(name) it replaced, so building it cannot fail on old data.
CREATE UNIQUE INDEX IF NOT EXISTS idx_drawers_toolbox_name ON drawers(toolbox_id, name);
CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_observations_tool_drawer
  ON drawer_observations(tool_name, drawer_id, id DESC);
```

Config keys currently in use: `transcription_provider`, `transcription_nas_url`.
`toolbox_row_count` is legacy: read once, to seed the first toolbox's `row_count` on
upgrade, and never written again.

### Migrations

There is no migration framework. `db.ts` runs `CREATE TABLE IF NOT EXISTS`, then
patches older databases in place by checking `PRAGMA table_info` and issuing
`ALTER TABLE ... ADD COLUMN` for `label` and `row_number`. Follow that pattern when
adding a column: additive, idempotent, safe to run on every boot.

**Toolboxes needed a table rebuild**, the one exception. The old `drawers.name UNIQUE`
would stop two boxes each having a `Drawer 1`, and SQLite cannot drop a constraint in
place. When `drawers` has no `toolbox_id`, `db.ts` seeds a toolbox named `Toolbox`
(holding the device, `row_count` from the legacy config key), then copies `drawers`
into a new table with every drawer in that box, drops the old one and renames - with
foreign keys off so the drop does not cascade into `tools` and `drawer_observations`.
Ids are copied unchanged, so every reference still points at the same drawer. It runs
in one transaction and rolls back if `PRAGMA foreign_key_check` finds *more* broken
references than before: the dev database already held orphaned tools and observations
from drawers deleted with foreign keys off, and refusing to start over rows nothing can
reach would have taken the API down. Tested against an old-schema database in
`db.test.ts`, and against a copy of the dev database.

### Planned Tables

**Status: Planned** - none of these exist. Do not write code against them.

- `tool_movements` - a log of tools leaving and returning: one row per observed
  change, `(drawer_id, tool_name, delta, observed_at, confidence, model_version)`.
  This entry used to read "needs per-instance identity first". **That was wrong, and it
  blocked the feature for no reason: movement of a count is still movement.** "One
  Phillips screwdriver left 1A at 14:32" is a complete and honest fact, and no tool
  needs a serial number for it to be true. See `docs/PLAN-tool-presence.md`.
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
| GET | `/health` | Liveness check. Returns `{"status":"Ok","local":false}` - `local` is true when the server has no serial device, i.e. a development copy with its own database. Every page shows a "Local copy" badge in its header when it is |
| GET | `/api/drawers` | All drawers with their tools and tool counts, plus `toolboxId` and `toolboxName`. The device's box first, then by row, with drawers that have no row last |
| POST | `/api/drawers` | Create a drawer (`name`, optional `label`, `rowNumber`, `toolboxId` - default the device's box). 400 when `rowNumber` is outside that toolbox's row count, 404 for an unknown toolbox, 409 for a name already in that toolbox |
| GET | `/api/toolboxes` | Every toolbox with `rowCount`, `hasDevice` and `drawerCount`, plus `maxRowCount` (8) and `maxDrawerCount` (50) |
| POST | `/api/toolboxes` | Create a toolbox and its drawers (`name`, `drawerCount` 0-50, optional `rowCount` 1-8). 409 on a duplicate name, case-insensitively |
| PUT | `/api/toolboxes/:id` | Change `name`, `rowCount`, or set `hasDevice: true` to move the device here. 400 when shrinking would strand a drawer's row, or on `hasDevice: false`; 404, 409 as above |
| DELETE | `/api/toolboxes/:id` | Delete a toolbox. **Cascades** to its drawers, their tools and observations. 409 for the device's box |
| POST | `/api/drawers/:id/tools` | Add or update a tool in a drawer (upsert on name) |
| PUT | `/api/drawers/:id` | Edit a drawer's `name`, `label` or `rowNumber`; omitted fields keep their value, an empty `label` falls back to the name, and `rowNumber: null` takes it off the matrix. Tools and observations stay with it. 400 for a row outside its toolbox, 404, 409 for a name already in that toolbox |
| DELETE | `/api/drawers/:id` | Delete a drawer. **Cascades** to its tools *and* its `drawer_observations` history. 404 if the id does not exist |
| DELETE | `/api/drawers/:id/tools/:toolId` | Delete one tool **and its observations** for that drawer, in one transaction. Scoped by drawer, so a mismatched pair is a 404 rather than deleting a tool in another drawer |
| GET | `/api/tools/lookup?query=` | **Primary lookup.** Returns `primaryLocation` (the one location to act on), `hasMultipleLocations`, plus `drawers` and `rows` collapsed by certainty |
| POST | `/api/tools/assign` | **Move an existing tool to another drawer**, by `toolId`. 400 on a missing/invalid id, 404 on an unknown tool or drawer, 409 when the target drawer already holds that name. Does not create tools |
| POST | `/api/vision/observations` | Record camera detections for a drawer. **All or nothing**: the whole batch is validated before any of it is written, and written in one transaction |
| GET | `/api/firmware/latest?currentVersion=` | **OTA update check.** Requires an `X-Device-Key` header. 200 streams the newer `.bin`, 204 means already current, 401 rejects a bad key, 503 means `DEVICE_KEY` is unconfigured |
| GET | `/api/devices` | Device status: last contact, firmware version, boot count, plus the latest firmware on disk and whether the serial listener is running. Also returns `pendingCommand` - `{command, queuedAt}` for a command queued but not yet collected, or `null` |
| POST | `/api/devices/command` | Queue `check-firmware` or `reboot` for the device to collect on its next heartbeat. The Pi cannot push - see the device command queue in `serial-protocol.md` |
| GET | `/api/logs?limit=` | Recent request log (default 50, capped at 200). Includes serial traffic, logged with method `SERIAL` and path `serial:<endpoint>` |
| GET | `/api/settings/transcription` | Current transcription provider settings |
| PUT | `/api/settings/transcription` | Save provider and NAS URL |
| POST | `/api/settings/transcription/test` | Probe the configured provider |

Anything under `/api/` that does not match returns 404 JSON. Everything else falls
through to static files from `api/public/`. An extensionless path is tried as
`<path>.html` first, so `/toolboxes` and `/devices` resolve to their pages; `index.html`
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
  "matchType": "tokens",
  "query": "where are my needle nose pliers",
  "matches": [ { "tool": "Needle-nose Pliers", "primaryLocation": { "...": "..." },
                 "hasMultipleLocations": false, "drawers": [], "rows": [] } ],
  "primaryLocation": { "drawerId": 1, "toolboxId": 1, "toolboxName": "Toolbox",
                       "onDevice": true, "label": "1A", "rowNumber": 1, "quantity": 2,
                       "confidence": 95, "observedAt": "2026-08-27 11:04:12" },
  "hasMultipleLocations": false,
  "drawers": [
    { "drawerId": 1, "toolboxId": 1, "toolboxName": "Toolbox", "onDevice": true,
      "label": "1A", "rowNumber": 1, "quantity": 2,
      "confidence": 95, "observedAt": "2026-08-27 11:04:12" }
  ],
  "rows": [ { "rowNumber": 1, "certainty": 95 } ]
}
```

**Display from `primaryLocation` and nothing else.** It is one location object, so the
row and the label it carries always describe the same drawer - which reading across
`rows` and `drawers` did not guarantee. See the last-but-one invariant under Data Invariants for what that
cost. `hasMultipleLocations` is true when the tool is on record in more than one drawer,
and the firmware appends a `+` to the OLED line rather than presenting one candidate as
the answer. `primaryLocation` is null only for a known tool with no location at all.

**The query does not have to be the stored name.** `resolveToolQuery` in `db.ts` resolves
what a person said into a tool the box owns, and `findToolLocations` calls it - so serial
`tools/lookup`, the HTTP endpoint and the dashboard all get this from one place rather
than a voice-only path that could drift. Three tiers, first hit wins, reported as
`matchType`:

| tier | means | example |
|---|---|---|
| `exact` | the name as stored, case-insensitively | `Phillips Screwdriver` |
| `tokens` | every meaningful query word appears in the name | `where are my needle nose pliers` -> `Needle-Nose Pliers` |
| `partial` | best word overlap, and **only** on a distinctive word | `phillips head screwdriver` -> `Phillips Screwdriver` |

Normalisation, in order: lowercase, hyphens and underscores to spaces (so `needle-nose`
and `needle nose` are one thing), strip remaining punctuation, drop carrier words
(`where is/are, find, get, show me, i need, my, the, a, please, drawer`), then crudely
singularise a trailing `s`/`es`.

**A generic word alone will not pick a tool.** `screwdriver`, `wrench`, `hammer` and the
like are excluded from scoring a partial match, because otherwise "cordless drill" would
confidently return whichever drill sorted first. A generic word that *token*-matches
several tools still resolves - it is a real match - but **every rival comes back in
`matches`**, each with its own locations rather than just a name, so a caller can see the
choice was not clear-cut and can act on any of them.

**`matches` is the array; the flat fields are `matches[0]`.** They are kept flat so
existing callers did not have to change, and `matches` always has at least one entry, so
a caller can read it uniformly rather than special-casing the common shape. More than one
entry means the query was ambiguous - "screwdriver" when the box owns three.

**Only the first is displayed, and that is a decision rather than a limitation.** The 8x8
matrix has six usable rows and a lit row cannot say *which* tool it belongs to, so
lighting three at once is less informative than lighting one. The OLED distinguishes the
two kinds of "more than one": `+2` means the query matched two other tools - the box
admitting it guessed - and a bare `+` means this one tool is on record in more than one
drawer, which is not a guess at all. Showing several tools at once waits for the WS2813
strip, which is where row indication is going anyway; see the Row Indication decision
in `docs/HARDWARE.md`. `query` carries what was
actually asked, which is what makes a mishearing diagnosable: "found Needle-Nose Pliers
for 'needle nose players'" is a diagnosis where the tool name alone hides the interesting
half.

`drawers` and `rows` remain for callers that want every candidate: `drawers` carries the
exact labels in every toolbox, `rows` is collapsed so several matching drawers in one row
produce a single entry at the highest confidence - and counts **only the device's box**,
because it is what the panel lights. See Toolboxes under Physical Layout in CLAUDE.md. `confidence` is null when the tool is known from manual
entry but has never been observed by the camera.

Not found returns `{"found": false, "message": "Tool not found."}` with HTTP 200 -
a lookup that matched nothing is a successful lookup, not an error.

### Planned Endpoints

**Status: Planned** - none of the eight paths below exist in the router. Two of them
carry a rationale that is now wrong in `features.md`, so they are corrected here;
the other six are simply unbuilt and unexplained, and `- [ ] Reconcile remaining planned
endpoints` in the CLAUDE.md roadmap is the item that covers them.

`identify` was the voice flow's planned shape, and it was superseded rather than
blocked. Voice lookup shipped in 0.22.0 over the `voice/audio` serial endpoint and
`resolveToolQuery`, so the box answers a spoken question today without this route
existing at all. Do not build it in order to "finish" voice.

`identify-return` is the vision flow, which is still genuinely blocked - on a deployed
SenseCraft model, not on wiring. See Feature 3 in `features.md`.

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

## Data Invariants

**Status: Implemented** - every rule below is enforced in `api/src/db.ts` and guarded by
`api/src/db.test.ts`. They are written up together because each one was a real bug,
and most present on the device rather than in the API.

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

**A drawer's row must be one its toolbox has, and the bound is configurable.**
Six is a fact about the toolbox in front of the matrix, not about the software, so it
lives on the toolbox as `toolboxes.row_count` (default 6) rather than in the code - and
each toolbox has its own. It lived in `config` as `toolbox_row_count` until toolboxes
existed. The API
rejected nothing before: a drawer could be created on row 99, the dashboard would show
it, and the device would silently fall into its "no row assigned" branch and light the
whole indicator band - saying *unknown* while the database said *row 99*.

`normalizeRowNumber` is given the drawer's toolbox's count at call time, so raising it
takes effect without a restart, and the Toolboxes page takes the form's `max` from the
toolbox picked in it.
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

## Testing

- [ ] Unit tests for database operations
- [ ] Integration tests for API endpoints
- [ ] Load testing for concurrent requests
- [ ] Test database migrations
