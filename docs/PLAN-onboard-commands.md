---
title: Plan of Attack - On-board recognition (the box hears the common ones itself)
scope: implementation plan, written 2026-08-31, revised 2026-09-02 after a source
  review of the pinned core - ESP-SR wake word and a local tool vocabulary carried
  from the Pi, with today's Whisper path as the fallback
status: PLANNED - nothing built. Phase 1 is a partition change, so it can only arrive
  over USB. Two unmeasured facts gate the whole thing - whether this microphone drives
  WakeNet at 4-10% of full scale, and whether the ten seconds is even the device's
  problem to solve (see "Is the ten seconds ours to fix"). The 2026-09-02 review
  against esp32-hal-sr.c corrected three claims that were wrong in the first draft;
  they are marked **Corrected 2026-09-02** where they appear.
---

# Plan: the box hears the common tools itself, and only asks Whisper when it is unsure

One sentence of scope:

> Say a wake phrase instead of holding the pad, and a tool the box already knows is
> answered without a Whisper round trip - roughly ten seconds saved - with today's path
> still there for everything else.

## Context, so the plan is honest about where it starts

| Piece | State today |
|---|---|
| Hold-to-talk, `voice/audio`, Whisper | **Works end to end** since 0.22.0 |
| PDM mic, 16 kHz 16-bit mono via `ESP_I2S` | **Works.** This is exactly the format ESP-SR wants - see `mic.begin` in the sketch |
| ESP-SR, prebuilt for the S3 | **Already in the pinned core** (3.3.11), as the `ESP_SR` library plus a prebuilt esp-sr archive. Never compiled into this sketch |
| Speech models (`srmodels.bin`, 3,340,296 bytes) | **Ship with the core.** There is nowhere on the device to put them |
| English MultiNet | **Present.** `CONFIG_SR_MN_EN_MULTINET7_QUANT=y` in the pinned sdkconfig. Worth stating: had it been `SR_MN_EN_NONE`, Phase 3 would be impossible and the wrapper compiles the whole command path out |
| Partition table | `default_8MB`. No `model` partition, and no room for one without redrawing the map |
| Wake word | **Not built.** The spec says out of scope and `PLAN-voice-lookup.md` calls it a separate project. This plan is that project |
| Tool catalogue | 1 tool across 5 drawers in the dev database. Designed here for 400 anyway - see Decision 4 |

## What this buys, stated as a number

Whisper is the slow part and always has been: ~9.3s warm against the NAS, over 30s on the
first call after the container has idled. Both numbers are measured, and they are why
`TRANSCRIBE_TIMEOUT_MS` is 90 seconds.

On-device recognition answers in the time it takes to stop talking.

**The Pi round trip does not go away, and should not be described as if it does.** The
drawer mapping lives in SQLite and the device holds no copy, so a local recognition still
calls `tools/lookup` for the drawer. That call is milliseconds. What is skipped is the
transcription, which is the entire ten seconds.

---

## Is the ten seconds ours to fix, or the NAS's

**Settle this before Phase 1, because it is cheap and it changes the value of everything
below.** This plan spends a partition change that cannot be undone over OTA in order to
remove ~9.3s. That is only a good trade if the 9.3s is irreducible, and nothing measured
so far says it is.

Two specific suspicions, both testable in an afternoon and neither requiring hardware:

- **The >30s first call is container idle, not inference.** A periodic no-op request that
  keeps the Whisper container warm removes that number outright, and it is the number a
  person actually notices - the first lookup of the morning is exactly when the box gets
  judged.
- **9.3s warm for a ~2 second clip is slow for what it is.** It is worth reading what
  model and backend the NAS is actually running. `faster-whisper` on CTranslate2 with
  `base.en` and `beam_size=1` typically returns a clip that short in well under two
  seconds on a NAS CPU.

If those two together take ten seconds to two, the case for Phases 2 and 3 is much
weaker, and the honest answer might be "keep the pad, fix the NAS." **Phase 1 is still
worth doing either way** - the wake word is a separate benefit from the latency, and the
microphone question has to be answered before anyone can plan around it.

