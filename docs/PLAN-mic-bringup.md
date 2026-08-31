---
title: Plan of Attack - Microphone Bring-Up (say a word, read it on the OLED)
scope: bring-up plan, written 2026-08-28 - PDM mic to Whisper to OLED, no tool matching
references: https://wiki.seeedstudio.com/xiao_esp32s3_sense_mic/
status: COMPLETE - proven by a human at the box 2026-08-29. Hold the pad, say a word, the
  OLED shows the word. Audio level is thin but workable; see "What the first real use
  showed" below.
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
  **Superseded:** the flag is gone. Once the voice path shipped it was gating the
  feature rather than the bring-up - its off position deleted Feature 2, and no build
  had both halves working. Every pad now records; the lookup path is still reachable
  through `tools/lookup` and the `lookup <name>` serial command.
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

### The gate passed - 2026-08-29, in 0.19.0

Two presses, deliberately compared, in a quiet room:

```
MIC samples=32000 min=1524 max=1783 mean=1685 rms=17     # silence
MIC samples=32000 min=-1431 max=4068 mean=1665 rms=210   # "hammer"
```

**Twelve times.** The gate asked for "small in a quiet room, rising by an obvious
multiple when spoken into", and that is what it did.

The second line carries better evidence than the ratio, though. `min=-1431` is
**negative**, and no previous recording in this project has ever gone below zero - that
was the whole DC-bias discovery, samples riding on a +1665 offset and never crossing
zero. To read -1431 the signal had to swing more than 1,665 counts below its own centre.
Ambient noise does not do that. That is a voice.

**Step 1 is complete.** The microphone is no longer merely alive; it is proven to carry
audio. The four unproven links this plan was written to test are now three: recording
works, and what remains is getting the audio to the Pi, through Whisper, and back.

## The listening indicator - an animated sound wave

**Decided 2026-08-29.** While the box is recording, the matrix shows a travelling sound
wave: eight vertical bars in `green`, rising and falling across the panel. Recording is
the one state where the box is taking input rather than giving output, and it is the only
state a person has to actively participate in - they need to know the exact moment it is
listening, and "hold the pad and hope" is what they have today.

**Polychrome, and the only state on the panel that is.** Every other picture the box
draws is a single colour, so a wave that runs through four at once is unmistakable at a
glance - which is the entire job here, since the person has to know the exact moment it
is listening. It also sidesteps the colour-semantics problem rather than adding to it:
purple has meant "idle or thinking" and red and orange belong to results, so a
single-colour wave would have had to borrow one of them.

`drawSoundWave(uint8_t phase)`. Two tables.

**Heights - deliberately irregular.** A smooth repeating hump reads as a decoration
rather than as sound; real speech is uneven, and the picture should be too. Thirty-two
scattered values, indexed by column plus phase:

```
WAVE_HEIGHTS[32] = { 2,5,3,8,4,6,2,7,3,5,8,2,6,4,7,3,
                     5,2,8,4,3,6,2,5,7,3,4,8,2,6,3,5 }
height(x) = WAVE_HEIGHTS[(x + phase) % 32]
```

Thirty-two rather than eight for two reasons: at 100ms a step, a two-second recording is
twenty frames, so the table never visibly repeats inside a single recording - and being
fixed rather than randomised at run time, it can be tuned by eye instead of coming out
different on every press.

**Colour - a vertical ramp, by row rather than by column:**

```
WAVE_COLORS[8] = { cyan, blue, purple, pink, pink, purple, blue, cyan }
```

The centre line is pink and the edges cyan, so a tall bar reaches colours a short one
never shows. The palette itself then encodes amplitude, on top of the height - a loud
moment is both taller and more colourful, which is legible even at a glance from across
a workbench.

Each bar is **centred vertically**, not grown from the bottom - a centred wave reads as a
waveform, a bottom-anchored one reads as a bar chart. `top = (8 - height) / 2` in integer
arithmetic, so odd heights sit one row high of centre. That asymmetry is wanted: it is
part of what stops the wave looking machined.

`MATRIX_WAVE_STEP_MS = 100`, so a full 32-frame cycle takes 3.2 seconds.

**A later upgrade, deliberately not now:** once the read is chunked (below), each chunk
has a real RMS available, and the wave could be driven by the actual signal instead of a
table - scroll the array left and push the newest level in on the right. That is the
honest version and it is worth doing, but not before Step 1's gate has passed. A display
driven by a measurement nobody trusts yet would make a failing measurement look like a
working one.

