---
name: deploy-api
description: Deploy the Bun API and dashboard to the Raspberry Pi with sync.ps1, restart the service, and read the logs that actually exist. Use when pushing API or dashboard changes to the Pi, checking whether the service is running, tailing the logs, SSHing to the Pi, or working out why a change that works locally does nothing on the box.
allowed-tools: [Read, Glob, Grep, Bash, Edit]
---

# Deploying the API to the Pi

```powershell
cd api
.\sync.ps1                    # push code, restart the service
.\sync.ps1 -Status            # service status plus the tail of both logs
.\sync.ps1 -SetupKey          # one-time: install the deploy public key on the Pi
.\sync.ps1 -InstallService    # also install/enable the systemd unit
.\sync.ps1 -PiHost user@host  # override the target
```

The script is tracked in git and resolves every path from its own location, so it works
from any clone. It copies `package.json`, `tsconfig.json`, `src/`, `public/`, and
`scripts/` to `~/smarttoolbox/` on the Pi, then restarts `smarttoolbox`, falling back to
a bare `bun run start` if the unit is not installed.

**It does not sync `bun.lock` or `node_modules`.** When dependencies change, run
`bun install` on the Pi yourself or the service comes back up broken.

`api/scripts/` is synced too, which is how `flash-device.sh` gets to the Pi.

## Local first

```powershell
cd api
bun test
bun run start      # http://localhost:3000
```

On Windows `SERIAL_DEVICE` is unset, so the serial listener never starts. The API and
dashboard run fine with no XIAO attached, and **a lookup sent from Windows always times
out**. That is correct behaviour, not a fault - the device round trip can only be tested
against the Pi.

## Reading the logs

The service does **not** log to the journal. `smarttoolbox.service` redirects both
streams to files, so `journalctl -u smarttoolbox` shows only systemd's own start/stop
lines and looks misleadingly empty.

```bash
tail -f ~/smarttoolbox/logs/service.log         # requests, responses, device debug
tail -f ~/smarttoolbox/logs/service-error.log   # serial errors only
```

**`service-error.log` has no timestamps.** Run `ls -l --time-style=full-iso` on it
before believing an error is current - a stale `EACCES` from an earlier unplug reads
exactly like a live one and will send you after the wrong problem.

## SSH

```powershell
ssh -i "$env:USERPROFILE\.ssh\smarttoolbox_pi_ed25519" shields@192.168.50.30
```

The Pi user is `shields`; the deploy scripts all use that host and that dedicated key.
If key access is not installed yet, `cd api; .\sync.ps1 -SetupKey` once and type the Pi
password at the prompt. Never put the Pi password or private-key contents in the repo.

## Secrets

`~/smarttoolbox/.env` on the Pi and `firmware/smarttoolbox/arduino_secrets.h` locally
are untracked; the `.example` files are the tracked templates. `sync.ps1` does not copy
`.env`, so a new config key has to be added on the Pi by hand.

To check a secret really is untracked, `git check-ignore -v` is **not** enough on its
own - it exits 0 when any pattern matches, including a negation like `!.env.example`.
Ask the question that matters:

```bash
git add --dry-run <path>                    # "The following paths are ignored" = safe
git ls-files --error-unmatch <path>         # errors = not tracked
git log --all -p | grep -F '<the secret>'   # nothing = never committed
```

The last one is the only check that covers history. `git rm --cached` stops future
commits and does nothing about past ones; a secret that was ever committed should be
rotated, not trusted.
