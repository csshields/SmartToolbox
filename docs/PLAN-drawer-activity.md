---
title: Plan of Attack - drawer activity (know which drawer is open, and watch it change)
scope: implementation plan, written 2026-09-02, restructured the same day when
  per-drawer contact sensing was ruled out - drawer identity now comes from the camera
  rather than a switch, and this is the capture trigger and the addressing that turns a
  detection into a row. The movement log itself already has a plan; this is the half
  that feeds it.
status: PLANNED - nothing built, and restructured 2026-09-02 around having no per-drawer
  sensor. **There is no longer a half of this that is independent of the SenseCraft
  model** blocking it since 2026-08-27 - the camera is now the only thing that can say
  which drawer is open, so it gates drawer identity and tool detection alike. Phase 0 is
  a photography session, not code, and it can still kill the plan. It now has to answer
  a second question first: can the camera tell which drawer is open at all.
---

# Plan: the box knows which drawer is open, and what changed while it was

One sentence of scope:

> The camera says which drawer is open and what is in it, that goes to
> `drawer_observations` addressed to that drawer, and the difference from what was last
> seen there is what `tool_movements` records.

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

That is the real dependency. The first draft of this plan answered it with a switch per
drawer and concluded that **sensing was the prerequisite for detection** - build the
sensing first and the camera work becomes tractable.

**Restructured 2026-09-02: there will be no per-drawer sensor, so that answer is
withdrawn and the dependency runs the other way.** The camera is now the only thing that
can supply a drawer id, which means it has to answer two questions rather than one -
*which drawer is open* and *what is in it* - and neither can be built before the other.

Two consequences, both worth stating plainly because they are costs:

- **Nothing here ships before the model does.** The first draft could offer a drawer
  activity feed with no model at all. That is gone. Every phase below now sits behind the
  same SenseCraft blocker, and the plan should not be sold as partially deliverable.
- **The trigger problem is now the hard part.** A switch gave an edge to fire on for
  free. Without one, something has to decide when the camera is worth asking, and the
  honest options are a presence sensor or a poll. See below - this is where the PIR stops
  being a footnote.

## PIR still cannot say which drawer - but it is now the trigger

Worth being blunt, because the sensor is already owned and it is the obvious reach.

A PIR sensor detects moving infrared - a warm body nearby. It answers "is someone at the
box", which is a real and useful question. It **cannot** answer "which drawer is open",
and no arrangement of one fixes that: it has no per-drawer resolution, it fires on a
person walking past a closed box, and it stays quiet for an open drawer someone has
walked away from.

None of that changed. What changed is everything around it. **The first draft said "this
plan does not depend on it". It does now.**

With a switch per drawer there was an edge to fire the camera on, and the PIR was a power
optimisation for later. With no switch, the choice is between asking the camera on a
presence signal and asking it on a timer, and there is nothing else in the box that
knows a person is at it. So the PIR gets promoted from footnote to the only cheap answer:
**someone is here, so start looking; nobody has been here for a while, so stop.**

That is a real job and the sensor is genuinely good at it. It is still not drawer state,
and the camera still has to name the drawer. But the sequencing inverts - the PIR now
comes *before* the vision work rather than after it, because without it the alternative
is a camera running inference all day on a shared I2C bus.

## Withdrawn: reed switches on an I2C expander

The first draft recommended **reed switches, one per drawer, into an MCP23017 I2C GPIO
expander on the Grove I2C Hub**, and the reasoning was sound: an expander is a real I2C
chip, so unlike the PIR and the Red LED Button it belongs on the hub and needs nothing
from the occupied expansion header. That genuinely was the way through the constraint
that has deferred GPIO parts since August.

**It is withdrawn for the reason the plan itself named as the real cost:** a magnet on
every drawer, a switch bracket on every drawer, and a wire run per drawer back to
wherever the expander lives. Mechanical work on a box that already exists, and it is not
a software cost. Ruled out 2026-09-02.

