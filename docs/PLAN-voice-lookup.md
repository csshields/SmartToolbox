---
title: Plan of Attack - Voice Lookup (press to talk, matrix shows the row)
scope: implementation plan, written 2026-08-27, revised same day - on-board PDM mic, audio over serial, hold-to-talk
status: Phase 1 DONE 2026-08-29 (0.22.0) - resolveToolQuery ships and the whole voice
  path works end to end. Phase 2 was already covered by api/src/voice.ts. The dashboard
  voice-test panel is the one piece of Phase 1 not built.
---

# Plan: say a tool, the matrix lights its row

This is the spec's **Feature 2: Tool Drawer Requests (Voice-Activated)**, narrowed to
what is actually being built now:

> Press the red LED button. The box listens. Say "needle-nose pliers". The 8x8 matrix
> lights the row that drawer is in, and the OLED names the exact drawer.

Deliberately **not** in this phase: the always-on "Smart Toolbox" wake word. Wake-word
detection means running a classifier over the mic continuously and is a separate
project; a button gives the same user-facing feature for a fraction of the work, and
everything built here is reused if a wake word is added later. The spec's Feature 2
workflow step 1 should be re-scoped to say so.

**The microphone is the XIAO's own PDM mic.** The spec's Microphone section and the
Hardware Bring-Up table have been corrected to say so.

## Context, so the plan is honest about where it starts

| Piece | State today |
|---|---|
| `findToolLocations` + `tools/lookup` (serial and HTTP) | **Works on hardware.** Full round trip verified |
| Firmware result display - OLED, LED blink pattern, error branches | **Works on hardware** |
| Serial transport, raw mode, reconnect | **Works on hardware**, and was hard-won |
| Transcription provider config (`/api/settings/transcription`) | **Built.** Provider, NAS URL, reachability probe. No audio has ever passed through it |
| PDM microphone | **On the board**, never initialised in this sketch |
| Matrix row indicator (`showMatrixRow`) | **Code written, never run.** Matrix is not wired |
| Grove Red LED Button | **Owned, nowhere to plug it in** |

Both ends of this feature already exist and are proven. What is missing is the middle -
turning a press into audio, audio into text, and text into a query the existing lookup
can answer.

---

## Decision 1: the audio goes over the USB serial link

**Decided 2026-08-27: serial, not Wi-Fi.** The radio stays exactly as it is today -
associated during `setup()` for the OTA check, then `WiFi.mode(WIFI_OFF)` before
`loop()`. The antenna keeps one job.

The reasoning, recorded because the alternative is defensible and someone will revisit
it:

- **It removes a radio from the chain.** The Pi needs the LAN to reach Whisper no matter
  what. Adding the XIAO's radio adds a *second* thing that can fail, and it is the weak
  one - without the external antenna it sees ~-85 dBm, and it is inside a metal box.
- **It keeps one transport.** The spec's architecture is "USB serial for all request
  traffic, Wi-Fi for OTA only". Serial audio preserves that sentence; Wi-Fi audio
  rewrites it and leaves the system with two request paths to reason about.
- **Nothing about the feature needs the device on the network.** The device produces
  audio; the Pi owns the provider config, the API key, the tool vocabulary, and the
  database.

What it costs, stated plainly, because these are real:

- One new serial endpoint carrying a much larger line than anything on that wire today.
- The per-request timeout has to become per-request (see Phase 3). Wi-Fi would have
  absorbed the latency inside `HTTPClient`; serial does not.
- The transfer time is now in the user-visible latency rather than overlapping with
  anything. Budget ~1-2 s of it.

**Switch to Wi-Fi if** the transfer proves slow or unreliable in practice - specifically
if the measurement in Phase 3 step 3 comes in above ~3 s, or if lines arrive truncated
under normal use. The Wi-Fi path is a drop-in replacement for exactly one step (the
device POSTs the WAV to the Pi over HTTP instead of writing it to Serial, reusing the
OTA `HTTPClient` code and the `X-Device-Key` header) and nothing else in this plan
changes. Do not switch on a hunch; switch on the number.

