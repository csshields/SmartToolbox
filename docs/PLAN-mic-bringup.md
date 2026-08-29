---
title: Plan of Attack - Microphone Bring-Up (say a word, read it on the OLED)
scope: bring-up plan, written 2026-08-28 - PDM mic to Whisper to OLED, no tool matching
references: https://wiki.seeedstudio.com/xiao_esp32s3_sense_mic/
status: not started
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

**Use `recordWAV` for this step, and know why it will not survive.** For a fixed
two-second recording it is one call and it returns a buffer with a WAV header already
attached, which makes Step 2 trivial. It also takes a fixed duration, so it cannot serve
hold-to-talk, where the length is unknown when recording starts - that path reads in a
loop and lets the Pi write the header. Prove the microphone with the easy call first;
swap the read strategy later, once it is the only thing changing.

**Allocate in PSRAM.** Seeed's own example uses `ps_malloc` for this. Two seconds of
16 kHz 16-bit mono is 64 KB and four is 128 KB, against the XIAO's 320 KB of SRAM, of
which this sketch already uses 49 KB. Check the pointer - a silent allocation failure
looks exactly like a silent microphone.

**Done when:** RMS sits near a small constant in a quiet room and rises by an obvious
multiple when you speak into it. That single number separates "no data", "wrong pins",
and "working" - three failures that are otherwise identical.

**If it fails:** you have one variable. Nothing else in this plan has run yet.

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