Whatever the measurement says, record the number here. Every other claim in this document
carries one.

---

## Decision 1: the wake word is "Hi ESP", and that is a choice about esp-sr, not about the problem

The prebuilt libraries compile exactly one wake word: `CONFIG_SR_WN_WN9_HIESP=y`. The
sdkconfig lists Jarvis, Computer, Alexa, Sophia, Mycroft and a dozen more, every one of
them `is not set`. Enabling a different one means rebuilding `esp32-arduino-libs`; a
phrase of our own - "Smart Toolbox" - means commissioning Espressif to train a model.

Both are out of proportion to the feature. **"Hi ESP" is what esp-sr has on offer.**

**The qualifier matters, and the first draft of this document did not have it.** The
constraint belongs to esp-sr, not to the ESP32-S3. **microWakeWord** - the engine ESPHome
ships - runs TFLite-Micro on this chip, its models are around 100 KB, and custom phrases
are trained with their own Colab notebook plus `piper-sample-generator`. "Smart Toolbox"
is an afternoon there, not a commission.

The catch is that microWakeWord is wake-word-only. It has no MultiNet equivalent, so it
would replace Phase 2 and leave Phase 3 to be built on esp-sr anyway or dropped in favour
of always going to Whisper. That is a real fork, not a free upgrade, and it is the reason
the recommendation here is still esp-sr.

Recorded because it decides whether Phase 2 is worth doing at all, and because the
question will be asked again in six months - at which point "Hi ESP is what is on offer"
would have been quoted back as though no alternative existed.

**Phase 3 does not depend on this.** If "Hi ESP" is unacceptable to live with, keep the
touch pad as the trigger and take the local vocabulary anyway. The ten seconds is in the
transcription, not in the pad.

## Decision 2: the vocabulary comes from the Pi at boot, not from the build

Commands are registered at runtime from plain English strings. `esp32-hal-sr.c` runs
`flite_g2p()` on each phrase on the device, hands the result to
`esp_mn_commands_phoneme_add`, then loads the set with `esp_mn_commands_update()`. The
strings are copied out during `begin()`, so anything we pass can be freed straight after.

So the device asks the Pi for the tool list on boot and registers what comes back. The Pi
keeps owning the vocabulary, exactly as it owns the database, the provider config and the
API key.

**Where the phrases actually live, since it is easy to get this wrong:**

- **On the Pi, permanently** - and no new storage is needed for them. The vocabulary *is*
  the `name` column of the `tools` table. It is already there. The endpoint added in
  Phase 3 is a `SELECT`, not a store.
- **On the XIAO, only in RAM, only while powered.** MultiNet holds the phoneme set in
  memory. Nothing is written to the device's flash, and there is no vocabulary on it to
  go stale - a cold boot has no tool names at all until the Pi supplies them.

That asymmetry is the point: **add a tool in the dashboard, reboot the box, it is
recognised. No firmware release.**

The alternative - baking the list into the sketch as a `const sr_cmd_t[]`, the way the
stock example does - was rejected on that sentence alone. It would make every tool
addition a firmware release, and this project already ships firmware often enough to have
built a USB recovery path for it.

### Register incrementally, and do not build the array at all

The obvious reading of the above - fetch the whole list, build one `sr_cmd_t[400]`, hand
it to `begin()` - is the wrong one, and it is worth saying why before somebody writes it.

`esp_mn_commands_add`, `_phoneme_add`, `_remove`, `_clear` and `_update` are all linked
and all callable from the sketch. Both headers are already on every sketch's include path
in this core - `esp-sr/include/esp32s3` and `esp-sr/src/include` are both in
`flags/includes`, so including `esp_mn_speech_commands.h` needs no path hack. The wrapper
does not expose them, but nothing stops us using them directly:

1. Start SR with no commands at all at boot. The wake word works immediately.
2. Fetch the vocabulary a page at a time - 50 names to a response.
3. `esp_mn_commands_add(id, name)` per name as each page lands.
4. One `esp_mn_commands_update()` at the end.