### The wire format: one line, base64 raw PCM, no chunking

```
{"id":"req-9","type":"request","endpoint":"voice/audio",
 "body":{"format":"pcm_s16le","sampleRate":16000,"channels":1,"data":"AAD//wIA..."}}
```

**Raw PCM, not WAV - the Pi writes the header.** With hold-to-talk the device does not
know the recording's length when it starts, and a WAV header's first field is the length.
Rather than make the device seek back and patch it, send the samples and the three facts
needed to describe them; the Pi prepends the 44-byte header before handing the audio to
Whisper. That is a dozen lines on the Pi and it deletes the whole problem.

Four seconds of 16 kHz 16-bit mono is 128,000 bytes; base64 makes that ~171 KB. One
line, one request, one response.

**No sequence numbers, no chunk acks, no resync.** This is the whole point of choosing
this shape. A chunked protocol needs reassembly state on the Pi, a timeout for a
half-finished upload, and a decision about what happens when chunk 17 of 43 goes missing
after a device reset. A single line needs none of that: if it arrives corrupted, JSON
parsing fails, the Pi returns an error, and the user presses the button again. The retry
for a four-second recording is pressing the button, and that is a perfectly good retry.

**Not raw binary after a header line.** Tempting - it would save the 33% base64 overhead
- but the Pi's `SerialLineBuffer` splits the stream on newlines, and raw PCM contains
0x0A constantly. Making it work means teaching the transport to switch into a
read-exactly-N-bytes mode mid-stream, which is a far more invasive change to the one
piece of this system that was genuinely hard to get right. Base64's alphabet is
JSON-safe and line-safe; pay the 33%.

**The device does not need to hold the base64.** Write the JSON envelope to `Serial` by
hand, then encode the WAV buffer 3 bytes at a time straight out to the port, then write
the closing brace and the newline. Only the 128 KB WAV is ever in memory - there is no
171 KB string anywhere, on either side of the wire, on the device.

### The flow

```
  button DOWN
        |
        v
  XIAO: LED solid, matrix -> listening, OLED "Listening..."
  XIAO: I2S PDM readBytes() in a loop, appending to a PSRAM buffer
        |
  button UP  (or the 10 s cap)
        |
        v
  XIAO: {"id":"req-9",...,"endpoint":"voice/audio","body":{...,"data":"<base64 PCM>"}}
        |
        v
  Pi: decode -> prepend WAV header -> Whisper (NAS or OpenAI) -> "where are my needle nose pliers"
  Pi: resolveToolQuery() -> "Needle-nose Pliers" -> findToolLocations()
        |
        v
  Pi: {"id":"req-9","success":true,"body":{
         "transcript":"where are my needle nose pliers",
         "found":true,"tool":"Needle-nose Pliers","matchType":"tokens",
         "drawers":[...],"rows":[...]}}
        |
        v
  XIAO: matrix lights row, OLED shows the transcript and "1A", LED blinks the row
```

The response body is the **existing `tools/lookup` body** with `transcript` and
`matchType` added, so `handleIncomingLine`'s found / not-found / error branches are
reused rather than duplicated. One round trip, because the Pi is already holding the
audio when it does the lookup - there is no reason to send the transcript back to the
device only to have it ask again.

## Decision 2: the button is blocked, and there is a stand-in that is not a compromise

The Grove Red LED Button (SKU 111020044) needs two GPIO - signal in, LED out - and the
XIAO's expansion header is occupied. This is the spec's **Open Hardware Question**,
unchanged.

A touch pad still stands in for *triggering* a capture - D0 is already calibrated,
debounced, and proven, and `onTouchStart` already refuses to fire while a request is in
flight. But note the limit, because Decision 3 changed it:

**Decided 2026-08-27: hold a touch pad, and no new hardware for now.** The Grove Red LED
Button cannot be read where it is - it is plugged into the I2C hub, which has no GPIO to
give it - and every way of fixing that costs either soldering or a part. A touch pad
costs nothing and works today.

The risk is that the S3 reads touch against a baseline captured at boot, so a long hold
could in principle drift back under the trigger ratio and end a recording early. Within
a few seconds a held finger should stay comfortably above threshold; the drift that
matters is the slow kind, across minutes. **So try hold-on-touch directly** rather than
designing around a problem that may not appear.

If it does cut out early, the fallback needs no hardware either: **tap to start, tap to
stop**. That sidesteps drift completely, removes any maximum hold, and is arguably the
nicer gesture - nobody has to keep a finger pressed while thinking of the tool's name.

The Grove Red LED Button remains the eventual answer for feel, and Phase 4 still
describes it. It is now genuinely deferred rather than blocking: nothing above depends on
it, and the interaction it provides is one `digitalRead` away once it has two real pins.

Until the button's own LED exists, "the box is listening" is the onboard LED held solid
(not blinking - blinking already means a row number) plus a listening face on the matrix.

## Decision 3: hold-to-talk - the recording runs for as long as the button is held

**Decided 2026-08-27.** Button down starts the capture, button up ends it. Not a fixed
window. This is the better interaction - it never clips a long tool name and never makes
you wait out silence - and it has three concrete consequences.

**1. `recordWAV()` is unusable.** It takes a fixed `rec_seconds` and returns when they
have elapsed. The capture becomes a loop over `I2SClass::readBytes(buffer, size)` -
confirmed present in the installed core alongside `available()` - reading small blocks
and appending them while polling the button between blocks. Read in ~512-byte blocks:
at 32 KB/s that is ~16 ms per block, which is also the granularity at which a release is
noticed, so it sets how much trailing audio gets captured after the user lets go. Small
blocks are cheap; do not read in 8 KB ones.

**2. The length is unknown until the user lets go**, which is what drives the raw-PCM
wire format above. It also means the response timeout has to scale: use roughly
`10000 + recordedMs`, not a constant, since Whisper's inference time grows with the clip.

**3. Both ends of the hold need guarding.**

- **Minimum ~300 ms.** An accidental brush should not spend a Whisper call. Below the
  minimum, show "Too short" and discard - do not send.
- **Maximum ~10 s.** Someone will lean on the button, or it will stick. At the cap, stop
  recording and send what there is; do not discard it, and do not keep growing the
  buffer. 10 s at 16 kHz 16-bit mono is 320 KB, which is the number the capture buffer
  must be sized for.
- **Debounce the release, not just the press.** A mechanical button bounces on both
  edges. The existing touch code already requires two consecutive released readings; keep
  that shape, because a single noisy sample read as a release now truncates a sentence
  mid-word rather than merely ending a touch.

**The buffer, first cut: preallocate the 10-second maximum in PSRAM** and record into it
until release. It is the version you can debug - dump it, check the peak, write it to a
file and listen to it. The optimisation, once that works, is to base64 it out to the port
*as it is captured* rather than after: hold-to-talk makes this natural, since there is no
length to know in advance and the raw-PCM format already carries no header. That removes
the buffer entirely and hides the whole transfer time inside the press. Do it second.

---

## Phases

| # | Phase | Hardware needed | Testable on Windows |
|---|---|---|---|
| 1 | Transcript to tool name | None | **Yes, fully** |
| 2 | Pi-side transcription | None to build, NAS to run | **Yes, via browser mic** |
| 3 | Firmware: record and send; the `voice/audio` endpoint | XIAO | No |
| 4 | The real button | Header question resolved | No |
| 5 | Matrix result polish | Matrix wired | No |

**Do Phase 1 first and completely.** It is the only part with real algorithmic risk, it
is the part most likely to be wrong in a way that is hard to see, and it is the one part
that runs entirely in `bun test` with no toolbox in the room.

