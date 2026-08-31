import { afterAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import {
  clearDeviceCommand,
  collectDeviceCommand,
  isDeviceCommand,
  peekDeviceCommand,
  queueDeviceCommand,
} from "./deviceCommands";

// The queue is module state, deliberately - see the header of deviceCommands.ts.
// Every test starts from empty rather than from whatever the last one left, and
// from real time rather than from a clock a TTL test moved.
beforeEach(() => {
  setSystemTime();
  clearDeviceCommand();
});

afterAll(() => {
  setSystemTime();
});

test("a queued command waits to be collected", () => {
  queueDeviceCommand("reboot");

  expect(peekDeviceCommand()?.command).toBe("reboot");
});

test("peeking does not consume the command", () => {
  queueDeviceCommand("check-firmware");

  expect(peekDeviceCommand()?.command).toBe("check-firmware");
  expect(peekDeviceCommand()?.command).toBe("check-firmware");
});

test("a command is delivered exactly once", () => {
  // The contract the spec calls load-bearing. The device acts on collection and
  // has no way to acknowledge separately, so leaving the command queued would
  // re-run it on every heartbeat - a missed reboot would become a reboot loop.
  queueDeviceCommand("reboot");

  expect(collectDeviceCommand()).toBe("reboot");
  expect(collectDeviceCommand()).toBeNull();
});

test("collecting an empty queue is null, not an error", () => {
  expect(collectDeviceCommand()).toBeNull();
});

test("queueing again replaces the command rather than stacking it", () => {
  // One slot on purpose: two commands would need an order and an acknowledgement
  // to deliver reliably, and the transport has neither.
  queueDeviceCommand("reboot");
  queueDeviceCommand("check-firmware");

  expect(collectDeviceCommand()).toBe("check-firmware");
  expect(collectDeviceCommand()).toBeNull();
});

test("a command queued against a box that never came back expires", () => {
  // Five minutes. A command is an instruction about *now*, and one that fired
  // against a device that reappeared tomorrow would be a surprise, not a feature.
  queueDeviceCommand("reboot");
  setSystemTime(new Date(Date.now() + 5 * 60_000 + 1));

  expect(peekDeviceCommand()).toBeNull();
  expect(collectDeviceCommand()).toBeNull();
});

test("a command still inside the window survives", () => {
  // The window has to cover a device that is mid-OTA or rebooting, which is
  // exactly when a queued command is most likely to be waiting.
  queueDeviceCommand("reboot");
  setSystemTime(new Date(Date.now() + 4 * 60_000));

  expect(collectDeviceCommand()).toBe("reboot");
});

test("isDeviceCommand accepts only the commands the device knows", () => {
  // The guard on anything arriving from the dashboard or push-to-device.ps1: an
  // unknown string queued here would be delivered to the device and ignored
  // there, with nothing to say why.
  expect(isDeviceCommand("reboot")).toBe(true);
  expect(isDeviceCommand("check-firmware")).toBe(true);

  expect(isDeviceCommand("shutdown")).toBe(false);
  expect(isDeviceCommand("")).toBe(false);
  expect(isDeviceCommand(undefined)).toBe(false);
  expect(isDeviceCommand({ command: "reboot" })).toBe(false);
});