Recorded rather than deleted, because the expander argument is still correct and will be
the right answer the moment any part in this project needs a plain digital input. The
constraint it dissolves is real and the note should not have to be rediscovered.

**Also withdrawn with it: the argument for keeping drawer state on the XIAO.** That was
about the Pi being unable to push - a Pi-side switch would have to wait up to 30 seconds
for the device's heartbeat to say "capture now", by which time the drawer is shut. With
the camera itself supplying the drawer id, the question does not arise: the camera is on
the XIAO, and so is the loop that asks it. The conclusion survives; the reason for it is
gone.

## What replaces it: the camera names its own frame

There is no drawer sensor. The camera is asked what it can see, and its answer carries
both halves - *drawer 3 is open* and *these tools are in it*.

That is a bigger ask of the model than the first draft made, and it should be said
plainly rather than absorbed: **the vision task now has two jobs, not one.** Identifying
an open drawer from an image is a different problem from classifying tools inside it, and
they may well want different treatment - drawer identity is large, geometric and
high-contrast, tool identity is small, cluttered and occluded. One model with drawer
position as a class, two models in sequence, or drawer identity from plain geometry with
no model at all are all live options, and Phase 0 is what tells them apart.

The one cheap thing worth knowing early: **drawer identity may not need the model.** An
open drawer is a large rectangle that was not there before, at a known height. If that
falls out of the photographs in Phase 0, drawer addressing could be solved with fixed
regions and a frame difference, and only tool classification would wait on SenseCraft.
Worth ten minutes with the Phase 0 photographs before assuming otherwise.

## The unit of observation is one settled look, against what was last stored

The first draft sampled twice per cycle - once on open for a baseline, once on close for
the result - and took the difference. **That needs a switch and no longer works.** By the
time a camera notices a drawer is open, a hand has already been in it; there is no moment
corresponding to "before anyone touched it" that the camera can be pointed at.

So the comparison changes shape rather than disappearing:

1. **The "before" is the newest `drawer_observations` row for that drawer.** It is
   already stored, it is already the schema's design - newest row per `(drawer, tool)`
   wins, `superseded_at` marks history - and it costs nothing to read.
2. **The "after" is one observation, taken while the drawer is open and has been still
   for a few seconds.** Not on close, which is unobservable and would photograph a shut
   drawer front anyway.

The pair handed to `PLAN-tool-presence.md` Step 2 is therefore *stored state* plus *one
fresh look*, rather than two fresh looks. Its Step 2 consumes a pair either way, so
nothing there needs redesigning - but the pair is weaker than the first draft promised,
and the plan that depends on it should be told so.

**What that costs, stated rather than glossed:**

- **The claim that this dissolves the hardest problem in the tool-presence plan is
  withdrawn.** That plan warns "a drop to zero detections is not a movement to zero" -
  usually the model failing, the drawer being shut, or the light changing. The first
  draft could say two of those three vanish because both samples were seconds apart under
  the same light. They are now hours apart under different light, so **all three
  confounders are back and the corroboration rules there carry the whole design again.**
  This is the single biggest thing lost with the switch, and it is a cost paid in the
  other plan rather than this one.
- **A hand in the frame is still garbage, and stillness is now the only gate.** Mid-
  rummage the camera sees an arm. With no close event to fall back on, "has been still
  for a few seconds" is the sole thing standing between a settled drawer and a photograph
  of somebody's sleeve. It needs a real threshold, tuned on the Phase 0 photographs.
- **The WiseEye2 must still not run inference all day.** With no edge to trigger on, that
  is now the PIR's job rather than a property of the design. Absent a presence signal
  this degenerates into a poll, and the module is sharing a bus with the display.

## Phases

### Phase 0 - can the camera see into a drawer at all? (no code)

**This is a photography session and it can kill or reshape the whole plan, so it goes
first.** One camera is mounted in one place; a toolbox has many drawers at different
heights and depths. Nothing downstream matters if the geometry does not work.

Mount the camera where it might plausibly live, open each drawer in turn, and take a
picture from the camera's position. Then answer honestly:

- **Can you tell which drawer is open, from the photograph alone?** This is the new first
  question and it did not exist while a switch was supplying the drawer id. If a person
  cannot tell drawer 3 from drawer 4 in the frame, no model will either, and the plan has
  no way to address an observation.
- **Could that be done without a model?** Is the open drawer a large rectangle at a
  predictable height, against a background that does not move? If so, fixed regions and a
  frame difference may supply drawer identity for free, and only tool classification
  waits on SenseCraft. Worth ten minutes before assuming a model is needed for both.
- Is the inside of the drawer in frame, in focus, and lit, for **every** drawer - or only
  the middle ones?
- Does a person standing at the box block the shot?
- Do the tools in the frame look like something a model could classify, or are they a
  jumbled overlapping pile?
- **Take a second photograph of each drawer hours later**, in different light. That pair
  is what the movement comparison actually gets now that the "before" is a stored
  observation rather than a fresh one. If tools look unrecognisably different between
  them, that is the corroboration problem arriving early, and better found here.

**Done when** there is a folder of real photographs - one per drawer, plus a second
round under different light - and a written verdict. Three outcomes, all acceptable: it
works as-is; it works with the camera moved or a light added; or **one fixed camera
cannot cover this box** - in which case the options are per-drawer cameras, a camera
covering only a useful subset, or abandoning the feature. Note that the third outcome is
now fatal rather than partial: with no switch there is no Phase 1 left to keep for its
own sake.

Do this before writing a line of firmware.

### Phase 1 - the firmware can talk to the camera at all

**This is not the old Phase 1.** That one delivered a drawer activity feed with no model
and was worth shipping on its own; it needed a switch and is gone. What is left in its
place is smaller and less satisfying, but it is the honest first step: the firmware has
**no vision code at all** today - not a single SSCMA call - and that has to exist before
anything else can.

- Bring up the SSCMA link on the XIAO: initialise the Vision AI V2 over I2C, ask it for
  a result, log what comes back.
- Do it alongside the existing I2C traffic, not in isolation. The OLED and matrix share
  the bus and the matrix push already costs ~10ms.
- With no model deployed the answer is empty, and that is fine - an empty answer that
  arrives reliably proves the plumbing, which is the whole point of doing this before
  Phase 3.

**Done when** the device can ask the camera a question and log a well-formed empty
answer, without disturbing the display, and the serial log shows it happening on a
cadence rather than once.

The PIR belongs here rather than later, for the reason given above: it is the only thing
that keeps this from being a poll. Wiring it to the Pi's 40-pin header is the established
pattern for new GPIO in this project, and it is acceptable here even though the camera is
on the XIAO - presence is a slow signal and a heartbeat's latency does not lose a drawer
the way it would have lost a switch edge.

### Phase 2 - the capture trigger, and the stillness rule

With no switch there is no state machine to drive this, so the trigger has to be built
rather than inherited:

- **Presence starts it.** PIR fires, the device begins asking the camera on a slow
  cadence. No presence for a while, it stops. This is the part that keeps the WiseEye2
  from running all day.
- **Stillness gates the capture.** Successive looks that agree, for a few seconds, mean
  the drawer has settled and the hand is out. Only then is the observation recorded. The
  threshold is a guess until Phase 0's photographs exist.
- **Drawer identity comes from the same answer**, and addresses the write. If Phase 0
  showed that geometry can supply it without a model, do that here and keep the model out
  of the addressing path entirely - it is one less thing blocked.

With no model deployed this still runs end to end. It just records nothing, which is
exactly the shape needed to test the plumbing.

**Done when** a settled drawer produces one `vision/observe` call with the right
`drawerLabel`, a hand moving in the frame produces none, and an empty room produces none
- all provable from the request log with no model present.

### Phase 3 - deploy a SenseCraft model

**The standing blocker, unchanged since 2026-08-27**, and the largest unknown here. It is
a data-collection and training task, not a coding one, and the photographs from Phase 0
are the beginning of its training set.