**What that avoids, in order of how much it matters:**

- **The device is never deaf because the Pi is down.** Registering through `begin()` means
  no vocabulary implies no `begin()` implies no wake word at all. Deaf, not degraded, and
  for a box whose entire job is answering questions that is the worst failure mode
  available. Starting SR before the vocabulary arrives is not an optimisation, it is the
  difference between degrading and dying.
- **The 104 KB command array stops existing.** `sr_cmd_t` is 260 bytes and
  `SR_CMD_STR_LEN_MAX` is 256 - a fifth of internal SRAM to hold strings that are mostly
  padding, on a chip that will also be hosting AFE and MultiNet buffers.
- **The 12 KB JSON line stops existing.** `handleIncomingLine` builds `serialLineBuffer` a
  character at a time into an Arduino `String` on the internal heap, then hands it to a
  `JsonDocument` on the same heap. At 12 KB that is quadratic reallocation, fragmentation,
  and plausibly 30-40 KB of internal SRAM live at once - at exactly the moment SR is
  trying to allocate. 50 names a page is a line the existing transport already handles.
- **`loop()` keeps running between pages.** Heartbeats to the Pi, the OLED, the matrix.
  A single blocking registration of the whole catalogue stops all three for however long
  400 `flite_g2p()` calls take, which is still unmeasured.

### Version the vocabulary, and cache the phonemes against that version

Return a hash of the list alongside it, and store hash plus phonemes in `nvs`. Two things
fall out for almost no work:

- **`flite_g2p` becomes a first-boot cost rather than an every-boot one.** Feed the cached
  phonemes to `esp_mn_commands_phoneme_add` and skip g2p entirely.
- **"Reboot the box" becomes "next heartbeat".** The device already asks the Pi something
  every 30 seconds. Comparing one hash is cheap enough to do there, and re-syncing a
  running model is what the add, remove and update calls are for.

Neither is required for Phase 3 to work. Both are cheap enough that designing the endpoint
without a version field would be the mistake.

## Decision 3: local first, Whisper on anything short of certain - but the fallback is not free

**Corrected 2026-09-02.** The first draft of this section described a fallback that cost
nothing and lost nothing. Both halves were wrong, and the correction changes the design
rather than just the wording.

### What the first draft said, and why it does not hold

The claim was: set `set_det_threshold` high, and anything the model is not sure about
surfaces as `ESP_MN_STATE_TIMEOUT`, which becomes the Whisper trigger - so **"the worst
case is today's behaviour."**

Two problems, both in the core's source:

- **`set_det_threshold` cannot be reached.** It is a function pointer on `esp_mn_iface_t`
  and needs the `model_data` handle. Both live inside the file-static `g_sr_data` in
  `esp32-hal-sr.c`, and there is no getter. Calling `sr_start()` directly does not help -
  it creates the model internally too. The knob the plan was built around does not exist
  at the sketch level.
- **The timeout is a clock, not a confidence signal.** `esp32-hal-sr.c` creates MultiNet
  with a duration argument of 5760. That is the detection window in milliseconds.
  `ESP_MN_STATE_TIMEOUT` does not mean "unsure", it means **5.76 seconds have elapsed
  since the wake word**. By the time it fires the person has long finished speaking, and
  the audio they spoke is gone.

So the real worst case was: today's round trip, **plus** ~5.8 seconds of dead air,
**plus** the box asking them to say it again. That is not today's behaviour, it is
noticeably worse than the touch pad, and it would have been discovered on hardware rather
than on paper.

### What to build instead: tee the audio on its way past

`sr_start()` is declared in the public `esp32-hal-sr.h` and takes a fill callback. The
wrapper's own callback does nothing but read the `I2SClass`. So skip `ESP_SR.begin()`,
call `sr_start()` with our own fill callback, and have it copy each chunk into a PSRAM
ring buffer on its way to the AFE.

Then on `SR_EVENT_TIMEOUT` the last few seconds of audio are already in hand and go
straight to `voice/audio`. **The person says the tool name once.** The fallback costs the
detection window and nothing else, and the original claim - that a miss costs roughly what
was already being paid - becomes true rather than aspirational.

