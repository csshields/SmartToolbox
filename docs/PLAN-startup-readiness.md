---
title: Plan of Attack - Startup Readiness (wait for the Pi, and look like you mean it)
scope: implementation plan, written 2026-08-28 - boot handshake, spinner, alert triangle
status: written 2026-08-29, compiles, NOT yet run on hardware - Steps 1-5 all implemented
---

# Plan: don't say "Ready" until the Pi can actually answer

One sentence of scope:

> From power-on until the Pi answers, the box shows a spinner and refuses to pretend
> it works. The moment the Pi replies, it settles into the idle eyes.

## The problem, measured rather than guessed

Both halves of this project boot from the same power, and they do not arrive together:

| | time from power-on |
|---|---|
| XIAO starts asking for a firmware update | ~3.5s |
| XIAO shows "Ready", **if** Wi-Fi associates immediately | ~4s |
| XIAO gives up on the update check (25s Wi-Fi timeout) | ~30s |
| XIAO shows "Ready" on the boot this plan is about | **~30s** |
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

1. **WAITING is entered before the OTA check, not at the end of `setup()`.** See "Where
   WAITING starts" below - this is the single biggest correction the review made.
2. While waiting, send `device/status` every **2 seconds** and watch for any reply.
3. The first reply of any kind - success or error, the content is irrelevant - proves
   the link end to end and promotes the device to **READY**.
4. Touches during WAITING do not send *lookups*. They are the user asking "is it on?",
   and the honest answer is on the screen already. The mic bring-up pad is exempt; see
   Step 3.
5. There is no timeout that gives up. A Pi that takes five minutes gets waited for. But
   after 90 seconds the face stops pretending this is normal - see "The long wait".

The 2-second retry is deliberately far more frequent than the 30-second heartbeat: this
window is ~35 seconds long, and a 30-second poll would spend most of it asleep.

## Where WAITING starts

`checkForFirmwareUpdate()` runs *inside* `setup()`, before touch calibration, and blocks
for up to `WIFI_CONNECT_TIMEOUT_MS` (25 seconds) when the radio cannot associate. So
"`setup()` ends at ~4s" only describes a boot where Wi-Fi comes up instantly. On the
cold boot this plan exists for, `setup()` ends at about thirty seconds - and if WAITING
were entered at the end of it, the loading face would appear at 30s, the Pi would answer
at 36.6s, and the whole visible payoff would last six seconds. For the preceding thirty
the OLED would read `Update check / Joining Wi-Fi`.

**Decided 2026-08-29: enter WAITING before the OTA check.** The face and the waiting
status go up first, then `checkForFirmwareUpdate()` runs underneath them. The OTA check
keeps its current position relative to touch calibration, for the reason already
recorded there - there is no point calibrating pads we are about to reboot away from.

The 2-second `device/status` retry cannot run during the blocking check, and that is
fine: nothing is listening in that window anyway. The retry starts when the loop does.

## The loading face: a spinner

**Decided 2026-08-29: a spinner, not a face.** This reverses what this section first
said. The argument for a patient smiley was that the box should stay in character; the
argument against it is stronger, and it is that a smiley means "I am fine" in every
other state the box has. During boot the box is *not* yet fine, and a spinner is the one
symbol every person already reads as "working on it, do not touch yet". The idle eyes
still own every other quiet moment.

`drawSpinner(uint8_t phase)` - a ring of dots with a rotating gap, the shape of a
loading indicator rather than a face.

**The ring is a 16-cell octagon**, which is the roundest closed path 8x8 has room for:

```
. . x x x x . .     y=1: x = 2,3,4,5
. x . . . . x .     y=2: x = 1,6
x . . . . . . x     y=3: x = 0,7
x . . . . . . x     y=4: x = 0,7
. x . . . . x .     y=5: x = 1,6
. . x x x x . .     y=6: x = 2,3,4,5
```

Held as one clockwise table so the animation is an index rather than geometry -
`SPINNER_RING[16]`, starting at the top-left of the top edge:

