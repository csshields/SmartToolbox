---
title: Plan of Attack - Next Four Features
scope: implementation plan, written 2026-08-27
status: partially complete - Features 1, 2 and 3 are done; 4 is not started
---

> **Features 1, 2 and 3 shipped 2026-08-27.** Read those sections below as history,
> not as work outstanding. Feature 4 (dashboard search) is still an accurate
> description of unstarted work.
>
> Feature 1 (serial reconnect) needed a follow-up the plan did not anticipate: the
> reconnect worked, but the tty came up in cooked mode with echo, so the device
> received nothing back. See Communication Protocol in the spec.
>
> Feature 2 (touch-triggered lookup) took three hardware bugs beyond what is described
> here - the S3's touch readings rise rather than fall, scanning all nine pads froze the
> peripheral, and the startup baseline averaged unusable boot readings. All three are
> recorded in `.github/instructions/xiao-esp32s3-firmware.instructions.md`.
>
> Also built the same day, and not part of this plan: Wi-Fi OTA updates, see
> `PLAN-ota-updates.md`.

# Plan of Attack

Four features, ordered. Each is independent except where noted — you can implement any
one without the others, but the ordering below minimizes wasted effort.

| # | Feature | Size | Touches | Hardware needed |
|---|---|---|---|---|
| 1 | Serial reconnect | Small | API | None |
| 2 | Touch-triggered lookup | Medium | Firmware + API | XIAO only (already verified) |
| 3 | Delete endpoints | Small | API + dashboard | None |
| 4 | Dashboard search | Small | Dashboard | None |

**Recommended order: 1 → 2**, then 3 and 4 in either order. Feature 1 is first because
every `arduino-cli upload` resets the board and re-enumerates the USB device, which
kills the Pi's serial stream. Without reconnect, every firmware iteration in Feature 2
costs a `sudo systemctl restart smarttoolbox`. Doing 1 first pays for itself within an
hour of Feature 2 work.

If you want a lighter second item instead, swap Feature 2 for 3 or 4 — nothing depends
on ordering beyond the note above.

---

## Shared conventions

Read `.github/copilot-instructions.md` first; it is the project spec and is current as
of 2026-08-27.

**Code style**
- TypeScript strict mode is on (`api/tsconfig.json`). No `any` — the codebase casts
  request bodies to explicit inline types instead, e.g.
  `await readJsonBody(req) as { name?: string }`.
- The router in `api/src/index.ts` is a plain `if` chain on `pathname` and
  `req.method`, not a framework. Hono is a dependency but is **not** used for routing.
  Match the surrounding pattern; do not introduce Hono to add a route.
- All SQL lives in `api/src/db.ts` as prepared statements declared at module scope.
  Parameterized queries only (`?1`, `?2`).
- Errors propagate as thrown `Error`s from `db.ts`, and `index.ts` maps the message to
  a status code — see the `message === 'Drawer not found.' ? 404 : 400` pattern at
  `api/src/index.ts:427`. Keep that pattern rather than inventing an error class.
- Every mutating route calls `writeRequestLog(...)`, which both persists to
  `request_logs` and console-logs. Follow it; the dashboard's Recent Requests panel
  reads that table.
- Comments are sparse in this codebase and explain *why*, not *what*. Match that.

**Testing**
- `bun test` from `api/`. Two test files exist: `serialProtocol.test.ts` and
  `serialTransport.test.ts`, both using `import { expect, test } from "bun:test"`.
- There is **no `test` script in `package.json`** — add
  `"test": "bun test"` to `scripts` as part of Feature 1.

**Running**
- `cd api && bun run start` → `http://localhost:3000`.
- On Windows the serial listener does not start (`SERIAL_DEVICE` is unset off Linux),
  so the HTTP API and dashboard run fine with no XIAO attached.
- Deploy to the Pi: `cd api && .\sync.ps1`. Add `-Status` to see service status and the
  tail of both logs.

**Documentation is part of done.** `.github/copilot-instructions.md` uses per-section
status tags (`**Status: Implemented | Partial | Planned | Blocked**`). Each feature
below lists which tags and checklists to update. Update them in the same commit as the
code — that convention is the whole point of the tags.

---

## Feature 1 — Serial reconnect

### Why

`api/src/serialTransport.ts:22` opens the device exactly once:

