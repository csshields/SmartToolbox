// The Pi cannot push. The serial protocol has no Pi-initiated message type -
// the device speaks first, always, and the transport only ever writes responses.
// See Communication Protocol in the spec.
//
// So a command is not sent; it is left out to be collected. The device's own
// heartbeat is the delivery vehicle: it asks every 30 seconds, and every 2
// seconds while it is still waiting for the Pi at boot, so a queued command
// waits at most one interval instead of until the next reboot.
//
// Held in memory rather than in SQLite, deliberately. A command is an
// instruction about *now* - "check for updates", "reboot" - and one that
// survived a service restart to fire hours later against a device that has
// moved on would be a surprise, not a feature.

export const DEVICE_COMMANDS = ["check-firmware", "reboot"] as const;

export type DeviceCommand = (typeof DEVICE_COMMANDS)[number];

export function isDeviceCommand(value: unknown): value is DeviceCommand {
  return typeof value === "string" && DEVICE_COMMANDS.includes(value as DeviceCommand);
}

// Long enough to cover a device that is mid-OTA or rebooting, short enough that
// a command queued against an unplugged box does not fire when it reappears
// tomorrow. The person who queued it will have stopped expecting it by then.
const COMMAND_TTL_MS = 5 * 60_000;

type PendingCommand = {
  command: DeviceCommand;
  queuedAt: number;
};

let pending: PendingCommand | null = null;

export function queueDeviceCommand(command: DeviceCommand) {
  pending = { command, queuedAt: Date.now() };
  return pending;
}

export function peekDeviceCommand() {
  if (pending && Date.now() - pending.queuedAt > COMMAND_TTL_MS) {
    pending = null;
  }

  return pending;
}

// Delivered exactly once. The device acts on collection and has no way to
// acknowledge separately - there is no Pi-initiated retry to build on - so
// leaving it queued would mean re-running it on every heartbeat until it
// expired. A reboot loop is a worse failure than a command that did not land,
// and the retry for one that did not land is queueing it again.
export function collectDeviceCommand(): DeviceCommand | null {
  const current = peekDeviceCommand();
  pending = null;
  return current?.command ?? null;
}

export function clearDeviceCommand() {
  pending = null;
}
