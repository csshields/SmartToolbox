---
title: Plan of Attack - Microphone Bring-Up (say a word, read it on the OLED)
scope: bring-up plan, written 2026-08-28 - PDM mic to Whisper to OLED, no tool matching
references: https://wiki.seeedstudio.com/xiao_esp32s3_sense_mic/
status: in progress - Step 1 running on hardware; mic proven alive, RMS gate not yet passed
---

# Plan: say a word, see the word

One sentence of scope:

> Hold the touch pad. Say "hammer". The OLED shows `hammer`.

That is the whole thing. **No tool matching, no drawer lookup, no row indication.** This
exists to prove the four unproven links in the chain before anything is built on top of
them, and to make each one fail on its own terms rather than as "nothing happened".

## Why this is separate from PLAN-voice-lookup.md

That plan builds the feature. This one proves the plumbing the feature assumes, and it
deliberately drops the hardest part of it.

`docs/PLAN-voice-lookup.md` Phase 1 is *transcript to tool name* - the fuzzy matching
that turns "needle nose pliers" into `Needle-nose Pliers`. That is the part with the most
design in it and the least hardware risk. This plan skips it entirely and keeps only the
parts nobody has ever run:

| Link | State today |
|---|---|
| PDM microphone initialised at all | **Never done in this sketch.** The spec's own advice: bring it up alone first |
| Audio off the device over serial | **Never done.** No binary of any size has crossed that link |
| Pi calling Whisper with real audio | **Never done.** Provider config and a reachability probe exist; no audio has passed through |
| A string coming back and reaching the OLED | **Never done** |

Everything this plan builds is reused by the voice-lookup plan. Nothing here is
throwaway except the OLED display of the raw transcript, which becomes a lookup call.

## Step 0 - is the microphone even attached? **Done 2026-08-28**

The Sense board is fitted, camera and mic facing up on the board-to-board connector, with
the Vision AI V2 still stacked on the expansion header below. **Both are on at once.**

An earlier revision of this plan and of the spec said only one of them could be present
and treated the camera as possibly displaced. That was wrong: they use different
connectors. Nothing here is blocked on it, and the pins are fixed by the board - GPIO 42
clock, GPIO 41 data.

## Step 1 - the mic records, and you can prove it from the serial log

Firmware only. The Pi is not involved and no audio leaves the device.

Initialise I2S in PDM mode, record a fixed two seconds into a buffer, and print
**statistics, not audio**: sample count, min, max, and RMS amplitude.

Confirmed against Seeed's own documentation - do not re-derive these:

```cpp
#include <ESP_I2S.h>            // Core 3.x. NOT the core-2.x <I2S.h>.
I2S.setPinsPdmRx(42, 41);       // 42 = clock, 41 = data
I2S.begin(I2S_MODE_PDM_RX, 16000, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO);
```

**The library choice is the likeliest first failure.** Seeed's wiki still leads with the
core-2.x `I2S.h` API - `setAllPins`, `PDM_MONO_MODE`, `esp_i2s::i2s_read` - and this
project is on core 3.3.11, where none of that exists. If the first attempt does not
compile, check which half of that page was copied before debugging anything else.

**Mono and 16-bit are not choices.** The ESP32-S3 supports only PDM mono at 16-bit. The
sample rate is adjustable, but 16 kHz is both what Seeed reports as stable and what
Whisper wants, so leave it.

**`recordWAV` was the plan here, and it was dropped. Read this before putting it back.**
The intent was that one call returning a WAV-headered buffer would make Step 2 trivial.
Reading the core's implementation killed it: `recordWAV` allocates with plain `malloc`,
not `ps_malloc`, which directly contradicts the PSRAM instruction below - it takes the
64 KB from the S3's internal SRAM, of which this sketch already holds 49 KB of 320 KB.
It also takes a fixed duration, so it could never serve hold-to-talk anyway.