```ts
const input = createReadStream(options.devicePath);
const output = createWriteStream(options.devicePath, { flags: "a" });
```

When the XIAO is unplugged, reset, or reflashed, the read stream errors or closes and
never comes back. `README.md` currently documents the workaround: restart the service.
That workaround is the thing being deleted.

### Design

Wrap the stream creation in a `connect()` function and drive it from a small state
machine:

- `connect()` creates both streams, wires handlers, and resets the line buffer.
- On `error` **or** `close`/`end` from either stream: tear down both, then schedule a
  reconnect. Guard with a flag so `error` followed by `close` schedules only once.
- Backoff: start at 500ms, double on each failure, cap at 5s. Reset to 500ms once a
  connection successfully delivers data.
- `close()` must set a `stopped` flag and clear any pending reconnect timer, otherwise
  tests and shutdown hang.
- **Reset `SerialLineBuffer` on every reconnect.** A partial line captured before an
  unplug is garbage and would corrupt the first message after reconnect.
- A missing device (`ENOENT`, XIAO not plugged in at boot) is the same case as a
  disconnect — retry, do not throw. This also means the service can start before the
  XIAO is attached.

### Make it testable

The current signature takes `devicePath` and calls `fs` directly, which cannot be
tested without hardware. Add optional injection:

```ts
openStreams?: (devicePath: string) => { input: Readable; output: Writable };
retryDelaysMs?: number[];   // default [500, 1000, 2000, 4000, 5000]
```

Default to the real `fs` implementation. Tests pass fake streams (`PassThrough`) and
`[1, 1]` delays, so no fake timers are needed.

### Steps

1. Add `"test": "bun test"` to `api/package.json` scripts.
2. Refactor `startSerialTransport` into `connect()` + reconnect scheduling, keeping the
   exported signature backward compatible (all new options optional).
3. Add `onConnect` / `onDisconnect` optional callbacks alongside the existing
   `onError` and `onResponseWritten`.
4. Wire the new callbacks in `api/src/index.ts:534` to log
   `[serial] connected` / `[serial] disconnected, retrying in Nms`.
5. Extend `serialTransport.test.ts`: the existing `SerialLineBuffer` test stays; add
   coverage for (a) reconnect after an input error, (b) buffer reset across reconnect,
   (c) `close()` cancelling a pending retry.

### Gotchas

- The `input.on("data", async ...)` handler at `serialTransport.ts:26` is async but data
  events are not queued — two chunks arriving quickly can interleave responses. Out of
  scope here, but do not make it worse; note it if you touch that path.
- Writing to a disconnected device can throw synchronously as well as emit `error`.
  Wrap the `output.write` call.

### Done when

- Unplug the XIAO mid-run, replug it, press `RST`, and `[serial] request id=boot-1`
  appears in the log with no service restart.
- `bun test` passes.
- `README.md` "USB Serial Check" section: delete the restart-required paragraph.
- `.github/copilot-instructions.md`: tick "Serial reconnect" in Phase 2 of Development
  Priorities.

---

## Feature 2 — Touch-triggered tool lookup

### Why

This is the first time the system does its actual job. Every piece already works in
isolation: touch pads are verified on hardware, the serial handshake reaches the Pi,
and `tools/lookup` is implemented end to end on the API side. Nothing has ever
connected them.

No new hardware. No microphone, no SenseCraft model, no I2C hub.

```
touch pad → tools/lookup over serial → SQLite → response → LED blinks row number
```

A touch pad is a stand-in for the microphone that does not exist yet. Each pad maps to
a hardcoded tool name; this is a bench harness for the real voice flow in Feature 2 of
the spec, not the finished interaction.

### Prerequisite: seed the database

The lookup returns nothing useful against an empty database. Before bench testing,
create a drawer and a tool from the dashboard, matching the real box (see Physical
Layout in the spec): e.g. drawer `1A` in row 1 containing "phillips screwdriver".
The firmware's hardcoded query must match a tool name exactly — see the matching
caveat under Feature 4.

### API side (small)

One change, in `api/src/index.ts:158`:

`handleSerialLine` currently returns an error response for **any** unparseable line.
The firmware also emits human-readable debug output on the same wire
(`Serial.print("Touched GPIO: ")` in the current sketch), so every debug line would
generate an error response written back to the device — noise generating noise.