---

## Phase 1 - transcript to tool name (API only)

### Why this is the hard part

`findToolLocations` matches **exactly**:

```sql
WHERE name = ?1 COLLATE NOCASE
```

Whisper will hand you `"where are my needle nose pliers"`. The database holds
`"Needle-nose Pliers"`. Exact match returns nothing, and the box says "not found" for a
tool it owns. `PLAN-next-features.md` already flagged this and deferred it to here,
which is where it matters.

### Design

A new function `resolveToolQuery(query: string)` in `db.ts`, returning
`{ toolName, matchType, alternatives }` or `null`. Tiers, first hit wins:

1. **exact** - the existing `selectCanonicalToolName`. Unchanged, still first.
2. **tokens** - normalise, then require every remaining query token to appear in the tool
   name. `"needle nose pliers"` matches `Needle-nose Pliers`.
3. **partial** - highest token-overlap score, but only if at least one *distinctive*
   token matches. `"screwdriver"` alone must not silently pick one of three
   screwdrivers - return all of them as `alternatives` and let the matrix light every
   matching row, which the `rows` array already supports.

Normalisation, in order: lowercase; strip punctuation; collapse hyphens to spaces (so
`needle-nose` and `needle nose` are the same thing); drop carrier words -
`where is/are, find, get, show me, i need, my, the, a, please, in, drawer`.

Keep it in SQL where that is natural (`LIKE '%token%'` per token, ANDed) and in
TypeScript where it is not (scoring). Prepared statements at module scope, like
everything else in `db.ts`.

**Wire it into `findToolLocations` itself**, not into a voice-only path. Then
`tools/lookup` gains fuzzy matching for the serial link, the HTTP endpoint, and the
dashboard in one change. Add `matchType` to the response body so a caller can tell an
exact hit from a guess; the firmware can ignore it, the dashboard should show it.

### Steps

1. `resolveToolQuery` + unit tests in `db.test.ts`. Test the ugly cases: carrier phrases,
   hyphens, plurals (`pliers` vs `plier`), trailing punctuation, a query matching three
   tools, a query matching nothing, an empty string.
2. Call it from `findToolLocations`; extend `ToolLookupResult` with `matchType` and
   `matchedTool`. Existing tests must still pass unchanged - an exact query must still
   take the exact path.
3. Dashboard: a "Voice test" panel - a text box that posts a transcript to
   `GET /api/tools/lookup` and renders the matched tool, the match type, and the drawer.
   This stays useful forever as the thing you reach for when the box mishears something.

### Done when

- `bun test` covers the match tiers.
- "where are my needle nose pliers" typed into the dashboard returns `1A`.
- "screwdriver" with three screwdrivers seeded returns all three, not a coin flip.
- Spec: fuzzy matching moves out of `PLAN-next-features.md`'s "follow-on" and into the
  Lookup Response Shape section, with `matchType` documented.

---

## Phase 2 - Pi-side transcription

### Design

One new module, `api/src/transcription.ts`, no new config table.

`transcribeAudio(wav: Uint8Array): Promise<string>` reads the existing transcription
settings and posts multipart to whichever provider is configured:

- **NAS Whisper**: `POST <nasUrl>/asr?task=transcribe&language=en&output=json`, file
  field `audio_file`. **Verify the parameter names against the Swagger at `<nasUrl>/docs`**
  - they differ between builds of that image, and `/docs` is already what the
  reachability probe hits.
- **OpenAI**: `POST /v1/audio/transcriptions`, `model=whisper-1`, file field `file`.

5-second timeout, 2 retries, per the spec.

Also add `POST /api/voice/transcribe`, taking a raw WAV body. The firmware will not use
it - it has the serial endpoint - but it is how this phase gets tested from a browser,
and it stays the debugging entry point afterwards.