**It is a bigger task than the first draft implied, and that is the direct cost of having
no switch.** The model - or models - now has to supply drawer identity as well as tool
identity, unless Phase 0 shows geometry can do the first. Those are different problems on
different scales: an open drawer is large, geometric and high-contrast; a socket in a
cluttered tray is small and occluded. Training one model to do both well is not obviously
easier than training two, and the answer is not knowable from here.

Deliberately vague beyond that, because until Phase 0 is done nobody knows whether the
target is "classify six tool types in a well-lit drawer" or something much harder. Scope
it after Phase 0, not now.

**This is now the gate on the entire plan**, where before it gated only the vision half.
Nothing above Phase 2 produces a usable feature without it.

### Phase 4 - hand off to the movement log

Steps 1-4 of `docs/PLAN-tool-presence.md`, which are already written. Its Step 2 consumes
a pair, and it still gets one - stored state plus one fresh look, rather than two fresh
looks. **Nothing there needs redesigning, but something there needs re-reading.**

Its corroboration rules were written for exactly this case and are now load-bearing
again. The first draft of this plan would have handed it two observations seconds apart
under identical light, and claimed that made a drop to zero detections trustworthy. It
cannot claim that any more: the two halves of the comparison are hours apart under
different light, which is the situation those rules exist for. They were never removed,
but they were about to be treated as belt-and-braces. They are the belt.

Also tell it the input is lossy - see open question 4. A drawer opened and shut before
the camera settles produces no observation at all, where a switch would have caught every
cycle.

## Known constraints

- **The camera returns results, not frames.** Seeed's link cannot serve a live frame and
  inference results at the same time, so a cloud-model fallback (Claude, GPT-4o) needs
  raw frames pulled another way entirely - the module's SD card or its Type-C port. Do
  not design assuming a frame is one request away.
- **The I2C bus is shared** - OLED, matrix and Vision AI V2. The matrix push already
  costs ~10ms, and asking the camera is now a repeating cost rather than a per-edge one.
  Ask on a cadence, never in a tight loop.
- **One camera probably cannot see every drawer**, and it now has to *identify* every
  drawer as well as see into it. Phase 0 exists to find that out before any firmware is
  written, and a failure there is fatal to the plan rather than partial.
- **There is no cheap fallback left.** With a switch, a camera that could not see a
  drawer still left a working activity feed. That safety net is gone: if vision cannot
  address an observation, nothing here ships.
- **Absence of detection is not absence of a tool** - occlusion, angle, and a missing
  model all look identical from outside. `PLAN-tool-presence.md` already carries this and
  its `unknown` state is the honest answer; do not weaken it here.

## Open questions

1. **Can drawer identity come from geometry rather than a model?** The cheapest question
   here and the first one Phase 0's photographs can answer. If fixed regions and a frame
   difference can say "drawer 3 is extended", addressing stops being blocked on SenseCraft
   and only tool classification waits. If not, the model has two jobs.
2. **What is the stillness threshold?** It is the only thing separating a settled drawer
   from a photograph of somebody's arm, and with no close event there is no second
   opinion. Guessable from Phase 0, tunable only on hardware.
3. **How long does presence keep the camera awake, and what turns it off?** A PIR that
   holds high while someone works at the box is fine; one that retriggers constantly
   turns the cadence into a poll. Needs measuring on the actual sensor, not assuming.
4. **Is a drawer that is opened and shut before the camera settles simply missed?** With
   a switch, every cycle was captured. Now a quick grab may produce no observation at all.
   Probably acceptable - the movement log is a record, not an audit - but it should be a
   decision rather than a surprise, and `PLAN-tool-presence.md` should know that its input
   is lossy.
5. **Does anything still want `drawer_events`?** The table was proposed for switch edges
   that no longer exist. A settled observation is already a `drawer_observations` row, so
   a separate events table may have nothing left to hold. If an activity feed is still
   wanted, it is now derived from observations rather than sensed - which is a different
   and weaker thing, and worth deciding before building it.