```
(2,1) (3,1) (4,1) (5,1) (6,2) (7,3) (7,4) (6,5)
(5,6) (4,6) (3,6) (2,6) (1,5) (0,4) (0,3) (1,2)
```

**Six of the sixteen are lit**, at `(phase - k) mod 16` for `k = 0..5`. That leaves a
ten-cell gap, so the lit part reads as the same broken "C" the reference image uses
rather than as a full ring flickering. The leading cell (`k = 0`) is `white` and the
five behind it are `purple`: the head tells you which way it is turning, which a
uniform arc does not, and purple keeps the codebase's rule that purple means "idle or
thinking, never an answer".

**`MATRIX_SPIN_STEP_MS = 90`**, and yes, that is a new timing constant - the existing
`MATRIX_THINK_STEP_MS` (280ms) would take four and a half seconds per revolution, which
reads as broken rather than busy. At 90ms a revolution takes 1.44s, which is about what
a browser spinner does.

That cadence is the one cost worth naming: `matrixPush` is ~10ms of I2C, so the spinner
spends roughly 11% of the loop pushing frames. During WAITING nothing else is competing -
touch is throttled to 50ms and there is no lookup in flight - but this is why the spinner
belongs to the boot window only and not to any state that has to stay responsive.

**Add `MATRIX_WAITING` to `MatrixMode`**, and give it a branch in `updateMatrix()`
before the `MATRIX_THINKING` one. It must not blink: `scheduleNextBlink` belongs to the
idle-eyes path, and a blink on top of a spinner reads as a dropped frame.

**Promotion must call `scheduleNextBlink()`** on the way into `MATRIX_EYES`, exactly as
the `MATRIX_RESULT` branch already does and for the same reason: `matrixNextBlinkAt` was
set back in `setup()` and is long past by then, so without it the face blinks the
instant it settles.

## The long wait

Waiting forever is right for a toolbox and wrong for a bench. If the Pi's service is
down, or the box is on a laptop, or the USB lead is bad, the plan as first written left
the box sweeping its eyes indefinitely with the lookup path dead and no way to ask why -
and it removed the one diagnostic that exists today, `No response - Is the Pi service
up?`.

**Decided 2026-08-29: after `MATRIX_WAIT_LONG_MS` (90 seconds) the face changes.** Ninety
seconds is comfortably past the 36.6s the Pi has ever taken, so a healthy cold boot never
reaches it.

This is **not a fifth `MatrixMode`** and not a new drawing routine. It is a second phase
*within* `MATRIX_WAITING`:

- The spinner stops turning.
- The face becomes `drawSadFace(EYE_COLOR)` - an existing function that already takes a
  colour, drawn in the idle purple rather than the not-found red. The colour is what
  keeps the two apart: purple has meant "idle or thinking, not an answer" everywhere
  else, and this is still not an answer.
- The OLED becomes `showStatus("SmartToolbox", "No reply from Pi", "v" FIRMWARE_VERSION)`.

Nothing else changes. The 2-second retry continues, and a reply at any point promotes to
READY and restores the idle face. This is a change of expression, not a failure state -
the box has not given up, it has just stopped looking relaxed about it.

**Deliberately not the red alert triangle**, even though one now exists - see below. A
box still waiting for a server that has not finished booting has nothing to report as an
error, and spending the alert here would leave nothing louder for the case where a
lookup genuinely fails.

## The error face: a red alert triangle

`showMatrixAlert` currently fills rows 1..6 with a solid red band. That is the loudest
thing the panel can do and the least specific: it says "bad" and nothing else, and it
looks more like a hardware fault than a message. Replace the band with a triangle.

`drawAlertTriangle(uint8_t color)` - filled, with the exclamation mark knocked out as
unlit pixels rather than drawn. At 8x8 an outline triangle loses its shape and a drawn-on
exclamation has nowhere to sit; negative space is what makes both legible at this size.