### The trap: nothing can animate during `readBytes`

`recordAndReportMic()` records with a **single blocking** `mic.readBytes(..., 32000
bytes)` that does not return for the full two seconds. Add the wave without changing
that and it draws exactly one frame and freezes - which is this project's most expensive
failure mode, the one where a frozen peripheral and a working one look identical. A
frozen wave would be *worse* than no wave, because it would positively assert that the
box is listening while the panel is simply stuck.

So the wave requires the read to be chunked: read ~1,600 samples (100ms) at a time into
successive offsets of the same PSRAM buffer, and advance one wave phase between chunks.
Twenty `readBytes` calls instead of one, and 20 `matrixPush` calls at ~10ms of I2C each -
200ms of I2C inside a 2,000ms recording. That overhead lands between reads rather than
during them, so no samples are dropped, but it is real and it is the reason to keep the
wave to the recording window only.

Step 1's own comment already anticipates this: it notes that the hold-to-talk path in
Step 2 "reads in a loop instead, because there the length is not known when recording
starts". The wave brings that loop forward into Step 1, and the two changes want to
happen together.

**Done when:** holding the pad shows the wave crossing the panel for the whole
recording, and the reported `samples=` count is unchanged at 32000 - a wave that animates
but drops samples has traded the thing being built for the picture of it.

## What the first real use showed - 2026-08-29

Spoken to by a person, for the first time, on 0.21.2:

| held | rms | transcript |
|---|---|---|
| 2000ms | 175 | `8K47` |
| 1700ms | 119 | `Massachusetts.` |
| 1800ms | 384 | `Bill` |
| 3500ms | 71 | *(empty)* |

**It works.** "Massachusetts" was said deliberately to test how far it could be pushed,
and it came back exactly. The varying durations are hold-to-talk doing its job - none of
these is the old fixed two seconds.

**The plan's one-sentence scope is met**: hold the pad, say a word, see the word.

**What it also showed is that the audio is thin.** Take the first clip - `min=376
max=2873 mean=1684`. Deviation from centre is about +/-1,300 out of a 16-bit range of
+/-32,767: roughly **4% of full scale**, around -28 dBFS. The loudest reached ~10%.

The margin is real but narrow, and the last row is what it looks like when it runs out:
`rms=71` came back **empty**. Whisper is coping well with quiet audio rather than being
given good audio, and that will bite further from the box, in a noisier room, or with a
quieter speaker.

**Two things would widen it, and only the second is done:**

1. **Strip the DC offset and apply gain before sending.** The mic rides on a bias of
   ~+1,680 that is still in the transmitted samples, and nothing scales the signal up.
   The firmware already computes that mean for the RMS diagnostic - subtracting it,
   finding the peak deviation, scaling to ~80% of full scale and clamping would be worth
   roughly 8-10x on these clips. **Deliberately deferred**, not forgotten.
2. **Tell Whisper the language.** Done - `language=en` is now passed rather than letting
   Whisper guess, since detection on quiet audio is one more thing that can go wrong. It
   also came back measurably quicker: a one-second probe went from ~9.3s to ~6.8s, so
   detection was costing real time.

## Step 2 - the audio reaches the Pi and is playable

**Built 2026-08-29 in 0.20.0.** `sendVoiceAudio` streams one base64 line out of PSRAM;
`parseVoiceAudioBody` and `pcmToWav` in `api/src/voice.ts` decode it and prepend the
header. The base64 encoder was checked against Bun's at every length from 1 to 600 bytes,
which covers all three padding cases.

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

**Built 2026-08-29 in 0.20.0.** `transcribeAudio` in `api/src/voice.ts`. The NAS runs
`whisper-asr-webservice` 1.9.1; the endpoint is `POST /asr?task=transcribe&output=txt`
with a multipart `audio_file` field, taken from the service's own `/openapi.json` rather
than assumed - the field name differs from OpenAI's and a wrong one returns a bare 422.
Exercised end to end from a workstation against the real NAS before it reached the device:
~9.3s for one second of audio once warm, over 30s on the first call after an idle container.

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

**Built 2026-08-29 in 0.20.0.** `handleVoiceResponse` in the sketch. An empty transcript
is treated as a real outcome rather than an error - it is what silence sounds like - and
the rms is still printed beside every recording, because it is the one number that
separates a quiet room from a broken microphone.

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