**Prime the recogniser with the actual vocabulary.** Both providers take a prompt
(`initial_prompt` on the Whisper webservice, `prompt` on OpenAI). Pass a comma-joined
list of the tool names currently in the database. This is the single highest-value line
in the phase: it is what makes "needle-nose pliers" and "Phillips" come back spelled the
way the database spells them, instead of "needle nose players".

**No automatic provider fallback.** If the NAS is down, report it - do not silently ship
the audio to OpenAI. The spec frames the choice as a privacy tradeoff, and a fallback
turns a deliberate setting into a surprise.

**Reject near-silence before it reaches the resolver.** Whisper hallucinates confidently
on silence, usually "Thank you." or "you". A transcript under a few characters, or with
no alphabetic content, is `NO_SPEECH` - a distinct error, not a failed lookup.

### Steps

1. `transcription.ts` with both providers behind one function; unit-test the multipart
   assembly and the retry/timeout behaviour against a stub fetch, the way
   `serialTransport.test.ts` stubs its streams.
2. `POST /api/voice/transcribe` in the `if` chain in `index.ts`. Log through
   `writeRequestLog` with the transcript in `details` - a record of what the box thought
   it heard is the only way to tune the resolver against real speech.
3. Wire the dashboard's Voice test panel to the browser microphone (`MediaRecorder`,
   then POST). This gives a **real** audio path, real accent, real room, from Windows,
   with no device involved - and it is how you will test transcription changes forever
   after.

### Done when

- Speaking into the dashboard returns the right drawer, end to end, with no XIAO.
- Silence returns `NO_SPEECH`.
- Taking the NAS offline produces a clear error, not a hang and not a silent OpenAI call.
- Spec: Communication Protocol / API Server to Transcription moves from Partial to
  Implemented.

---

## Phase 3 - the firmware and the `voice/audio` endpoint

### The toolchain facts, checked against what is installed here

- Core is **esp32 3.3.11** (FQBN `esp32:esp32:XIAO_ESP32S3`). Confirmed in
  `libraries/ESP_I2S/src/ESP_I2S.h`: `setPinsPdmRx(clk, din0, ...)`,
  `begin(I2S_MODE_PDM_RX, rate, bits, slots)`, `readBytes(char*, size_t)`, and
  `available()`. There is also a `recordWAV(rec_seconds, &out_size)` convenience -
  **not usable here**, because it records a fixed duration and hold-to-talk does not have
  one. It is still the fastest way to do the standalone mic bring-up in step 1 below, so
  use it there and nowhere else.
- **Most Seeed mic tutorials will not compile.** They use the core-2.x `I2S.h` API
  (`I2S.setAllPins(...)`, `I2S.begin(PDM_MONO_MODE, ...)`). On 3.x it is `ESP_I2S.h` and
  `I2SClass`. Expect to translate every example found online.
- **PSRAM is off in every build this project ships.** `release-firmware.ps1` compiles
  with a bare `esp32:esp32:XIAO_ESP32S3`, and in `boards.txt` the PSRAM menu's first -
  therefore default - option is `disabled`. The 320 KB capture buffer then has to come
  out of internal SRAM as one contiguous block, next to the Wi-Fi stack and the U8g2
  buffer, and at that size it will simply fail. Set the release script's FQBN to
  `esp32:esp32:XIAO_ESP32S3:PSRAM=opi`, print `psramFound()` and `ESP.getFreePsram()` at
  boot, and allocate the capture buffer explicitly.
- PDM pin numbers for the on-board mic (commonly documented as clock GPIO42, data
  GPIO41) are **unverified here**. Confirm against Seeed's board documentation and record
  the result in `docs/SOURCES.md` with a checked date, per that file's convention, before
  hard-coding them.

### API side

- Add `"voice/audio"` to `serialEndpoints` in `serialProtocol.ts` and to the
  `SerialEndpoint` union.