It also removes the I2S race outright: with the tee there is exactly one reader of that
peripheral, forever. See Gotchas.

### The threshold, if it is still wanted

Two ways to get one, and the choice belongs in Phase 1 rather than Phase 3 because it
decides what Phase 3 is:

- **Per-phrase.** `esp_mn_phrase_t` carries a `float threshold`, default 0. Reachable
  through the command list without touching `model_data`.
- **Vendor `esp32-hal-sr.c` into the sketch.** It is Unlicense or CC0, which is the same
  reason the Grove matrix driver is vendored here with a `docs/SOURCES.md` entry. That
  single move buys the model-level threshold, the re-arm fix, the tee, and access to the
  five candidates below - all in one file we control.

### What is given up on a local hit

The underlying result carries up to five candidates with probabilities
(`ESP_MN_RESULT_MAX_NUM`), but the Arduino callback collapses them to one `command_id`.
`matchBestOverlap` deliberately returns every screwdriver and lights every row; a local hit
through the wrapper cannot do that. Letting ambiguity fall through to Whisper, where
`resolveToolQuery` already handles it properly, is still the right default. Vendoring the
hal is the way to stop giving the candidates up, if it turns out to matter.

## Decision 4: 400 is a ceiling on phrases, and the Pi enforces it

`ESP_MN_MAX_PHRASE_NUM` is 400, compiled into the prebuilt archive. Editing the header
does nothing.

**It counts phrases, not tools.** Multiple phrases can share a `command_id`, which is how
"needle nose pliers" and "needle-nose pliers" would both reach one drawer. At 400 tools
that budget is exactly one phrasing each.

So the device takes a list of N and registers it, and **the Pi decides what N is and what
is in it.** Sixty tools or four hundred is the same firmware. If the list ever comes back
over budget the Pi truncates it, ranked, and logs what it dropped - the box degrades
honestly instead of half-registering in silence.

**The Pi should enforce the length limits too, not just the count.**
`ESP_MN_MAX_PHRASE_LEN` is 63 characters and `ESP_MN_MIN_PHRASE_LEN` is 2. Note that
`sr_cmd_t.str` is 256 bytes, so nothing rejects an over-long name until deep inside
`esp_mn_commands_update()`. Checking on the Pi means a bad tool name is visible in the
dashboard next to the tool, rather than inferred from an error list that came back over
serial.

**Storage does not raise the 400 and should not be proposed as a fix.** 400 tool names is
about 12 KB of text; the existing 20 KB `nvs` partition would hold them several times
over. The limit is in the recogniser's search graph. An SD card - and the Sense board has
a slot, and `CONFIG_MODEL_IN_SDCARD` is real in esp-sr, though off in the prebuilt libs -
would only relocate the 3.2 MB model blob off flash. It adds no vocabulary.

The honest reason not to want more than 400 is accuracy, not memory. Closed-set
recognition gets worse as the set grows and tool names crowd together phonetically
("half inch socket" against "half inch wrench"). Decision 3 is what keeps that from being
a user-visible failure.

---

## The partition change

The device's flash is not a folder. It is a fixed map of regions, set at flash time, and
every byte belongs to a region whether anything is in it or not. **Old builds do not
accumulate there** - there are exactly two app slots, permanently, and OTA alternates
between them.

So "full" means over-allocated, not cluttered:

| Region | Reserved | In use |
|---|---|---|
| `app0` | 3,342,336 | 1,091,984 |
| `app1` | 3,342,336 | 1,091,984 |
| `spiffs` | 1,572,864 | nothing - no filesystem code in the sketch |

Roughly 5.8 MB reserved and idle. Redrawing it:

