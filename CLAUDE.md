# SmartToolbox

A physical toolbox that tells you which drawer a tool is in. A XIAO ESP32S3 talks to a
Raspberry Pi Zero 2 over USB serial; the Pi runs a Bun/TypeScript API over SQLite.

## Read these first

This file is a pointer, not the spec. The documents of record live in `.github/`:

- **`.github/copilot-instructions.md`** is the project spec and the single source of
  truth. It covers architecture, the database schema, every endpoint, the serial
  protocol, pin mappings, deployment, and debugging. Read it before changing anything.
- **`.github/instructions/xiao-esp32s3-firmware.instructions.md`** covers the firmware
  and the hardware's specific traps. Read it before touching `firmware/**`.
- **`docs/HARDWARE.md`** is the hardware record: every part owned, whether it
  physically works (the Bring-Up Status table), and which pin carries it. Read it
  before wiring anything or before assuming a component is live.
- **`docs/PLAN-*.md`** are implementation plans, each with a `status:` field in its
  frontmatter saying whether it is still active.

## The status-tag convention

Every section of the spec carries a status tag:

`**Status: Implemented | Partial | Planned | Blocked**`

They are load-bearing. `Planned` means the code does not exist yet, however concrete
the surrounding design looks - do not assume a documented endpoint is real. **Keep the
tags current in the same commit as the code change.** That convention is the whole
point of them, and a stale tag is worse than no tag.

## Working here

- `cd api && bun run start` runs the server; `bun test` runs the tests.
- On Windows the serial listener does not start, so the API and dashboard run fine with
  no XIAO attached. The device round trip can only be tested against the Pi.
- Deploy with `cd api && .\sync.ps1`. Release firmware with
  `cd api\scripts && .\release-firmware.ps1 -Version x.y.z -Push` - add `-Now` and the
  device fetches it within one heartbeat instead of up to 30 minutes.
- The Pi cannot push; it can only leave a command to be collected.
  `.\push-to-device.ps1 check-firmware` (or `reboot`) queues one, delivered on the
  device's next heartbeat.
- `.\flash-device.ps1 -Version x.y.z` flashes the XIAO from the Pi over USB, through
  the ROM bootloader. That is the only path that survives a bad build, because OTA
  needs working firmware to receive an update. See `docs/PLAN-usb-flashing.md`.
- Secrets are untracked: `firmware/smarttoolbox/arduino_secrets.h` locally and
  `~/smarttoolbox/.env` on the Pi. Never commit either; the `.example` files are the
  tracked templates.
- The codebase is deliberately plain - a hand-rolled `if` chain for routing rather than
  a framework, prepared statements at module scope, sparse comments that explain *why*.
  Match what is already there rather than introducing new patterns.

## Skills

`.claude/skills/` holds the procedures that are long enough to be worth loading only
when they apply, rather than living here:

- **`firmware-release`** - releasing over OTA, making the device collect a build, and
  flashing over USB when OTA cannot help.
- **`deploy-api`** - `sync.ps1`, the service, and where the logs actually are.
- **`hardware-debug`** - triaging "nothing happens" on the box.
- **`spec-status`** - keeping the status tags honest against the code.

## Debugging hardware

Most failures in this project present identically as "nothing happens" - a wrong touch
threshold, a frozen peripheral, a tty in the wrong mode, and a missing antenna all look
the same from the outside. The Debugging & Testing section of the spec records the
checks that tell them apart. Reach for those before reading code; nearly every bug
found here was found by making the system observable, not by inspection.
