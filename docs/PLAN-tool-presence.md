---
title: Plan of Attack - Tool Presence (see a tool leave, see it come back)
scope: implementation plan, written 2026-08-31 - both directions from the camera, and a
  movement log that needs no serial numbers
status: PLANNED - nothing built. Blocked on the same thing as Feature 3: no SenseCraft
  model is deployed, so there is nothing to detect. Steps 1 and 2 need no hardware and
  can be built against fixtures before that clears.
---

# Plan: the box notices a tool leave, and notices it come back

One sentence of scope:

> The camera sees a drawer's contents change, the API records which way it changed, and
> a lookup can say "one is out, since 14:32" instead of only "there are three".

## The decision this plan rests on

**Tools stay tracked by type and quantity. Presence is derived, not flagged.**

The obvious design is a boolean on the tool - `inUse`, or `away`. It was considered
first and it does not survive contact with the data:

- **A boolean cannot count.** Three Phillips screwdrivers, one leaves. The row still says
  `quantity: 3`, and the flag has no honest value. The state worth knowing is *2 of 3*.
- **Identity needs a source and the camera is not one.** The Vision AI V2 emits a class
  label with a confidence. It cannot tell the second screwdriver from the third. Give
  each tool its own row and every camera event has to be pinned on *some* instance,
  which makes the movement history partly fiction - and fiction that reads as fact is
  worse than an absent feature.
- **Absence of detection is not absence of a tool.** Occlusion, a bad angle, and a
  missing model all look exactly like "gone". A two-state flag lies confidently every
  time the model is unsure. A derived status can carry `unknown` and stay honest.

What the camera *can* say is trustworthy and sufficient: **one Phillips screwdriver left
drawer 1A at 14:32.** That is a movement of a count, it needs no serial numbers, and it
is enough to answer every question this feature exists to answer.

The spec's Planned Tables entry used to say `tool_movements` "needs per-instance identity
first". That was wrong, and it is corrected in the same commit as this plan: movement of
a count is still movement.

## What this does not change

**Returning a tool to the wrong drawer already works today** and needs nothing from this
plan. `tools` is keyed `(drawer_id, name)` with its own quantity, so one tool type holds
rows in several drawers at once, and `locateTool` already returns every drawer a name
lives in with `hasMultipleLocations` and a `rows` array. Take one from 1A, put it back in
3, move the counts, and a lookup lights both rows.

This plan adds one table and the path that writes to it. It is not a redesign.

## The gate for per-instance tracking

Per-instance is the right destination *if the instances are ever distinguishable* -
engraving, QR, NFC, or a set whose members visibly differ. There is no plan to mark the
tools as of 2026-08-31, so the gate is closed.

It is worth naming rather than dismissing, because `tool_movements` as designed here is
already the right shape to hang instances on: add an `instance_id` column, and every row
already written stays true. Nothing in this plan has to be undone to open that gate.

## Step 0 - a model that emits labels

**Blocked, and this is the same blocker as Feature 3.** No SenseCraft model is deployed,
so the camera has nothing to say. Everything below is written against detections that do
not exist yet.

Nothing in Steps 1 and 2 depends on the hardware, so both can be built and tested against
fixtures first. Do that rather than waiting - it is the same ordering that made
`resolveToolQuery` the first piece of voice lookup to ship.

## Step 1 - the movement log, no hardware

Add the table:

```sql
CREATE TABLE IF NOT EXISTS tool_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drawer_id INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  delta INTEGER NOT NULL CHECK (delta != 0),
  confidence INTEGER NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
  model_version TEXT NOT NULL DEFAULT '',
  observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(drawer_id) REFERENCES drawers(id) ON DELETE CASCADE
);
```

`delta` is negative when a tool leaves and positive when one returns, which is what makes
both directions one table rather than two. The `CHECK (delta != 0)` matters: a detection
that changed nothing is not a movement, and writing it would bury the real ones.

Follow the existing conventions rather than inventing new ones - `CREATE TABLE IF NOT
EXISTS` at module scope, prepared statements beside the others, cascade on drawer delete
exactly as `drawer_observations` does.

**Done when:** a derive function turns movements plus `tools.quantity` into
`present` / `partial` / `away` / `unknown`, with tests covering the case that motivates
the whole design - three owned, one gone, status `partial` and not `away`.

## Step 2 - decide a movement from two observations

The camera reports what it *sees*, not what changed. Turning consecutive observations
into a movement is the only genuinely hard part of this plan, and it is where a naive
version will generate noise.

- A drop from 3 to 2 is a movement of -1. A rise back to 3 is +1.
- **A drop to zero detections is not a movement to zero.** It is very often the model
  failing, the drawer being shut, or the light changing. Require corroboration - a
  repeat observation, or a confidence floor - before writing a large negative delta.
- Low-confidence detections should not move counts at all. Pick the floor deliberately
  and write down why, the way the transcription timeout was.

**Done when:** a fixture sequence of observations produces the movements a human would
agree with, including the awkward ones - a flicker to zero and back, and a detection
whose confidence is too low to trust.

## Step 3 - both directions, on hardware

With a model deployed: take one tool out, watch a `-1` land. Put it back, watch a `+1`.
Put it back in a *different* drawer and confirm two rows - a `-1` in the first and a `+1`
in the second - and a lookup that now lights both rows.

**Done when:** a person at the box moves a real tool and the movement log matches what
they did, proven by them and not by inspection. That is the standard the microphone and
the voice path were held to, and it is the one that has caught what tests did not.

## Step 4 - say it where it is useful

Only after Step 3. Candidates, cheapest first:

- The lookup response gains presence, so the OLED can say "1 of 3 out" alongside the
  drawer label.
- The dashboard shows what is currently away and for how long.
- The matrix does something for "the tool you asked for is out" that is distinct from
  "not found" - those are different answers and today they look the same.

## What would change this design

**Marking the tools.** If they ever get engraved, tagged, or NFC'd, instances become
real, per-instance history stops being fiction, and this table takes an `instance_id`
column without any row written before that becoming false.

**A model good enough to count reliably.** Several decisions above - the confidence
floor, requiring corroboration before a large negative delta - are defences against a
model that is unsure. A model that is consistently right makes them unnecessary
complexity, and they should be removed rather than left as scar tissue.