```
# Name,   Type, SubType, Offset,   Size,     Note
nvs,      data, nvs,     0x9000,   0x5000
otadata,  data, ota,     0xe000,   0x2000
app0,     app,  ota_0,   0x10000,  0x250000  # 2,424,832 - 2.2x the current binary
app1,     app,  ota_1,   0x260000, 0x250000
model,    data, spiffs,  0x4B0000, 0x340000  # 3,407,872 - the blob is 3,340,296
coredump, data, coredump,0x7F0000, 0x10000
```

Ends on 0x800000 exactly. `spiffs` is gone because nothing uses it. **OTA survives** -
both slots are still there, right-sized. The partition must be labelled exactly `model`:
`sr_start()` calls `esp_srmodel_init("model")` and nothing else will be looked at.

**The app/model split is the knob, and it is worth turning deliberately.** The first draft
gave the model 0x3E0000, which is 706 KB more than the blob needs, and took it out of the
app slots. The table above leaves the model 66 KB of headroom instead and hands the rest
to the application. If a future core bump grows `srmodels.bin`, 0x240000 app slots against
a 0x360000 model is the same table with the balance moved back.

**Measure before choosing.** Linking `ESP_SR` pulls in `libdl_lib.a`,
`libespressif__esp-tflite-micro.a`, `libespressif__esp-nn.a` and `libflite_g2p.a`. The
current binary is 1,091,984 bytes and that number is about to grow by an amount nobody
here has measured. Phase 1 produces it. **Pick the slot size from the measurement, not
from this table**, because getting it wrong costs a trip to the box with a cable.

Four things this forces:

1. **It cannot ship over OTA.** A partition table change is not an application update.
   This is one `flash-device.ps1` run at the box. Every `esp_sr_*` scheme in the core is
   16 MB-only, so the partition file is ours, not the core's - a `partitions.csv` in the
   sketch folder is picked up by the core's prebuild hook and overrides the board's
   scheme.
2. **The merged image carries the table but not the model, and that is a trap.**
   **Corrected 2026-09-02.** Good news first: the merge recipe writes the partition table
   at 0x8000, so `flash-device.ps1` already delivers the new map, and the first draft's
   "plus a separate esptool write of the table" was unnecessary. The bad news is worse
   than the good news is good. The recipe is hardcoded to bootloader, partitions,
   `boot_app0` and the app - **the model blob is not in it** - and it pads to the full
   8 MB. `flash-device.sh` writes that at 0x0. So **every USB recovery flash zeroes the
   model partition**, and the device comes back with recognition silently broken. The path
   this whole plan leans on destroys the feature's data every time it runs.
   The fix belongs in `release-firmware.ps1`: re-run the esptool merge with
   `0x4B0000 srmodels.bin` added. The core already drops `srmodels.bin` into the build
   directory whenever `ESP_SR` is linked, so the file is sitting there. Recovery stays one
   command and the image stays 8 MB.
3. **Every existing merged image becomes a hazard.** Everything in `api/firmware/` from
   0.10.0 onward carries the `default_8MB` table. Flashing one after this change restores
   the old map and destroys the model partition, and `flash-device.sh` only guards on file
   size so nothing stops it. This is why the pruning note at the bottom of this document
   stops being housekeeping - at minimum the flash script needs a version floor.
4. **`upload.maximum_size` will lie.** The XIAO's `default_8MB` menu entry sets it to
   3,342,336 in `boards.txt`, and a sketch-folder `partitions.csv` does not change it.
   `arduino-cli` will happily build a 2.5 MB binary for a 2.3 MB slot and say nothing at
   all. `release-firmware.ps1` needs its own size check against the real slot.

**It is exactly the kind of change `PLAN-usb-flashing.md` was built for.** Get the table
wrong and the device does not boot. The ROM bootloader is the way back, and it has been
proven on a deliberately bricked device.

One cosmetic note so nobody chases it: `esp32-hal-sr.c` opens with a `#warning` that a
compatible partition must be selected, keyed on the core's own `esp_sr_8/16/32` scheme
names. Our `build.partitions` stays `default_8MB` whatever the sketch `partitions.csv`
says, so the warning fires on every build and means nothing.

---

## Phases

