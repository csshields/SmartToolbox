---
title: Plan of Attack - Startup Readiness (wait for the Pi, and look like you mean it)
scope: implementation plan, written 2026-08-28 - boot handshake and a loading face
status: not started
---

# Plan: don't say "Ready" until the Pi can actually answer

One sentence of scope:

> From power-on until the Pi answers, the box shows a loading smiley and refuses to
> pretend it works. The moment the Pi replies, it settles into the idle eyes.

## The problem, measured rather than guessed

Both halves of this project boot from the same power, and they do not arrive together:

| | time from power-on |
|---|---|
| XIAO finishes `setup()` and shows "Ready" | **~4s** |
| XIAO starts asking for a firmware update | ~3.5s |
| XIAO gives up on that check (25s Wi-Fi timeout) | ~30s |
| **Pi finishes booting** (5.2s kernel + 31.4s userspace) | **36.6s** |
| Pi's API accepts its first request | later still |

For roughly the first **thirty-three seconds**, the box says `Ready` and means nothing
by it. That gap produced every confusing symptom of 2026-08-28:

- A touch in that window sends a lookup into a void and paints `No response - Is the
  Pi service up?`, which is a question the device is not entitled to ask yet. The Pi is
  fine. It is booting.
- The boot `device/status` is sent to a port nobody has open, so the dashboard shows an
  empty firmware version and a device that has never been seen.
- The firmware update check loses by about ten seconds, every time, by construction.
  See `docs/PLAN-ota-updates.md` for that half - already fixed in 0.16.0 by re-checking
  two minutes after boot, but the underlying race is the same one.

The device is not broken during this window. It is early. Nothing in the current
firmware distinguishes those two things, and that is the whole bug.

## The shape of the fix

The XIAO is the half that boots fast, so the XIAO is the half that waits. No change to
the Pi: nothing it can do about a 31-second userspace, and a device that copes is worth
more than a server that hurries.

Add a third startup state between "powered on" and "ready":

1. `setup()` ends in **WAITING**, not READY.
2. While waiting, send `device/status` every **2 seconds** and watch for any reply.
3. The first reply of any kind - success or error, the content is irrelevant - proves
   the link end to end and promotes the device to **READY**.
4. Touches during WAITING do not send lookups. They are the user asking "is it on?",
   and the honest answer is on the screen already.
5. There is no failure state and no timeout. A Pi that takes five minutes gets waited
   for. The box is a drawer of tools, not a request with a deadline.

The 2-second retry is deliberately far more frequent than the 30-second heartbeat: this
window is ~35 seconds long, and a 30-second poll would spend most of it asleep.

## The loading face

**A smiley, not a spinner.** The idle face is already a smiley (`drawFace`), and the
thinking face is a quizzical variant (`drawThinkingFace`). The waiting face should read
as the same character doing something patient - not as an error, and not as a
progress bar with a personality bolted on.

`drawLoadingFace(uint8_t phase)`, in the shape of the two that exist:

- **Keep the smile exactly as `drawFace` draws it.** Corners at `(1,5)` and `(6,5)`,
  middle across `y=6`. It is the mouth that makes the face friendly, and it should not
  move - a mouth that animates reads as talking or chewing.
- **Animate the eyes by looking around.** Both 2x2 eyes shift horizontally together
  through a four-phase cycle - left, centre, right, centre - so the box reads as glancing
  about while it waits for something. Same `EYE_COLOR` (purple) as every other idle
  state, because this *is* an idle state.
- **Reuse the thinking-face cadence.** `MATRIX_THINK_STEP_MS` (280ms) already looks
  right on this panel; a fifth state with its own timing constant is a fifth thing to
  tune.

Eye columns per phase, with the existing 2x2 eyes at `y=2..3`:

| phase | left eye x | right eye x |
|---|---|---|
| 0 | 0 | 4 |
| 1 | 1 | 5 |
| 2 | 2 | 6 |
| 3 | 1 | 5 |

That keeps both eyes on the panel at every phase and returns through centre, so the
sweep reads as looking rather than sliding.

**Add `MATRIX_WAITING` to `MatrixMode`**, and give it a branch in `updateMatrix()`
before the `MATRIX_THINKING` one. It must not blink: `scheduleNextBlink` belongs to the
idle-eyes path, and a blink on top of a sweep reads as a glitch.

## The OLED, in the same window

`showStatus("SmartToolbox", "Waiting for Pi", "v" FIRMWARE_VERSION)`. The version stays
visible because this is exactly when someone wants to know what is running, and the
line it replaces (`Touch a pad`) is an instruction the box cannot honour yet.

On promotion to READY, the existing `showStatus("SmartToolbox", "Ready", ...)` fires as
it does today. That transition is the whole user-visible payoff: the face settles and
the screen changes at the moment the box actually starts working.

## Steps

### Step 1 - the state exists, with no face yet

`deviceReady` flag, WAITING entered at the end of `setup()`, 2-second `device/status`
retry, promotion on first reply, touches suppressed while waiting.

**Done when:** the Pi's log shows repeated `device/status` from a cold boot roughly two
seconds apart, stopping once answered - and the dashboard shows a firmware version
after a whole-box power cycle, which it does not today.

### Step 2 - the loading face

`drawLoadingFace`, `MATRIX_WAITING`, the `updateMatrix()` branch.

**Done when:** a cold boot shows the eyes sweeping over a fixed smile, and it settles
into the normal blinking idle face the instant the Pi answers.

### Step 3 - the honest touch

A touch during WAITING re-draws the waiting status rather than sending a lookup.

**Done when:** touching the pad at second 10 of a cold boot never produces
`No response`.

## Traps this plan already knows about

- **Do not diagnose this from the Pi's log.** The S3's USB CDC discards anything
  printed while no host has the port open, so the first seconds of boot output do not
  exist anywhere. The OLED and the matrix are the only witnesses to the window this
  plan is about. This cost hours on 2026-08-28; see the firmware instructions.
- **The first reply may be an error, and that is still success.** Promotion is about
  proving the wire works, not about the Pi liking the message. Treat any parsed
  response as the handshake.
- **`pollDeviceStatus` already refuses to run while `awaitingResponse`.** The waiting
  retry must not reuse that guard as-is, or a single unanswered status will wedge the
  device in WAITING forever - which is precisely the failure this plan exists to remove.

## What this deliberately does not do

- **No change to the Pi.** Shaving its 31-second userspace is a different project with a
  worse payoff.
- **No timeout, no error state.** A box that gives up on its own server is worse than
  one that waits; the waiting face is honest indefinitely.
- **No bearing on the microphone work.** `docs/PLAN-mic-bringup.md` is unaffected -
  recording never involved the Pi until Step 2 of that plan.