Rule to implement:

- Line does not start with `{` after trimming → **ignore silently**. It is device debug
  output, not a request.
- Line starts with `{` but fails to parse → return the existing error response. A
  malformed request is still a bug worth reporting.

Add a test in `serialProtocol.test.ts` or a new test covering both branches.

### Firmware side

Current state: `firmware/smarttoolbox/smarttoolbox.ino` in the working tree is the
touch/LED bring-up sketch. The committed version is the boot handshake. This feature
merges them.

1. **Add ArduinoJson** via Library Manager. Update the checklist in the spec's
   Libraries Required section.
2. **Restructure `loop()` to be non-blocking.** The bring-up sketch ends with
   `delay(50)`, which starves serial reads. Convert to a `millis()`-based poll
   interval, keeping the existing debounce (2 consecutive samples) and the
   startup-calibrated touch baselines — that calibration is deliberate, see
   `.github/instructions/xiao-esp32s3-firmware.instructions.md`.
3. **Map pads to tools.** A small array parallel to `TOUCH_PINS`, e.g. pad D0 →
   `"phillips screwdriver"`. Only map as many pads as you have seeded tools.
4. **Send the request.** Monotonic id counter (`req-1`, `req-2`, ...):
   ```json
   {"id":"req-1","type":"request","endpoint":"tools/lookup","body":{"query":"phillips screwdriver"}}
   ```
   One line, newline-terminated. Note `body` is required by the parser even when empty.
5. **Read the response.** Mirror `SerialLineBuffer`: accumulate `Serial.read()` bytes
   until `\n`, then parse with ArduinoJson. Match on the echoed `id`; ignore responses
   whose id you are not waiting for. Time out after ~2s and treat as not-found.
6. **Blink feedback.** The LED is active-low (`LOW` = on). There is no matrix yet, so
   encode the result in blink count:
   - found → blink `rows[0].rowNumber` times, slow
   - not found (`found: false`, HTTP 200 — a miss is not an error) → 3 fast blinks
   - timeout or error response → 1 long blink

   Document in a comment that this stands in for the 8x8 matrix.
7. **Remove or gate the periodic debug prints** so they do not flood the protocol
   channel. The API-side rule above tolerates them, but they are still noise.

### Response shape to parse

```json
{"id":"req-1","success":true,"body":{
  "found": true,
  "tool": "Phillips Screwdriver",
  "drawers": [{"drawerId":1,"label":"1A","rowNumber":1,"quantity":2,
               "confidence":null,"observedAt":null}],
  "rows": [{"rowNumber":1,"certainty":null}]
}}
```

`confidence` and `certainty` are `null` for manually entered tools that the camera has
never observed. Do not assume they are numbers.

### Gotchas

- **Serial baud is 115200** and the board re-enumerates on reset — Feature 1 is what
  makes this tolerable.
- ArduinoJson document sizing: the response above is comfortably under 512 bytes for a
  single drawer, but a tool in several drawers grows it. Use `JsonDocument` (v7) which
  sizes dynamically, or budget 1KB.
- Touch baselines are captured in `setup()`. If a pad is being touched at boot the
  baseline is wrong — worth a serial warning, not a fix.

### Done when

- Touching a mapped pad blinks the LED the correct number of times for a seeded tool.
- Touching it for an unseeded tool gives 3 fast blinks.
- `[serial] request id=req-N endpoint=tools/lookup` appears in the Pi log.
- Spec updates: Hardware Bring-Up Status table (add a row for the touch-triggered
  lookup path), Phase 2 checklist ("Make the firmware send real requests" — adjust
  wording since this is `tools/lookup`, not `vision/observe`), and Feature 2's status
  line to note the bench harness exists.

---

## Feature 3 — Delete endpoints

### Why

The API has no `DELETE` route at all. A drawer created with a typo is permanent, and
the only recovery is deleting the SQLite file. `ON DELETE CASCADE` is already in the
schema and `PRAGMA foreign_keys = ON` is set at `api/src/db.ts:62`, so the database
side is ready.

### Steps

1. **`api/src/db.ts`** — two functions mirroring the existing style:
   - `deleteDrawer(drawerId: number): boolean` — returns whether a row was removed.
   - `deleteTool(drawerId: number, toolId: number): boolean`.

   Declare the `DELETE` statements at module scope with the other prepared queries.
   `bun:sqlite`'s `.run()` returns `{ changes }`; use it rather than a `SELECT` first.