So Step 1 reads with `mic.readBytes()` into a `ps_malloc` buffer instead. That is fewer
moving parts for statistics, which need no header at all, and it is exactly the loop
hold-to-talk needs in Step 2 - the 44-byte header becomes the Pi's job, as Step 2
already assumed. Nothing is lost by the swap.

**Allocate in PSRAM.** Seeed's own example uses `ps_malloc` for this. Two seconds of
16 kHz 16-bit mono is 64 KB and four is 128 KB, against the XIAO's 320 KB of SRAM, of
which this sketch already uses 49 KB. Check the pointer - a silent allocation failure
looks exactly like a silent microphone.

**The build had PSRAM switched off, and still would have.** `ps_malloc` returns null on
every call unless `-DBOARD_HAS_PSRAM` is defined, and that comes from a board menu
option. `release-firmware.ps1` compiled with a bare `esp32:esp32:XIAO_ESP32S3`, and a
bare fqbn takes the *first* entry of each menu - which for PSRAM is `Disabled`. Every
binary ever released from this repo therefore had PSRAM off. The script now builds
`esp32:esp32:XIAO_ESP32S3:PSRAM=opi`.

This is the trap the paragraph above describes, arriving from the build rather than the
board, and it would have presented as a dead microphone. The firmware prints
`MIC error=psram-alloc-failed` and puts `Build PSRAM=opi` on the OLED rather than
letting a null pointer look like silence.

**Note for the OTA path:** this changes the binary for every build, not just mic ones.
The first release after this flag is the first PSRAM-enabled image the device will run.

**Done when:** RMS sits near a small constant in a quiet room and rises by an obvious
multiple when you speak into it. That single number separates "no data", "wrong pins",
and "working" - three failures that are otherwise identical.

**If it fails:** you have one variable. Nothing else in this plan has run yet.

### What was built - 2026-08-28

Firmware only, in `firmware/smarttoolbox/smarttoolbox.ino`:

- `MIC_BRINGUP`, a compile flag at the top of the sketch. While it is `1`, pad D0
  records and reports instead of running a tool lookup. The lookup path is proven and
  is untouched behind the `#else`; setting the flag to `0` restores it.
- `beginMicrophone()` - PDM RX on GPIO 42 clock / GPIO 41 data, 16 kHz, 16-bit, mono,
  via core 3.x `<ESP_I2S.h>`. Reports `Mic ready=0|1` at boot, the same shape as the
  existing `Matrix ready=` line.
- `recordAndReportMic()` - two seconds into PSRAM, then prints
  `MIC samples=N min=N max=N rms=N`. Plain text rather than JSON, so the Pi's existing
  `[serial-debug]` branch echoes it straight to the journal with no API change at all.
  RMS accumulates in a `uint64_t`: 32,000 squared 16-bit samples overflow 32 bits.

### First hardware run - 2026-08-28, in 0.15.0

It reached the device (the OTA story that took to get there is in
`docs/PLAN-ota-updates.md`) and the microphone came up:

```
Mic ready=1
MIC samples=32000 min=1025 max=2568 rms=1745
MIC samples=32000 min=981  max=2480 rms=1751
```

**What is proven:** PDM I2S initialises on GPIO 42/41, the PSRAM buffer allocates
(so `PSRAM=opi` is doing its job), and a full two seconds - all 32,000 samples -
reads back. Three of the four things that had never been done now work.

**What the numbers exposed:** the samples never cross zero. They run from about +981
to +2568, centred near +1745, because the PDM mic rides on a large positive DC bias.
RMS of the raw samples therefore measures that bias and not the sound, which is why two
separate recordings came back 1745 and 1751 - a number that barely moves is the offset,
not the room.

The plan's own gate caught this exactly as intended: "RMS near a small constant that
rises by an obvious multiple" is what a *working* measurement does, and this one was
constant for the wrong reason. Fixed in 0.17.0 by centring on the mean before squaring,
and `mean=` is now printed alongside `rms=` so the offset stays visible instead of
hiding inside the result.

