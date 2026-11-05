---
paths:
  - "api/public/**"
---

# Dashboard

**Status: Implemented** - four pages under `api/public/` (`index.html`,
`toolboxes.html`, `devices.html`, `ai-settings.html`), sharing `app.css` (the whole
design, every colour a custom property on `:root` with a dark-mode override) and
`app.js` (`escapeHtml`, `setStatus`, `startHealthIndicator`).
Page-specific logic stays inline in each page. No build step, no framework, no
dependencies.

This is the primary way drawers and tools are managed today, and it is how the system
is usable at all while the firmware is unfinished.

**`index.html` - Dashboard**, served at `/`:

| Panel | Backed by |
|---|---|
| Stat tiles - drawers, tools, items on hand, drawers with a light row (matrix row), for the toolbox picked below | `GET /api/drawers`, counted client-side |
| Toolbox Inventory - one toolbox at a time, picked from the card's title; tools within each drawer. The stats above follow the same box | `GET /api/toolboxes`, `GET /api/drawers`, `POST /api/drawers/:id/tools`, `DELETE /api/drawers/:id/tools/:toolId` |
| Recent Requests | `GET /api/logs?limit=40` |
| API Quick Reference | nothing - static text for the endpoints the page does not call |

**`toolboxes.html` - Toolboxes**, served at `/toolboxes` (it was `drawers.html` at `/drawers` until 2026-10-04):

| Panel | Backed by |
|---|---|
| Toolboxes - create with a drawer count; per box, save rows, move the device here, delete | `GET`/`POST /api/toolboxes`, `PUT`/`DELETE /api/toolboxes/:id` |
| Drawers - one toolbox at a time, picked from the card's title; add (into that box), tool counts, edit in place, delete | `GET`/`POST /api/drawers`, `PUT`/`DELETE /api/drawers/:id` |

**`devices.html` - Devices**, served at `/devices`:

| Panel | Backed by |
|---|---|
| Stat tiles - firmware running, latest available, boots detected, last contact | `GET /api/devices` |
| XIAO ESP32S3 - version, last contact, last endpoint, uptime, boots detected | `GET /api/devices` |
| Device Activity - the device's serial requests | `GET /api/logs?limit=200`, filtered to `method = 'SERIAL'` |

**`ai-settings.html` - AI Settings**, served at `/ai-settings`:

| Panel | Backed by |
|---|---|
| Transcription - provider (NAS Whisper or OpenAI) and the NAS URL; save, test the connection | `GET`/`PUT /api/settings/transcription`, `POST .../test` |

It moved off the Dashboard because it is set once and rarely touched, and it is the
place any later model settings belong.

The Devices page is **read-only, but "last contact" now means something.** The firmware
heartbeats every 30 seconds, so a last contact older than about a minute means the
toolbox is unplugged or wedged rather than merely idle. Restarts are counted from uptime
running backwards - see `serial-protocol.md` for why the boot message is not trusted.

When no device row exists the page distinguishes two causes, using `serialDevice` from
`GET /api/devices`: the listener is running and the XIAO has not checked in, or this is
Windows and no listener was ever started. Blaming the device on a machine that never
opened the port would be a lie.

The split is deliberate: creating and destroying drawers is structural and rare, and
sat awkwardly next to the per-drawer tool forms it kept re-rendering. The Dashboard now
only ever adds and removes *tools*; drawer lifecycle lives on its own page. A drawer's
name, label and row are edited in place there, through `PUT /api/drawers/:id`.

`app.js` sends the label and row number only when the fields are filled in, so `POST
/api/drawers` still defaults the label to the name and leaves `row_number` null.

`/toolboxes` resolves through `serveStaticFile`, which tries `<path>.html` for
extensionless requests before falling back to `index.html`. Adding a page means adding
the file and a nav link - no route in `serve()`.

Deletes sit behind a `confirm()` on both pages. The drawer dialog, now on the
Toolboxes page, names the tool count and says that the observation history goes too,
because `drawer_observations` cascades on `drawer_id` as well and losing camera
history is not what "delete drawer" sounds like.

Neither page calls `/api/tools/lookup`, `/api/tools/assign`, or
`/api/vision/observations` - those exist for the firmware.

Because the pages are served from the same origin as the API, no CORS configuration is
needed. Keep it that way unless a separate front end is introduced.

The data rules the pages depend on (deleting or moving a tool, row bounds, request logging) are in `api.md` under Data Invariants.