```
. . . R R . . .     y=0: x = 3,4
. . . R R . . .     y=1: x = 3,4
. . R . . R . .     y=2: x = 2,5        gap at 3,4 - top of the !
. . R . . R . .     y=3: x = 2,5        gap at 3,4
. R R R R R R .     y=4: x = 1..6       solid - the waist of the !
. R R . . R R .     y=5: x = 1,2,5,6    gap at 3,4 - the dot
R R R R R R R R     y=6: x = 0..7       base
```

`matrixClear` already fills with black, so the knocked-out cells cost nothing - they are
simply not drawn.

Everything around it stays as it is: `showMatrixAlert` keeps its signature, its colour
argument, `MATRIX_NOTICE_HOLD_MS`, and its single caller in `pollResponseTimeout`. This
is a change of picture, not of behaviour, and it is independent of the rest of this plan -
it can ship on its own.

## The OLED, in the same window

`showStatus("SmartToolbox", "Waiting for Pi", "v" FIRMWARE_VERSION)`. The version stays
visible because this is exactly when someone wants to know what is running, and the
line it replaces (`Touch a pad`) is an instruction the box cannot honour yet.

On promotion to READY, the existing `showStatus("SmartToolbox", "Ready", ...)` fires as
it does today. That transition is the whole user-visible payoff: the face settles and
the screen changes at the moment the box actually starts working.

## Steps

### Step 1 - the state exists, with no face yet

`deviceReady` flag, WAITING entered before the OTA check in `setup()`, 2-second
`device/status` retry, promotion on first reply, lookups suppressed while waiting.

**The reply has to be readable first.** `handleIncomingLine` opens with
`if (!awaitingResponse) return;`, before it parses anything, and `sendDeviceStatus` -
correctly - never claims the pending slot. As the firmware stands, the Pi's
`{"acknowledged":true}` is discarded unread and no amount of retrying can promote the
device. Parse the line before that guard and promote on any line whose `id` begins
`status-`, without touching `pendingRequestId` or `awaitingResponse`.

**Done when:** the Pi's log shows repeated `device/status` from a cold boot roughly two
seconds apart, stopping once answered - and the dashboard shows a firmware version
after a whole-box power cycle, which it does not today.

### Step 2 - the spinner

`drawSpinner`, `SPINNER_RING`, `MATRIX_SPIN_STEP_MS`, `MATRIX_WAITING`, the
`updateMatrix()` branch, `scheduleNextBlink` on promotion.

**Done when:** a cold boot shows a purple arc turning clockwise with a white leading
dot, and it settles into the normal blinking idle face the instant the Pi answers,
without a blink at the moment it settles.

### Step 3 - the honest touch

A touch during WAITING re-draws the waiting status rather than sending a lookup.

**Scope the suppression to the lookup path only.** `MIC_BRINGUP` is `1` today and takes
pad D0 over entirely at the top of `onTouchStart`; recording never involves the Pi, so
suppressing the whole touch would make mic bring-up untestable on any bench where
nothing answers. The guard belongs inside the `#else` branch, next to the existing
`toolName == nullptr` check.

**Done when:** touching the pad at second 10 of a cold boot never produces
`No response` - and, with `MIC_BRINGUP` set, still records.

### Step 4 - the long wait

`MATRIX_WAIT_LONG_MS`, the second phase within `MATRIX_WAITING`, the OLED line.

**Done when:** the box left unplugged from the Pi shows the purple sad face after 90
seconds, and returns to spinner-then-idle the moment the Pi is reconnected and answers.

### Step 5 - the alert triangle

`drawAlertTriangle`, called from `showMatrixAlert` in place of the row fill. Independent
of Steps 1-4 and shippable on its own.

**Done when:** a lookup that times out shows a red triangle with a legible exclamation
mark instead of a solid red band.

## Traps this plan already knows about

- **The promotion has nothing to hook into as the code stands.** See Step 1. This is the
  one that stops the whole plan working, and it is invisible until it is looked for:
  every piece of the handshake exists except the line that reads the answer.
