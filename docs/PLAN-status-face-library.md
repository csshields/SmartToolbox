---
title: Plan of Attack - extract the status face into a reusable library
scope: implementation plan, written 2026-09-02 - lift the matrix state/picture layer
  out of smarttoolbox.ino into a standalone Arduino library, after a survey found
  nothing existing that covers it
status: PLANNED - nothing built. Phase 0 is a pure refactor whose acceptance test is "the
  same pictures with the same timings", so it is safe to start any time. Publishing
  (Phase 4) must not happen until Phase 3 has driven a second, non-Grove display -
  before that the abstraction is a guess, and the library name is permanent.
---

# Plan: a status vocabulary for displays too small for a face

One sentence of scope:

> The pictures the box uses to say what it is doing - idle, thinking, listening,
> booting, an answer, three kinds of failure - become a library another project can
> depend on, without dragging SmartToolbox's drawers, certainty scores or Grove panel
> along with them.

## Context: what the survey found

Searched before designing. Three families of library exist and none of them is this.

**Robot faces.** [FluxGarage RoboEyes](https://github.com/FluxGarage/RoboEyes) draws
animated eyes over Adafruit_GFX with moods (happy, tired, angry, default), an
autoblinker, and tweened transitions. [M5Stack-Avatar](https://github.com/meganetaaan/m5stack-avatar)
does the same on M5Unified hardware with a component tree of eyes, mouth and eyebrows.
Both assume a framebuffer large enough for the eye to be a *shape* - rounded corners, a
border radius, sub-pixel motion. At 8x8 an eye is four pixels and every one of those
techniques is unavailable. Both are also faces only: they have no answer to "now show a
result and go back to idle in four seconds".

**Status LEDs.** [JLed](https://github.com/jandelgado/jled),
[Blinkenlight](https://github.com/tfeldmann/Arduino-Blinkenlight),
[statusLED](https://github.com/TheDIYGuy999/statusLED),
[GFLED](https://github.com/geekfactory/GFLED). These have the right *architecture* -
declarative patterns, an effect state machine, a non-blocking `update()` driven from
loop - and it is worth stealing. They drive a single LED's brightness. One channel.

**8x8 emoji tutorials.** LedControl or MaxMatrix plus a hand-drawn byte array per face.
That is the bitmaps and nothing else: no animation, no timing, no state.

And the Grove driver already vendored here exposes `displayEmoji()` with 30 built-in
glyphs, which this firmware deliberately does not use - the panel applies its
orientation setting to on-device glyphs separately from user frames, so a built-in
emoji and a hand-drawn face would not agree on which way is up (see the `DIGIT_GLYPHS`
comment in `smarttoolbox.ino`).

**Conclusion: build it**, and move *both* halves - the bitmaps and the rules that govern
them.

The bitmaps go over verbatim, pixel for pixel: the octagon spinner ring, the knocked-out
alert triangle, the 5x7 question mark, the 3x5 digits, the idle/sad/thinking faces, the
waveform height table. They are the bulk of the code and they are the whole point of not
starting from scratch on the next project.

But they are not, on their own, worth a library - anyone can draw a sad face in twenty
minutes. What makes this worth packaging rather than copying is that the bitmaps travel
with the judgments about *when* to show each one, for how long, and in what colour.
Those judgments are currently comments buried in a 1890-line sketch:

- Purple is reserved. It is never a result colour, so the idle face can never be
  mistaken for an answer.
- The spinner lights 6 of 16 cells, because the *gap* is the part you read.
- The spinner's leading cell is white and its tail purple, because a uniform arc does
  not tell you which way it is turning.
- The alert triangle is filled with the exclamation knocked out as unlit pixels,
  because an outline triangle loses its shape at this size.
- The waveform is the only multi-colour picture, so nothing else looks remotely like
  "I am listening to you right now".
- A result shows the spatial cue first, then the unambiguous digit, because one lit row
  and the digit 1 look alike.
- Every state except a result has one expression and one hold; a result has two phases
  and the second gets twice the time, because it is the part you have to carry away.

A second project gets both halves from three lines:

```cpp
StatusFace face(canvas);
face.begin();
face.setStatus(Status::Working);
```

and inherits the tuned spinner, the blink at its random 2-6s interval, the thinking dots
at 280ms with the eye swap at 2800ms, and three visually distinguishable failure
pictures - without redrawing or re-tuning any of it.

## What the layers are, and why the current code cannot ship as-is

Today all three of these are fused. `drawSadFace()` writes into a file-scope
`matrixFrame[]`; `showMatrixSad()` sets `matrixMode`, computes `matrixResultUntil` and
calls `matrixPush()`; `updateMatrix()` reaches into `deviceReady` and `waitingLong`,
which are startup-readiness policy that has nothing to do with drawing.

Three layers, to be separated in that order:

**1. Canvas (the backend).** `clear()`, `setPixel(x, y, colour)`, `push()`. That is the
entire contract. It keeps the dirty-frame check that already exists, which is
load-bearing rather than tuning: a full 1KB frame over I2C costs ~10ms and pushing every
loop would starve the serial poll. One adapter per display.

**2. Scenes (the pictures).** `drawIdleFace`, `drawThinking`, `drawSpinner`, `drawWave`,
`drawAlert`, `drawQuestion`, `drawDigit`, `drawRow`. Pure functions of (canvas, phase,
colour). No timers, no state, no `millis()`.

**3. State machine (the vocabulary).** `setStatus(...)` plus `update()` from loop. Owns
every duration, every phase clock, the two-phase result, and the return-to-idle rule.

The canvas boundary is what makes this a library rather than a copy-paste. Note that it
also has to be a *hard* boundary for a packaging reason: the Grove driver is not in the
Arduino registry - it is vendored here precisely because it cannot be depended on (see
`sketch.yaml`). So the library must not `#include` it. The Grove adapter is a thin
header the *application* provides, or ships as an optional example, with the driver
staying vendored on the application side.

## The API, sketched

```cpp
enum class Status {
  Booting,      // spinner - starting up, not yet able to answer
  Idle,         // blinking face - fine, waiting for you
  Listening,    // waveform - taking input right now
  Working,      // thinking face - request in flight
  Success,      // a value to read, two phases
  Empty,        // sad face - understood, found nothing
  Unrecognised, // question mark - did not understand
  Fault,        // alert triangle - something is wrong
  Stalled,      // sad face - Booting has gone on too long
};

StatusFace face(canvas);
face.begin();
face.setStatus(Status::Working);
face.showValue(3, Colour::Green);   // spatial cue, then the digit
face.update();                      // from loop(), non-blocking
```

Two things the API must get right, both learned the hard way in this firmware:

- **`Stalled` is a distinct state, not a `Fault`.** The box that has waited 90 seconds
  for a Pi that is merely slow to boot has nothing to report as an error, and spending
  the loudest picture there leaves nothing louder for a lookup that genuinely fails.
- **Returning from a transient state must consult the underlying one.** Falling through
  from `Success` straight to `Idle` is the bug fixed at `updateMatrix()`'s
  `if (!deviceReady)` branch: it left a happy "I am fine" face on a box that could not
  answer anything. The library needs a `setBaseStatus()` separate from the transient
  overlay, so this is structural rather than something each consumer rediscovers.

## What stays in SmartToolbox

The library gets *generic* states. The application maps its own meaning onto them, and
none of the following moves:

- A digit meaning "drawer row", and the 1-6 valid range.
- `certaintyColor()` and its 75% threshold.
- `deviceReady` / `waitingLong` and the whole startup-readiness policy - it *drives*
  `setBaseStatus()`, it does not live inside it.
- The OLED text lines. Out of scope; possibly a second library, never this one.

## Phases

### Phase 0 - extract in place, prove nothing changed

Move the matrix code out of `smarttoolbox.ino` into `matrix_ui.h` / `matrix_ui.cpp`
*inside the sketch folder*, still SmartToolbox-specific, still calling the Grove driver
directly. No API design yet. Public names unchanged, so the diff in the `.ino` is
includes and deletions.

**Acceptance test: the same pictures with the same timings on real hardware.** Boot
spinner, idle blink at its random 2-6s interval, thinking dots at 280ms with the eye
swap at 2800ms, wave, a lookup result showing row for 2s then digit for 4s, sad,
question mark, alert, and the 90-second stall. Flash it, watch it, then diff nothing.
This is the phase that makes every later phase safe.

### Phase 1 - split canvas from scene from state

Introduce the three layers behind the Phase 0 names. `MatrixCanvas` gets the dirty flag
and the push. Scenes lose their access to `matrixFrame` and take a canvas. The state
machine loses its access to `deviceReady` and gains `setBaseStatus()`.

Same acceptance test. Same hardware. Still one repo.

### Phase 1b - the generated glyph gallery, and the test it gives you

A page showing every scene, animating at its real cadence, served from the library
repo. Worth doing here rather than "later": it is how glyphs get designed without
flashing firmware, and it pays for itself twice over (below).

**Do not hand-port the glyphs to JavaScript.** Checked, and only half the scenes are
data: `DIGIT_GLYPHS`, `QUESTION_GLYPH`, `SPINNER_RING` and `WAVE_HEIGHTS` are exportable
tables, but `drawFace`, `drawSadFace`, `drawThinkingFace` and `drawAlertTriangle` are
pure imperative pixel-setting with no table to export, and `drawSpinner` has logic on top
of its table (leading cell white, tail purple). Exporting tables cannot reproduce the
set, and a hand-written port diverges the first time a pixel moves.

**Generate it from the shipped C++.** After Phase 1 the scene functions are pure -
`(canvas, phase, colour) -> pixels`, no Arduino dependency - so a host compiler can run
them directly:

```
tools/dump-frames.cpp     host build against a MemoryCanvas, no Arduino, no board;
                          walks every scene x every phase, plus the timing constants
docs/frames.json          generated
docs/index.html           static gallery, served by GitHub Pages, linked from the README
```

The page renders the real code's output, so it cannot drift.

Two byproducts worth more than the page:

- **A golden-file regression test.** Phase 0's acceptance criterion is currently "flash
  it and watch it" - eyeballing a 130ms blink on hardware. Have CI regenerate
  `frames.json` and fail on any diff, and an accidental pixel or timing change is caught
  at commit time; the hardware pass becomes confirmation rather than the only check.
- **`MemoryCanvas` is a second backend.** Trivial, but it proves the scenes really are
  display-independent - de-risking Phase 3 before any hardware is bought.

Upgrade path if live interaction is wanted: compile the same functions to WebAssembly
with Emscripten and let the page drive the actual state machine, so a click on "lookup
result" shows the real two-phase transition on real timers. Better for tuning timings,
but it needs a toolchain the JSON dump does not.

**Consider pulling the dump forward into Phase 0.** It is numbered 1b because the clean
version needs the canvas split, but the frames can be captured earlier and crudely -
compile today's `matrixFrame[]` and its draw functions on the host, dump every scene, and
commit the result *before* touching anything. Phases 0 and 1 are then verified by diff
instead of by eyeball, which is a much stronger form of "prove nothing changed" than
watching a 130ms blink on hardware. The hardware pass still happens; it just stops being
the only evidence.

### Phase 2 - lift into its own repo, consumed as a submodule

Own GitHub repo, standard Arduino library layout:

```
StatusFace/
  library.properties
  keywords.txt
  src/StatusFace.h
  src/StatusFace.cpp
  src/backends/GroveMatrixCanvas.h   (header-only, no Grove driver include)
  examples/GroveMatrix/GroveMatrix.ino
  README.md
  LICENSE
```

**This is checked and it works.** `arduino-cli` 1.3.0+ supports local-directory
libraries in a build profile, and this machine runs 1.5.2-rc.1. The consumption is one
line:

```yaml
profiles:
  release:
    fqbn: esp32:esp32:XIAO_ESP32S3:PSRAM=opi
    platforms:
      - platform: esp32:esp32 (3.3.11)
    libraries:
      - ArduinoJson (7.4.3)
      - U8g2 (2.35.30)
      - dir: ../lib/StatusFace        # relative to the sketch folder
```

with the repo added as a submodule at `firmware/lib/StatusFace`. Nothing in
`release-firmware.ps1` changes - it already calls
`arduino-cli compile --profile release`, and the profile resolves the path itself.

Why submodule rather than the copy-vendoring used for the Grove driver: **the submodule
records a commit SHA, which restores the pinning that `dir:` alone gives up.**
`dir:` is a path, not a version, so on its own it would punch a hole in exactly the
reproducibility `sketch.yaml` exists to protect - a library edited on the dev machine
would silently change what ships. The submodule's recorded SHA closes that hole and
makes a firmware bump an explicit commit in this repo. The Grove driver is copy-vendored
instead because it is dead upstream and never changes; StatusFace is the opposite case.

Three consequences to handle rather than discover:

- **A fresh clone needs `git clone --recurse-submodules`**, or `git submodule update
  --init` after the fact. Without it the build fails with a confusing missing-header
  error. This belongs in `CLAUDE.md` under "Working here" and in the library's README.
- **Only the dev machine needs the submodule.** Verified: `release-firmware.ps1` is the
  only thing that compiles, it runs on Windows, and `flash-device.ps1` ships a prebuilt
  `.merged.bin` to the Pi over scp. The Pi never sees a compiler, so nothing about
  deployment changes.
- **Publishing later is additive and reversible.** When Phase 4 comes, swap
  `- dir: ../lib/StatusFace` for `- StatusFace (1.0.0)` and drop the submodule. One
  line. That is why this ordering is safe: nothing here is a bet on the library ever
  being published.

Do **not** install the library into `~/Documents/Arduino/libraries` and rely on that.
The profile build ignores globally installed libraries by design, and that design is
load-bearing - it is the reason updating a library for an unrelated project cannot
silently change this firmware.

One more mechanical note: a `.ino` sketch cannot itself host a library, which is why
this has to move out of `firmware/smarttoolbox/` rather than living beside it.

### Phase 3 - a second backend, which is the actual proof

Drive the library from a display that is not the Grove panel. Best candidate is a
**MAX7219 mono 8x8**, because it is cheap, ubiquitous, and mono - which forces the
colour question to be answered honestly rather than deferred. A NeoPixel 8x8 is the
alternative and tests nothing new about colour.

This is where the design earns its shape. Expect the colour model to change here:
today's colours are Grove palette *indices* (`purple`, `green`, `orange`, `white`),
which is a wire format, not an API. The library needs its own `Colour` enum with a
per-backend mapping, and mono backends need a documented degradation - probably that
the vocabulary leans harder on form, since purple-versus-green is exactly the
distinction mono cannot make.

**Do not skip to Phase 4 without doing this.** A library extracted against one consumer
is a guess about what varies.

### Phase 4 - publish to the Arduino Library Manager

Only after a second display works and the README can honestly state the size support.

There is no npm equivalent in this space and npm itself is not one - it is JavaScript's
registry, with no path into a cross-compiled ESP32 binary. The three real options:

- **[Arduino Library Manager](https://github.com/arduino/library-registry)** - the one to
  use. Same index `sketch.yaml` already pins ArduinoJson and U8g2 against. Publishing is
  a single PR adding the repo URL to `repositories.txt`; an automated compliance check
  runs, merges on success, and the library is installable within a day. No account and no
  publish command - after that, **every git tag carrying a valid `library.properties`
  becomes a release automatically**, so cutting a version is `git tag`.
- **[PlatformIO Registry](https://registry.platformio.org/)** (`pio pkg publish`) - better
  dependency resolution, and many libraries publish to both. Skip it: this project builds
  with `arduino-cli`, so it earns nothing until someone else asks for it.
- **[ESP Component Registry](https://components.espressif.com/)** - ESP-IDF only. Not
  applicable while this is on the Arduino core.

**This is what makes open question 1 urgent.** Library Manager names are globally unique
across the whole index, taken from `library.properties`, and unpublishing is awkward. The
name has to be settled before the PR, not after.

## Known constraints, stated rather than discovered later

- **8x8 only, in v1.** Every glyph here is hand-placed for 64 pixels: the question mark
  is 5x7 because narrower reads as a stray hook, the digits are 3x5, the face sits at
  y=2..6 to avoid looking cropped. None of that scales by multiplication. The API should
  be shaped so 16x16 can arrive later with its own glyph set; the README should say 8x8
  and mean it rather than implying generality that does not exist.
- **The dirty-frame push must survive the refactor.** It is a correctness property of
  the serial loop, not an optimisation.
- **No dynamic allocation, no `String`, no blocking.** Same rules the firmware already
  follows.
- **`millis()` rollover** is currently handled inconsistently - most comparisons use
  `millis() >= deadline`, while `pollWaitingLong` uses the correct
  `millis() - start < span` form. The library should use the subtraction form
  everywhere; a 49-day uptime is not hypothetical for something that lives in a
  workshop.

## Open questions

1. **Name.** `StatusFace` reads well and says what it does. Alternatives worth a moment:
   `TinyStatus`, `GlanceUI`, `PixelMood`. It bites twice: at Phase 2 it becomes the repo
   name and the include path, and at Phase 4 it becomes permanent - Arduino Library
   Manager names are globally unique across the whole index, taken from
   `library.properties`, and unpublishing is awkward. Cheap to change at Phase 1,
   annoying at Phase 2, effectively irreversible after Phase 4.
2. **Does the wave belong?** It is the only state that is about *input* rather than
   output, and the only multi-colour picture. It is also the most SmartToolbox-specific
   thing in the set. Keep it, but as an optional scene a consumer can leave out.
3. **Should the library own its timing constants, or take them?** Owning them is what
   makes it a vocabulary rather than a toolkit; the durations here were tuned against a
   person standing at a toolbox. Suggest: own them, expose overrides, and document the
   reasoning so an override is a decision rather than a fiddle.
