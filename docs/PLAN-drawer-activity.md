---
title: Plan of Attack - drawer activity (know which drawer is open, and watch it change)
scope: implementation plan, written 2026-09-02 - per-drawer open/close sensing, and the
  capture trigger that turns it into an addressable camera observation. The movement log
  itself already has a plan; this is the half that feeds it.
status: PLANNED - nothing built. Phase 0 is a photography session, not code, and it can
  gate the whole thing. Phase 1 needs no model and is useful on its own. The vision half
  stays blocked on the same SenseCraft model that has blocked it since 2026-08-27.
---

# Plan: the box knows which drawer is open, and what changed while it was

One sentence of scope:

> A drawer opening is a sensed event with a drawer id attached, closing is when the
> camera looks, and the difference between the two is what `tool_movements` records.

## What already exists - do not replan it

Read these before this document:

- **`docs/PLAN-tool-presence.md`** already covers "a tool left" and "a tool came back"
  end to end: the `tool_movements` table, the `delta` design, deciding a movement from
  two observations, and the derived `present`/`partial`/`away`/`unknown` status. **That
  plan is not superseded and should not be rewritten.** It assumes observations arrive;
  this plan is where they come from.
- **`drawer_observations` exists and is Implemented** - `tools` is intent, observations
  are evidence, newest row per `(drawer, tool)` wins, `superseded_at` marks history.
- **`POST /api/vision/observations` and the `vision/observe` serial endpoint both exist**
  and are implemented, all-or-nothing per batch.
- **The camera link is up.** Grove Vision AI V2 (WiseEye2) + OV5647, stacked on the XIAO
  expansion header, talking I2C. Verified on hardware 2026-08-27.
- **No SenseCraft model is deployed**, so the link returns nothing useful. This is the
  standing blocker and this plan does not clear it.

So the API half of the user-facing feature is largely built. What is missing is
everything between a physical drawer and that endpoint.

## The thing that makes this one feature and not two

`drawer_observations.drawer_id` is `NOT NULL`, and `vision/observe` carries a
`drawerLabel`. **Nothing in the system can currently supply either.** The firmware has no
vision code at all - not a single SSCMA call - and no way to know what the camera is
pointed at.

That is the real dependency, and it reframes the request: **drawer-open sensing is not a
companion feature to tool detection, it is the prerequisite for it.** A detection with no
drawer id has nowhere to be written. Build the sensing first and the camera work becomes
tractable; build the camera first and it has no address to file its answer under.

## PIR cannot do this job

Worth being blunt, because the sensor is already owned and it is the obvious reach.

A PIR sensor detects moving infrared - a warm body nearby. It answers "is someone at the
box", which is a real and useful question. It **cannot** answer "which drawer is open",
and no arrangement of one fixes that: it has no per-drawer resolution, it fires on a
person walking past a closed box, and it stays quiet for an open drawer someone has
walked away from.

Keep it, but for what it is: a **wake** sensor. "Someone is here, so start paying
attention" is a legitimate job and a good power optimisation later. It is not drawer
state. This plan does not depend on it, and Phase 1 should not wait for it.

## The sensing recommendation, and why it is finally unblocked

**Reed switches, one per drawer, into an MCP23017 I2C GPIO expander on the XIAO's
existing Grove I2C Hub.**

A reed switch plus a magnet is about a dollar, has no moving parts to wear, and answers
the question directly and unambiguously - closed circuit means shut. Sixteen of them fit
one MCP23017.

**Why this dodges the wall the PIR hit.** The spec is explicit that the expansion header
is occupied by the Vision AI V2, and that parts wanting GPIO from it have nowhere to go.
It is equally explicit about *why* the PIR and the Red LED Button cannot simply go on the
I2C Hub: they are **passive parts with no I2C chip**, so their pins land on SDA and SCL
and pressing the button disturbs the bus the OLED and matrix depend on.

An **MCP23017 is a real I2C chip.** That is the whole difference. It belongs on the hub,
it converts sixteen passive switches into something addressable, and it needs nothing
from the expansion header. The constraint that has deferred GPIO parts since August is a
constraint on *passive* parts, and an expander is the standard way through it.

**This also keeps drawer state on the XIAO, which matters more than it looks.** The
established answer for new GPIO in this project is "put it on the Pi's free 40-pin
header" - that is where the LED strip and the PIR were both sent. Do not do that here.
The camera is on the XIAO, and **the Pi cannot push**: a Pi-side drawer sensor would have
to wait for the device's heartbeat to say "capture now", which is up to 30 seconds. The
drawer will be shut again. Sensing on the XIAO makes the trigger local and immediate, and
needs no protocol change at all.

## The unit of observation is the open→close cycle

Do not stream detections. Sample twice per cycle:

1. **On open, once the drawer has settled** - the baseline. What was in here before
   anyone touched it.
2. **On close, or after the drawer has been still and unattended for a few seconds** -
   the result.

The difference between those two is the movement, and it is handed to
`PLAN-tool-presence.md` Step 2 as a pair rather than as a stream.

This is worth doing for three reasons beyond tidiness:

- **It largely dissolves the hardest problem in the tool-presence plan.** That plan warns
  that "a drop to zero detections is not a movement to zero" - it is usually the model
  failing, the drawer being shut, or the light changing. Two of those three vanish when
  both samples are taken with the same drawer open, under the same light, seconds apart.
  The corroboration rules there stay, but they stop carrying the whole design.
- **A hand in the frame is garbage.** Mid-rummage, the camera sees an arm. Sampling only
  when the drawer has been still avoids inferring anything from the messiest moment.