**Still unproven, and this is the actual gate:** that a DC-corrected RMS is small in a
quiet room and multiplies when spoken into. Until that comparison is made, the mic is
known to produce *data*, not known to produce *audio*.

## Step 2 - the audio reaches the Pi and is playable

Send the recording to the Pi as **one line** of base64 raw PCM on a new `voice/audio`
serial endpoint, per PLAN-voice-lookup.md's wire format. The Pi decodes it, prepends the
44-byte WAV header, and writes the file to disk. Nothing else.

Two things in the transport must change first, and both are already known:

- **`SerialLineBuffer` needs a maximum line length.** It currently accumulates until a
  newline appears, with no bound. A 171 KB line is the first thing that has ever tested
  that, and a malformed sender would grow it without limit. Set a cap, reject the
  oversized line, clear the buffer, log a protocol error.
- **The `[serial-debug]` log must truncate.** Any non-JSON line is currently printed in
  full to the journal. One stray 171 KB line would be written verbatim to the SD card.

**Done when:** you can run `aplay` on the Pi against the written file and hear yourself
say the word. Not "the file exists" - hear it.

**Why this rung matters:** it separates *recording* failures from *transport* failures
from *transcription* failures. If the WAV plays back as noise, the mic setup is wrong. If
it never arrives, the line-length work is wrong. Whisper is not yet in the picture.

## Step 3 - Whisper returns a string, into the log

The Pi posts the WAV to the configured provider and logs the transcript. Still no
response to the device.

The provider plumbing already exists: `/api/settings/transcription` stores the choice and
the NAS URL, and its reachability probe is already implemented and passing. This step
uses that configuration for the first time with real audio.

**Done when:** the Pi's journal shows the word you said.

**If it fails:** the failure is legible, because you already have a playable WAV from
Step 2. Feed that same file to the provider by hand with `curl`. If the manual call works
and the automatic one does not, the bug is in this project. If neither works, it is the
provider or the audio format, and the WAV in your hand tells you which.

## Step 4 - the string comes back and lands on the OLED

Answer the `voice/audio` request with the transcript, and have the firmware show it via
the existing `showStatus`.

The matrix already has a state for the wait: `startMatrixThinking()` is called when a
lookup goes out, and this should call it too - transcription is slower than a lookup, so
this is where a thinking face actually earns its place.

Two display facts worth deciding before writing it:

- The OLED is 0.96 inch. A long transcript will not fit; truncate at the display width
  rather than letting U8g2 clip it mid-glyph.
- An empty transcript is a real outcome, not an error. Whisper returns an empty string
  for silence, and the matrix already has the right picture for it: the question mark
  from `showMatrixUnknown`, which was drawn for exactly this case.

**Done when:** you hold the pad, say "hammer", and `hammer` appears on the screen.

## Trigger, and why it is not the button

Hold a touch pad, not the Grove Red LED Button. The button has nowhere to plug in - that
is the standing Open Hardware Question - and D0 is already calibrated, debounced, and
proven on hardware. `onTouchStart` already refuses to fire while a request is in flight,
which is exactly the guard a recording needs.

Hold-to-talk, per PLAN-voice-lookup.md Decision 3: record while held, 300 ms minimum,
10 s cap. The cap is not a nicety - it is what bounds the buffer allocated in Step 1.

## What this plan deliberately does not do

- **No tool matching.** The transcript is displayed raw. Turning it into a tool name is
  PLAN-voice-lookup.md Phase 1 and is unaffected by anything here.
- **No wake word.** Continuously classifying audio is a separate project.
- **No OpenAI fallback testing.** The provider switch exists and is configurable; prove
  one provider end to end before exercising the other.
- **No row indication.** Row indication is moving to the LED strip - see the Row
  Indication decision in the spec - and coupling this to it would tie a bring-up to
  hardware that is not wired.

## Everything must be tested on the Pi

The serial listener does not start on Windows, so no part of Steps 2 through 4 can be
exercised from the development machine. `cd api && .\sync.ps1` to deploy, and
`.\sync.ps1 -Status` to read the service log.