- Branch in `handleSerialRequest`: base64-decode `body.data`, prepend a 44-byte WAV
  header built from `sampleRate` / `channels` / the decoded length, transcribe, resolve,
  `findToolLocations`, return the merged body. Each failure gets its own code -
  `BAD_AUDIO`, `TRANSCRIPTION_FAILED`, `NO_SPEECH` - because on a 128x64 screen the error
  code is the entire diagnosis.
- The WAV header is fixed-layout and worth writing by hand rather than pulling in a
  dependency: `RIFF`, size, `WAVEfmt `, 16, PCM=1, channels, rate, byte rate, block
  align, bits, `data`, size. Unit-test it by round-tripping a known buffer.
- **Cap the line length in `SerialLineBuffer`.** It currently accumulates until it sees a
  newline, with no ceiling; a device that resets mid-transfer, or any noise on a
  disconnected port, can grow `remainder` without bound. Add a limit around 512 KB -
  comfortably above a legitimate 171 KB line - that discards the buffer and logs once.
- **Truncate the `[serial-debug]` log line.** `handleSerialLine` currently prints any
  non-JSON line in full. One corrupted audio line would put 171 KB into the journal.
  Print the first 200 characters and the length.

### Firmware side

- `pendingTimeoutMs`, set per request: keep 2000 for `tools/lookup`, and
  `10000 + recordedMs` for `voice/audio`. Do **not** raise the constant globally - a stuck
  `tools/lookup` should still fail fast, and that fast failure is a diagnostic you
  already rely on.
- A `LISTENING` state driving the capture loop: onboard LED solid, OLED "Listening...",
  matrix listening face, all set **before** the loop starts, not after. The loop is
  `readBytes` a block, append, poll the button, repeat - so the OLED and matrix can also
  be updated during a long hold if you want a level meter later.
- Enforce the minimum and maximum hold from Decision 3, and debounce the **release**.
- **Bound the send.** If the Pi's service is not draining the port, a large write can
  block long enough to trip the task watchdog. Write the base64 in a loop that checks
  `Serial.availableForWrite()` against a deadline (say 5 s), and abandon the request with
  an OLED error if it stalls. A voice query that fails is fine; a device that reboots
  mid-send is not.
- Allocate the 320 KB capture buffer **once at boot** and reuse it, rather than per
  press. A repeated allocation of that size fragments the heap and turns into the third
  or fourth query failing on a box that was fine at boot; a single static allocation also
  fails loudly at startup, where you will see it, instead of mid-press.
- Show the **transcript** on the OLED next to the result. When the box says "not found",
  the only question that matters is whether it misheard you or does not own the tool, and
  the transcript is the entire answer.
- Add a `voice` bench command to `handleIncomingLine` next to `lookup <tool name>`, so
  the path can be driven from a serial monitor with no pad and no button.
- Trigger from a touch pad **not** mapped in `TOUCH_TOOL_NAMES` - D1 or D2 - held for the
  duration of the capture, per Decision 2. Keep D0's direct lookup: when voice
  misbehaves you want a known-good trigger for the same round trip on the same wire to
  tell the two apart.
- Write the capture loop against a `isTriggerHeld()` predicate rather than against
  `touchRead` directly. Swapping in `digitalRead` for the real button later then touches
  one function, and the tap-to-start/tap-to-stop fallback is a change in the same place.

### Steps

1. **Bring the mic up alone**, before anything else: a throwaway sketch that records two
   seconds and prints the peak sample value. A mic that returns constant zeros and a mic
   that was never initialised look identical from every other vantage point in this
   system, and this is the only cheap moment to tell them apart.
2. Convert the bring-up sketch's fixed record into the hold-to-talk loop, still
   standalone: hold a pad or short a pin, print the captured byte count and peak on
   release. Get the minimum, maximum, and release debounce right here, where the only
   moving part is the button.