2. **`api/src/index.ts`** — two routes, following the existing regex-match pattern at
   `api/src/index.ts:479`:
   - `/^\/api\/drawers\/(\d+)$/` with `req.method === 'DELETE'`
   - `/^\/api\/drawers\/(\d+)\/tools\/(\d+)$/` with `req.method === 'DELETE'`

   Return `{ success: true }` at 200 on success and 404 when nothing matched. The
   codebase returns JSON bodies everywhere, so prefer that over a bare 204.
   Call `writeRequestLog` in both branches.

3. **Dashboard** — a delete control per drawer and per tool in the Toolbox Inventory
   panel, each behind a `confirm()`. Match the existing inline style.

### Gotchas

- **Cascade is wider than it looks.** `drawer_observations` also has
  `ON DELETE CASCADE` on `drawer_id`, so deleting a drawer destroys its observation
  history, not just its tools. Say so in the confirm dialog — include the tool count.
- Place the `/^\/api\/drawers\/(\d+)$/` match **after** the existing
  `/api/drawers` exact-string checks so it cannot shadow them.

### Done when

- Deleting a drawer removes it and its tools; deleting a tool leaves the drawer.
- Deleting a nonexistent id returns 404, not 500.
- Both actions appear in Recent Requests.
- Spec: add both routes to the HTTP Endpoints table in the API Endpoints section.

---

## Feature 4 — Dashboard search

### Why

There is no search box. The page's own copy at `api/public/index.html:410` says
*"Use the API to search by tool name"* — it is telling the user to go run curl.

### The important caveat

`GET /api/tools/lookup` is an **exact match**, not a substring search:

```sql
WHERE name = ?1 COLLATE NOCASE
```

(`selectCanonicalToolName`, `api/src/db.ts:210`.) Typing "phillips" will **not** find
"Phillips Screwdriver #2". Wiring a search box straight to that endpoint produces a
search that mostly returns nothing.

So this feature is client-side:

**Implement:** filter in the browser over the data the dashboard already has.
`GET /api/drawers` returns every drawer with its full `tools` array, which the page
fetches on load anyway. For a box with 8 drawers this is instant, needs no backend
work, no debounce, and no new endpoint. Filter on tool name and drawer label, and show
the matching drawer's `label` and `rowNumber`.

**Do not** add substring matching to `/api/tools/lookup` as part of this feature — see
below.

### Follow-on, tracked separately: fuzzy lookup

Exact matching is a real problem for the **voice** path, not the dashboard. Whisper
will transcribe "phillips screwdriver" and the database holds "Phillips Screwdriver
#2"; an exact match fails and the toolbox says "not found" for a tool it owns. That
needs `LIKE`/token matching plus a confidence notion in `findToolLocations`, and it
changes the firmware-facing contract.

Keep it out of this feature. Add it to the spec's Planned work so it is not lost — it
should be built alongside Feature 2 of the spec (voice), where it actually matters.

### Steps

1. Add a search input to the Toolbox Inventory panel, matching the existing markup and
   glassmorphism styling.
2. Filter the already-fetched drawer list on each keystroke; render matches with drawer
   label, row number, and quantity.
3. Empty query → show everything, the current behavior.
4. No matches → an explicit empty state, not a blank panel.

### Done when

- Typing a partial tool name narrows the list live.
- Clearing the box restores the full list.
- Spec: note the search behavior under Dashboard, and add fuzzy server-side lookup to
  Planned Endpoints with the voice-path rationale.

---

## Not in scope for any of these

Recorded so they are not accidentally pulled in:

- `GET /api/tools/find` and `POST /query` are documented as deprecated in the spec but
  still exist in `index.ts`. Nothing calls either — the dashboard does not, and the
  firmware uses the serial channel. Removing them is a separate cleanup.
- Per-instance tool tracking (`tool_id`, checkout state). The project deliberately
  tracks tools by type and quantity; see Tool Identity in the spec.
- Anything needing the microphone, the SenseCraft model, the I2C hub, or the PIR
  sensor. All four are blocked on hardware — see the Hardware Bring-Up Status table.
