---
name: spec-status
description: Audit and correct the Status tags in .github/copilot-instructions.md and the status frontmatter in docs/PLAN-*.md against what the code actually does. Use after implementing, changing, or removing a feature, before committing a behaviour change, or when asked whether a documented endpoint, table, or command really exists.
allowed-tools: [Read, Glob, Grep, Bash, Edit]
---

# Keeping the status tags honest

`.github/copilot-instructions.md` mixes what is built with what is only designed. Every
major section carries a status line so the difference is never ambiguous:

- **Status: Implemented** - the code exists and runs. File references point at it.
- **Status: Partial** - some of it runs; the section says which part.
- **Status: Planned** - designed here, not written yet.
- **Status: Blocked** - planned, and something concrete is in the way. The blocker is named.

The tags are load-bearing. `Planned` means the code does not exist however concrete the
surrounding design looks - the OTA section, for instance, documents an AP-mode
provisioning flow and three database tables that were never built. **A stale tag is
worse than no tag**, because it is trusted.

`docs/PLAN-*.md` carry the same idea as a `status:` field in their YAML frontmatter,
written as prose rather than one of four values.

## The rule

Update the tag in the **same commit** as the code change. Not afterwards. Three separate
commits in this repo's history exist only to correct tags that drifted, which is the
failure this convention is meant to prevent.

## Auditing

Find every tag and check it against reality:

```bash
grep -n '\*\*Status:'   .github/copilot-instructions.md   # section tags
grep -n '\*\*Status\*\*:' .github/copilot-instructions.md   # component entries - different spelling
grep -n '^status:' docs/PLAN-*.md
```

**Two greps, because the file uses two spellings.** Section tags are `**Status:` and
component entries under Hardware Components are `**Status**:` with the asterisks closed
before the colon. A pattern for one silently misses the other. On 2026-08-31 an audit
that ran only the first grep passed a Microphone entry reading "attached but never
initialised by this project's firmware" three versions after voice lookup shipped.

**Then read the three places that carry no tag at all**, because no grep will find them:

- **The Hardware Bring-Up Status table** near the top. It calls itself "the single place
  to check what is physically working", which makes it the most-trusted and
  worst-punished prose in the file. Check its `Updated <date>` stamp too - it is part of
  the claim.
- **The API Project and Firmware Project bullets** - runtime, framework, board. These
  read as fixed facts and drift silently; `**Framework**: Hono` outlived the dependency.
- **The two Development Priorities checklists**, which duplicate each other in wording
  and membership and must both be updated for any change.

For each one that the current work touches, confirm the claim rather than assuming it:

- An endpoint is real if it appears in the `if` chain in `api/src/index.ts`.
- A table is real if `api/src/db.ts` creates it.
- A serial endpoint is real if `api/src/serialProtocol.ts` handles it.
- A device command is real if `api/src/deviceCommands.ts` knows it.
- A firmware behaviour is real if it is in `firmware/smarttoolbox/smarttoolbox.ino`,
  and *shipped* only if a release carrying it went to the device.

Grep for the name before believing the prose. The spec is 2,200 lines and its planned
sections are written as confidently as its implemented ones.

## Writing a good tag

The tags that have survived in this repo say what was proven and when, not just which
word applies:

> **Status: Implemented** - working end to end as of 2026-08-27. The device pulled
> `smarttoolbox-0.4.0.bin` (1,046,256 bytes) from the Pi over Wi-Fi, verified it,
> rebooted into it, and reported `currentVersion=0.4.0` on the next check.

When only part of a section is built, say which part and name what is missing. When
something is genuinely unexercised, say so - `Untested:` lines next to an
`Implemented` tag are more useful than a downgrade to `Partial` that hides the working
half. When a design detail was dropped, correct the text as well as the tag; leaving a
`device/ota-reset` in a list of endpoints that were built is how the next reader loses
an hour.

Dates are absolute in this repo, never "today" or "last week".