3. Base64 the buffer straight to `Serial` behind the hand-written JSON envelope. Prove it
   against the Pi with a throwaway handler that just decodes, adds the header, and writes
   the WAV to `/tmp` - **listen to the file** before involving Whisper. If the audio is
   wrong, you want to find out here and not through a bad transcript.
4. **Measure the transfer.** Time from the first byte written to the response arriving,
   logged from the Pi, for a full 10-second hold - the worst case. This is the number
   that decides whether Decision 1 stands: over ~3 s of transfer, switch that one step to
   the Wi-Fi POST.
5. Add the real handler, the timeout change, and the result display.

### Done when

- Touching the voice pad, saying a tool, and watching the row light works end to end.
- Saying nothing shows `NO_SPEECH` on the OLED.
- Stopping the Pi's service mid-press fails cleanly and leaves D0's lookup working.
- Ten consecutive voice queries work - the allocation and watchdog check.
- The measured transfer time is recorded in the spec's Communication Protocol section.

### If it is too slow or too big

In order of what to try:

1. **Stream the capture instead of buffering it**, as Decision 3 describes. Base64 each
   block out to the port as it is read rather than after the release. The raw-PCM format
   carries no header, so there is nothing to patch afterwards - this works out cleanly.
   It removes the 320 KB buffer and hides the entire transfer inside the press, which
   makes it the first thing to try, not the last.
2. **Lower the maximum hold.** Ten seconds is generous for a tool name; six would cut the
   worst case by 40% and nobody would notice.
3. **8-bit mu-law instead of 16-bit PCM.** Halves the payload, is a legal WAV encoding
   that ffmpeg and Whisper accept, and is a lookup table on the device. Costs some
   fidelity; try it only if 1 and 2 are not enough.
4. **Switch that one step to Wi-Fi.** Already scoped in Decision 1.

---

## Phase 4 - the actual red LED button

Once Decision 2 is resolved:

- Assign `BUTTON_PIN` and `BUTTON_LED_PIN` in the spec's Pin Mappings, replacing the
  `TBD`s, and record which mounting option was chosen.
- Grove Red LED Button: signal is an ordinary digital input (`INPUT_PULLUP`, active low),
  LED an ordinary digital output. Debounce **both edges** the way the touch pads are
  debounced - two consecutive readings - rather than inventing a second scheme. The
  release edge is the one that matters now: a bounce read as a release truncates a
  sentence.
- **This is where hold-to-talk actually lands.** The capture loop from Phase 3 is already
  written against a "is it still held?" predicate; this phase swaps a touch reading for
  `digitalRead`, and the interaction becomes the real one. Everything else is done.
- Button LED: **off** idle, **solid** while listening, **fast flash** while the request is
  in flight, **off** when the result appears. That is the whole reason to prefer this
  module over a plain button, so use all four states.
- Keep the touch pad's fixed-window trigger and the `voice` bench command. Both stay
  useful as the known-good paths when the button itself is suspect.

---

## Phase 5 - matrix result polish

The matrix code exists but **has never run**. `PLAN-matrix-eyes.md` has the first
power-up checklist; do that before anything here.

Three things this feature needs that the current matrix code does not do:

1. **Multiple rows.** `showMatrixRow` takes one row; a voice query like "screwdriver"
   legitimately matches several. Take the whole `rows` array and light each, colouring
   each by its own certainty.
2. **A longer hold for voice results.** `MATRIX_RESULT_HOLD_MS` is 4000 - fine for a
   touch you are standing over, useless when you have just spoken and then walked to the
   box. The spec says 30 s. Use ~20 s for voice results and keep 4 s for touch.
3. **A listening face**, distinct from both the idle eyes and any result colour. Purple
   is already reserved for idle; use a pulsing single row or a cyan bar.

**Reconcile the certainty colours while you are in there.** The spec says green 80-100 /
orange 40-79 / blue 10-39 / dark below 10. The firmware says green >= 75, otherwise
orange, white for null. The firmware's version is better - certainty is null for every
tool in the box today, since nothing has been observed by a camera, so "no reading" needs
its own colour more than the low band needs three. Update the spec to match the code, and
say why.