**Phase 1 answers the question the rest of the plan depends on.** Do not build Phase 2
until it has passed - if this microphone will not drive WakeNet in this workshop, nothing
downstream matters, and the cheapest way to find out is a throwaway sketch.

## Phase 1 - does this microphone work with ESP-SR at all

### Design

Repartition, flash the stock `ESP_SR` `Basic` example with the PDM pins changed to 42/41
and mono input, and stand in the workshop saying "Hi ESP".

Nothing from this phase ships. It exists to retire one risk: the spec records this audio
sitting at **4-10% of full scale, with no gain applied and the DC offset not stripped**.
Whisper tolerates that. WakeNet is fussier, and a wake word that needs shouting is worse
than the touch pad it replaces.

### Steps

1. Write `firmware/smarttoolbox/partitions.csv` with the table above. Arduino picks up a
   `partitions.csv` from the sketch folder.
2. Flash it over USB, plus `srmodels.bin` at 0x4B0000. Confirm the device still boots and
   the existing firmware still runs from a 2.3 MB slot.
3. Flash the modified `Basic` example. **Mono needs two settings, not one:** the input
   format string `"M"` *and* `SR_CHANNELS_MONO` passed to `begin()`. The default channel
   argument is stereo, which gives an I2S channel count of 2 against a feed channel count
   of 1, and the assertion in `sr_start` aborts the boot. Presents as "the device will not
   start", which is a long way from its cause.
4. Watch the serial log for the wake event.
5. Say it twenty times from where a person actually stands. Count the misses.
6. Then say a few of the example's command phrases and count those.
7. **Record the compiled binary size with `ESP_SR` linked.** One number, written into this
   document, and the app slot sizing stops being guesswork.

### Done when

- A number exists for how often "Hi ESP" fires from normal speaking distance.
- A number exists for command recognition on the same mic.
- A number exists for the ESP-SR-linked binary size, and the partition table above has
  been confirmed or adjusted against it.
- If either recognition number is bad, this plan stops here and says so in its `status:` -
  with the numbers, so the next person does not repeat it. Gain and DC-offset correction
  on the mic feed would then be the prerequisite, not a tweak.

---

## Phase 2 - the wake word in the real firmware

### Design

`ESP_SR` replaces the touch pad as the trigger. The pad stays wired and working: it is
the thing that still functions when recognition does not, and it costs nothing to keep.

### Steps

1. Start SR in `setup()`, **before** the Pi readiness handshake rather than after - see
   Decision 2 on why waiting makes the box deaf rather than degraded when the Pi is down.
2. On `SR_EVENT_WAKEWORD`, run the recording path that the touch pad runs today. Mono does
   not raise `SR_EVENT_WAKEWORD_CHANNEL`, so the mode switch has to happen in the
   `SR_EVENT_WAKEWORD` branch.
3. **Re-arm after every event.** See Gotchas - this is the one that will look like a
   hardware fault.
4. Handle the I2S conflict - see Gotchas.
5. Show the wake state on the OLED and the matrix. A box that is listening should look
   like it, or the first failure is indistinguishable from the second.

### Done when

- Saying "Hi ESP" starts a recording that reaches Whisper and lights a row.
- Saying it **twice in a row** works twice. That is the re-arm bug, and it earns its own
  line in the acceptance criteria because the first time is not the test.
- The touch pad still does the same thing.
- Firmware version bumped, released, and the spec's Feature 2 wake-word scope corrected.

---

## Phase 3 - the local vocabulary, and the fallback

### Design

The Pi gains a paged endpoint that returns the tool vocabulary and a version hash. The
device pages it in during the readiness wait it already sits through - the Pi takes 36.6s
to come up, and 400 `flite_g2p()` calls have to happen somewhere. It registers
incrementally as pages arrive, rather than building one array and handing it to
`begin()` - see Decision 2 for why.

Registration failures are reported, not swallowed: `esp_mn_commands_update()` returns an
error struct listing every phrase that could not be added, which is how a tool name full
of digits and fractions announces itself instead of going quietly deaf.

### Steps