- **`reportLastOtaResult()` must move to promotion.** It fires today from
  `pollDeviceStatus()` on the first heartbeat - at 30 seconds, deliberately, because
  that is the earliest point a host is provably reading. That is the 0.16.0 fix that
  made the boot-time OTA log exist at all. Left where it is, a 2-second waiting retry
  prints it at t=2s into the same void it was rescued from. Promotion to READY is a
  strictly better trigger than "first heartbeat" - it is the moment the link is proven
  rather than an approximation of it.
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
  Note the path that can set it: the `lookup <tool name>` serial bench trigger takes the
  pending slot, and `RESPONSE_TIMEOUT_MS` is 2000ms - the same interval as the retry.

## What this deliberately does not do

- **No change to the Pi.** Shaving its 31-second userspace is a different project with a
  worse payoff.
- **No giving up.** The retry never stops and there is no error state; the 90-second
  face is a change of expression, not a surrender.
- **No bearing on the microphone itself.** `docs/PLAN-mic-bringup.md` is unaffected -
  recording never involved the Pi until Step 2 of that plan - but the touch suppression
  in Step 3 above has to be scoped so it stays that way.

## What was built - 2026-08-29

All five steps, in `firmware/smarttoolbox/smarttoolbox.ino`. Compiles at 1,088,542 bytes
(32% of flash), 50,524 bytes of RAM.

- `deviceReady`, `WAITING_RETRY_MS` (2s), `WAITING_LONG_MS` (90s), `waitingSince`.
- `startWaitingForPi()` - called from `setup()` **before** `checkForFirmwareUpdate()`.
- `promoteToReady()` - fires `reportLastOtaResult()`, restores the idle face, and calls
  `scheduleNextBlink()` so it does not blink on arrival.
- `pollWaitingRetry()` in the loop, with no `awaitingResponse` guard, by design.
- `handleIncomingLine` parses before the `awaitingResponse` check and calls
  `promoteToReady()` on **any** parsed reply. This is the fix the review found, and
  without it none of the rest can work.
- `pollDeviceStatus` now returns early while `!deviceReady`, so the two senders cannot
  both fire.
- `MATRIX_WAITING` plus `SPINNER_RING[16]`, `drawSpinner`, `MATRIX_SPIN_STEP_MS` (90).
- `drawAlertTriangle`, called from `showMatrixAlert` in place of the row fill.
- The lookup guard sits inside the `#else` in `onTouchStart`, so `MIC_BRINGUP` is
  unaffected.

One thing added during implementation that the plan did not call for: `pollFirmwareUpdate`
re-asserts the waiting screen after a check that did not take an update. The check leaves
its own outcome on the OLED, which is the wrong screen for a box that is still waiting -
only reachable if the Pi is still absent at the two-minute mark, but that is exactly the
case this plan is about.

**Still to prove on hardware**, and none of it can be checked from Windows: the Pi's log
showing `device/status` roughly two seconds apart from a cold boot and stopping once
answered; the dashboard showing a firmware version after a whole-box power cycle; the
spinner turning the right way; the 90-second face; and a touch at second 10 producing no
`No response`.

## What the review changed

Reviewed 2026-08-29 against the firmware at v0.17.0:

1. The promotion could never fire - `handleIncomingLine` drops every line before parsing
   when nothing is pending. Now Step 1's first requirement.
2. The timing table was internally inconsistent, because the OTA check blocks `setup()`.
   Table corrected; WAITING moved ahead of the check.
3. `reportLastOtaResult()` would have regressed to printing into the void. Moved to
   promotion.
4. "No bearing on the microphone work" was wrong - Step 3 as written would have killed
   mic bring-up on a bench. Suppression scoped to the lookup path.
5. "No timeout, no error state" removed the only diagnostic the current firmware has.
   Replaced with the 90-second face, which keeps retrying.
6. Promotion needs `scheduleNextBlink()`, or the face blinks the instant it settles.

And the same day, a design change rather than a review finding: the waiting face became
a **spinner** instead of a patient smiley, and the error picture became a **red alert
triangle** instead of a solid red band. Both replace a symbol that said "the box is
fine" or "something is wrong" with one that says which. The listening indicator from the
same decision - an animated sound wave - belongs to `docs/PLAN-mic-bringup.md`, and it
carries a trap this plan does not: see Step 1 there.