---

## Gotchas

- **PSRAM is disabled in the shipped build.** See Phase 3. This is the one that will bite
  silently and late.
- **The core-2.x `I2S.h` examples do not compile on 3.3.11.** See Phase 3.
- **The capture loop owns `loop()` for the whole hold.** Up to ten seconds of no
  `pollSerialResponses`, no touch scan, no matrix blink. Acceptable - nothing else is
  happening while the user is talking - but set the LED and the OLED before the loop
  starts, or the box looks dead for the duration.
- **Read in small blocks.** The block size is the release granularity: 8 KB blocks mean a
  quarter-second of latency between letting go and the recording stopping, which reads as
  the button not working. ~512 bytes.
- **A stuck or bouncing button is a real failure mode**, not a theoretical one. The 10 s
  cap is what keeps it from becoming an unbounded buffer, and the 300 ms minimum is what
  keeps a brush against the panel from spending a Whisper call.
- **A large blocking write can trip the watchdog.** See the bounded-send note in Phase 3.
- **The 2000 ms response timeout will fire on the first voice request** if the
  per-request timeout is forgotten. The symptom is the box giving up while the Pi is
  still transcribing, and the Pi's reply then arriving for a request the firmware has
  already abandoned - which it drops silently, because `pendingRequestId` no longer
  matches.
- **The serial reader awaits each line in turn.** A `voice/audio` handler is open for
  several seconds; lines behind it in the same chunk wait. Safe today - the firmware only
  ever has one request outstanding - but do not add a second long-running serial endpoint
  without revisiting it.
- **Whisper's punctuation is not stable.** It returns "Needle-nose pliers." with a
  trailing period, or "Where are my pliers?" - normalise before matching, and put
  punctuation in the test fixtures.
- **A silent recording still transcribes**, confidently and wrongly. Handled in Phase 2.
- **The matrix has never been powered on.** Do not debug a voice bug through it until
  `PLAN-matrix-eyes.md`'s checklist has passed - the OLED and the Pi's journal are the
  trustworthy observers, per the spec's Debugging section.

## Open questions to settle before starting

1. **What is physically on the XIAO's expansion header?** The spec says the Vision AI V2
   is *"stacked on the XIAO expansion header"*; `firmware/README.md` says its I2C runs
   *"Vision AI V2 Grove port -> Grove I2C Hub"*. Those describe different builds. It
   decides whether the camera, the mic, and the button can all be present at once.
   Settle it and correct whichever document is wrong.
2. Confirm the PDM clock and data GPIO numbers, and add the board doc to
   `docs/SOURCES.md` with a checked date.
3. ~~Fixed window or hold-to-talk?~~ **Settled 2026-08-27: hold-to-talk.** See Decision 3.
4. Aliases: "cross-head" for Phillips, "spanner" for wrench. A `tool_aliases` table is
   cheap and would help, but it is a schema change - keep it out of Phase 1 and decide
   once there are real misses in the log to justify it.

## Done when

- Press the button, say "needle-nose pliers", and the matrix lights row 1 while the OLED
  reads `1A`.
- Say something the box does not own and it says so - with the transcript on screen, so
  you can tell mishearing from not owning.
- `bun test` covers the resolver, and the dashboard panel resolves both a typed
  transcript and browser-recorded speech with no device attached.
- Spec: Feature 2 moves from **Blocked** to **Implemented** (wake word explicitly
  re-scoped out); the Communication Protocol's Audio bullet is replaced by the real wire
  format and the measured transfer time; `voice/audio` is added to the serial endpoint
  list; Pin Mappings loses two `TBD`s; and `POST /api/tools/identify` is removed from
  Planned Endpoints in favour of `voice/audio` plus the existing `tools/lookup`.