1. Pi side: an endpoint returning a page of tool names plus a version hash, ranked, and
   truncated with a log line when the catalogue exceeds the budget. Reject names outside
   2-63 characters here, where the dashboard can show it.
2. Device side: page in the vocabulary during the readiness wait, `esp_mn_commands_add`
   per name, one `esp_mn_commands_update()` at the end. No command array.
3. Cache phonemes in `nvs` against the version hash, so g2p is a first-boot cost.
4. Report the registration failures back to the Pi so they land in the request log. A tool
   the box structurally cannot hear is worth seeing in the dashboard.
5. Wire the fallback: the tee'd ring buffer from Decision 3, shipped to `voice/audio` on
   `SR_EVENT_TIMEOUT`.
6. Log which path answered - local or Whisper - on every lookup. Without that line there
   is no way to tell a working feature from one that silently falls back every time.

### Done when

- Say "Hi ESP", then a tool the Pi sent, and the matrix lights the row **with no
  transcription in the log**.
- Say a tool it does not know, and the log shows the fallback firing and Whisper answering
  **without the person repeating themselves**.
- Add a tool in the dashboard, reboot, and it is recognised without a reflash.
- Unplug the Pi, reboot the box, and "Hi ESP" still wakes it - it just cannot answer.

---

## Gotchas

- **SR must be re-armed after every command and every timeout.** `esp32-hal-sr.c` sets the
  mode to off on both a detection and a timeout. Without an explicit return to
  `SR_MODE_WAKEWORD` in the event handler, **the box works exactly once and is then
  deaf** - which is the failure that looks identical to a dead microphone, a wrong
  threshold and a frozen peripheral, and is exactly what the Debugging section of the spec
  exists to separate. The stock `Basic` example shows the pattern; it is easy to read past
  because the interesting-looking lines are the command switch.
- **`pause()` is not synchronous.** It sets event group bits. The feed task may already be
  parked inside the fill callback on a blocking `readBytes`, so after `pause()` returns
  that task can still consume the next chunk - racing `recordWhileHeld` on the same
  `I2SClass`. Teeing the audio (Decision 3) makes this moot by having exactly one reader
  of the peripheral. If the tee is not built, the pause has to be drained rather than
  trusted.
- **The OTA check blocks the loop for up to 25 seconds** when the radio cannot associate,
  and SR has to keep detecting through that. **Corrected 2026-09-02:** it does, but not
  for the reason the first draft gave. The tasks are not all pinned to core 0. Feed is on
  core 0; **detect and handler are both on core 1**, at priority 5, 5 and near-maximum
  against `loop()` at priority 1 on that same core 1. Detection survives a blocked `loop()`
  by preempting it, not by living on another core - so the conclusion held and the reason
  did not, which is worth knowing before anyone reasons from it again.
  The real hazard is different and worth watching instead: MultiNet7 defaults to loading
  part of its weights from flash rather than PSRAM, so weights are read **from flash
  during detection**, and `Update.write()` stalls the flash cache. Recognition during an
  OTA write is the thing to test, not core contention.
- **`flite_g2p` runs once per phrase, and it runs on the calling task.** With the
  incremental registration in Decision 2 that cost is spread across pages and `loop()`
  keeps running. Doing it the other way - all 400 inside one `begin()` - stops heartbeats,
  the OLED and the matrix for an unmeasured duration. The task watchdog is set to 5
  seconds with panic enabled, but `loopTask` is not subscribed in this sdkconfig, so a
  long registration stalls rather than panics. Small mercy, easy to mistake for a hang.
- **Digits and fractions are the likely failures.** "3/8 socket", "1/2 inch wrench" -
  flite's letter-to-sound rules were not written for those. They fail at registration,
  visibly, which is the good case.
- **`ESP_MN_MAX_PHRASE_LEN` is 63 characters**, `ESP_MN_MIN_PHRASE_LEN` is 2, and
  `sr_cmd_t.str` is 256 - so nothing rejects an over-long name until deep inside
  `esp_mn_commands_update()`. Validate on the Pi.