- **The WiseEye2 is not running inference all day.** Two inferences per drawer-opening is
  a rounding error next to a continuous loop, and the module is sharing a bus with the
  display.

## Phases

### Phase 0 - can the camera see into a drawer at all? (no code)

**This is a photography session and it can kill or reshape the whole plan, so it goes
first.** One camera is mounted in one place; a toolbox has many drawers at different
heights and depths. Nothing downstream matters if the geometry does not work.

Mount the camera where it might plausibly live, open each drawer in turn, and take a
picture from the camera's position. Then answer honestly:

- Is the inside of the drawer in frame, in focus, and lit, for **every** drawer - or only
  the middle ones?
- Does a person standing at the box block the shot?
- Do the tools in the frame look like something a model could classify, or are they a
  jumbled overlapping pile?

**Done when** there is a folder of real photographs, one per drawer, and a written
verdict. Three outcomes, all acceptable: it works as-is; it works with the camera moved
or a light added; or **one fixed camera cannot cover this box** - in which case the
options are per-drawer cameras, a camera that only covers a subset of drawers, or
dropping the vision half and keeping Phase 1 for its own sake.

Do this before buying an expander or writing a line of firmware.

### Phase 1 - drawer state, no camera involved

Fully useful on its own, and independent of the standing model blocker.

- MCP23017 on the I2C hub; reed switches wired to it; magnets on the drawers.
- Firmware polls the expander alongside the existing touch scan and debounces both edges
  the way `pollTouch` already does - this is the same class of problem and should not
  invent a second pattern.
- A new serial endpoint, `drawer/state`, reporting the drawer and its new state. It is
  device-initiated like everything else, so it needs no protocol change.
- A `drawer_events` table - `(drawer_id, state, observed_at)` - following the existing
  conventions: `CREATE TABLE IF NOT EXISTS` at module scope, prepared statements beside
  the others, cascade on drawer delete exactly as `drawer_observations` does.

**Done when** opening a drawer puts a row in the table within a second, and the dashboard
can show "drawer 3, opened 14:32, closed 14:33". That is a genuinely useful activity feed
and the box's first sense of its own use - worth shipping whether or not a model ever
arrives.

Note the mapping problem: a reed switch is a pin number and a drawer is a database row.
Something has to associate them. Suggest a `drawers.sensor_pin` nullable column, additive
and idempotent per the existing migration pattern, rather than a constant table in
firmware that drifts from the database.

### Phase 2 - the capture trigger

The open/close state machine from Phase 1 drives when the camera is asked, per the cycle
above. With no model deployed this still runs end to end - it just returns nothing, which
is exactly the shape needed to test the plumbing.

**Done when** a drawer opening and closing produces two `vision/observe` calls with the
right `drawerLabel`, provable from the request log with no model present.

### Phase 3 - deploy a SenseCraft model

**The standing blocker, unchanged since 2026-08-27**, and the largest unknown here. It is
a data-collection and training task, not a coding one, and the photographs from Phase 0
are the beginning of its training set.

Deliberately vague, because until Phase 0 is done nobody knows whether the target is
"classify six tool types in a well-lit drawer" or something much harder. Scope it after
Phase 0, not now.

### Phase 4 - hand off to the movement log

Steps 1-4 of `docs/PLAN-tool-presence.md`, which are already written. The pair of
observations from Phase 2 is what its Step 2 consumes. Nothing there needs redesigning;
it needed a source, and this is the source.

## Known constraints

- **The camera returns results, not frames.** Seeed's link cannot serve a live frame and
  inference results at the same time, so a cloud-model fallback (Claude, GPT-4o) needs
  raw frames pulled another way entirely - the module's SD card or its Type-C port. Do
  not design assuming a frame is one request away.
- **The I2C bus is shared** - OLED, matrix, Vision AI V2, and now an expander. Addresses
  must not collide, and the matrix push already costs ~10ms. Poll the expander at the
  touch scan's cadence, not in a tight loop.
- **Reed switches need magnets fitted to every drawer.** Mechanical work, and a wire run
  per drawer to wherever the expander lives. This is the real cost of Phase 1 and it is
  not a software cost.
- **One camera probably cannot see every drawer.** Phase 0 exists to find out early
  rather than after the expander arrives.
- **Absence of detection is not absence of a tool** - occlusion, angle, and a missing
  model all look identical from outside. `PLAN-tool-presence.md` already carries this and
  its `unknown` state is the honest answer; do not weaken it here.

## Open questions

1. **How many drawers actually need sensors?** Sixteen inputs is one expander. If the box
   has more, it is a second chip or a rethink. If the useful subset is four, this gets
   much cheaper - and a partial rollout is fine, since `drawers.sensor_pin` being nullable
   means an unsensed drawer simply has no events.
2. **Reed switch or something else?** Hall-effect sensors and microswitches solve the same
   problem with different trade-offs (no magnet needed; more wear). Reed is suggested for
   cost and simplicity, not from a strong conviction.
3. **Does drawer state belong in `drawer_events`, or in the unused `sensors`/`events`
   tables the spec lists as Planned?** Those were sketched for exactly this and never
   built. A purpose-built table is simpler and matches how `drawer_observations` was done;
   the generic pair is more general and probably premature. Suggest the specific table,
   and delete the generic entry from Planned Tables in the same commit if so.
4. **Should the PIR come back as a wake sensor?** Only after Phase 1 works. It would let
   the camera and the expander idle until someone is present, which matters if this ever
   runs on anything but mains power.