- **Recognising a tool with the Pi down gets you nothing.** The drawer mapping is in
  SQLite. Do not be tempted into caching it on the device to make the box work offline;
  that is a second copy of the database to keep in sync.

## Open questions to settle before starting

1. **Is the ten seconds ours to fix at all?** A warm container and a faster Whisper backend
   may take 9.3s to under 2s for an afternoon's work and no partition change. See the
   section above. Measure this first - it is the only open question that can make the rest
   unnecessary.
2. **Does this microphone drive WakeNet at 4-10% of full scale?** Phase 1 exists to answer
   it. Everything downstream is contingent.
3. Is "Hi ESP" acceptable to live with? If not, Decision 1 says the plan still works with
   the pad as the trigger, and microWakeWord is the fork worth costing before Phase 2
   rather than after.
4. **Do we vendor `esp32-hal-sr.c`?** Decision 3 needs an answer before Phase 3 is
   designed, not during it. Vendoring buys the detection threshold, the re-arm, the tee
   and the five candidates in one file we control, at the cost of a file we now maintain.
   The Grove driver is the precedent in both directions.
5. How long do 400 `flite_g2p()` calls take on this chip - and does the `nvs` phoneme
   cache make it a question that only matters once?
6. Does the I2C traffic to the OLED and matrix disturb SR timing? **Probably the wrong way
   round:** the detect task at priority 5 preempts `loop()` at priority 1 on the same core,
   so the thing to watch is SR starving the display - stretched `matrixPush()` and U8g2
   transfers, a wave animation that stutters while the box is listening.
7. Ranking: when the catalogue exceeds the budget, ranked by what? `request_logs.tool`
   holds the raw query or transcript, not the canonical name, so counting it needs either
   a resolve at query time or a `resolved_tool` column. Not needed until a real catalogue
   passes 400 - which, at five drawers, is not soon.

## Done when

- "Hi ESP", a tool name, and the right row lights with no Whisper call.
- An unknown tool falls through to Whisper and is answered correctly, without the person
  repeating themselves.
- A tool added in the dashboard is recognised after a reboot, with no firmware release.
- `bun test` covers the vocabulary endpoint, its paging, and its truncation.
- `release-firmware.ps1` merges the model blob into the merged image, and checks the app
  binary against the real slot size rather than the stale `upload.maximum_size`.
- Spec: the Microphone section records that ESP-SR runs on this mic and at what
  reliability; Feature 2 stops saying a wake word is out of scope and describes the
  hybrid; the Communication Protocol gains the vocabulary endpoint; and the custom
  partition table is documented next to the OTA description, because the next person to
  run `release-firmware.ps1` needs to know the slots are no longer 3 MB.
- `xiao-esp32s3-firmware.instructions.md` gains the I2S-ownership trap, the re-arm trap,
  and a note - in the spirit of the `PSRAM=opi` one - that the models live at 0x4B0000 and
  that a merged image without them silently disables recognition.

---

## Unrelated to the space problem, but no longer unrelated to this plan

Filed here because it came up in the same conversation. **Nothing deleted here frees a
single byte on the device** - but the 2026-09-02 review found that these files stop being
merely large once the partition table changes.

`api/firmware/` holds every release since 0.10.0 - **56 MB**, including 8 MB merged
recovery images - and `release-firmware.ps1 -Push` mirrors it to
`~/smarttoolbox/firmware/` on the Pi, whose storage is an SD card.

`firmware.ts` serves the newest by version, so older builds exist only for rollback.
Keeping the last two or three plus the current merged image is enough. Worth a prune step
in `release-firmware.ps1` rather than a one-off cleanup, so it does not grow back.

**The part that is now load-bearing:** every one of those merged images carries the
`default_8MB` partition table. After the repartition, flashing any of them silently
restores the old map and destroys the model partition, and `flash-device.sh` only checks
file size so nothing stops it. Whatever else the prune does, `flash-device.sh` needs a
version floor before Phase 1 ships - refusing to flash a merged image built before the
repartition is a two-line change, and the alternative is a recovery path that quietly
breaks the thing it was used to recover.
