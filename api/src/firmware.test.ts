import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareVersions,
  findLatestFirmware,
  isUpdateAvailable,
  listFirmwareImages,
  parseVersion,
} from "./firmware";

function fixtureDir(fileNames: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "firmware-"));

  for (const fileName of fileNames) {
    writeFileSync(join(directory, fileName), "binary");
  }

  return directory;
}

test("parses and rejects version strings", () => {
  expect(parseVersion("0.2.0")).toEqual([0, 2, 0]);
  expect(parseVersion(" 1.10.3 ")).toEqual([1, 10, 3]);
  expect(parseVersion("0.2")).toBeNull();
  expect(parseVersion("v0.2.0")).toBeNull();
  expect(parseVersion("")).toBeNull();
});

test("compares versions numerically, not lexically", () => {
  // The bug this guards: string comparison puts 0.10.0 before 0.9.0.
  expect(compareVersions([0, 10, 0], [0, 9, 0])).toBe(1);
  expect(compareVersions([0, 2, 0], [0, 2, 0])).toBe(0);
  expect(compareVersions([1, 0, 0], [0, 99, 99])).toBe(1);
});

test("lists only correctly named firmware files", () => {
  const directory = fixtureDir([
    "smarttoolbox-0.2.0.bin",
    "smarttoolbox-0.10.0.bin",
    "README.md",
    "smarttoolbox-0.3.bin",
    "notes-1.0.0.bin",
  ]);

  const images = listFirmwareImages(directory);

  expect(images.map((image) => image.version)).toEqual(["0.2.0", "0.10.0"]);
});

test("ignores directories that look like firmware files", () => {
  const directory = fixtureDir(["smarttoolbox-0.2.0.bin"]);
  mkdirSync(join(directory, "smarttoolbox-9.9.9.bin"));

  expect(findLatestFirmware(directory)?.version).toBe("0.2.0");
});

test("returns null for a missing or empty drop folder", () => {
  expect(findLatestFirmware(join(tmpdir(), "does-not-exist-firmware"))).toBeNull();
  expect(findLatestFirmware(fixtureDir([]))).toBeNull();
});

test("finds the newest image by version, not by filename order", () => {
  const directory = fixtureDir([
    "smarttoolbox-0.9.0.bin",
    "smarttoolbox-0.10.0.bin",
    "smarttoolbox-0.2.0.bin",
  ]);

  expect(findLatestFirmware(directory)?.version).toBe("0.10.0");
});

test("offers an update only when the image is strictly newer", () => {
  const directory = fixtureDir(["smarttoolbox-0.2.0.bin"]);
  const latest = findLatestFirmware(directory)!;

  expect(isUpdateAvailable(latest, "0.1.0")).toBe(true);
  expect(isUpdateAvailable(latest, "0.2.0")).toBe(false);
  expect(isUpdateAvailable(latest, "0.3.0")).toBe(false);
});

test("treats an unparseable reported version as out of date", () => {
  const directory = fixtureDir(["smarttoolbox-0.2.0.bin"]);
  const latest = findLatestFirmware(directory)!;

  expect(isUpdateAvailable(latest, "garbage")).toBe(true);
  expect(isUpdateAvailable(latest, "")).toBe(true);
});

test("ignores the merged flash images that sit beside the app binaries", () => {
  // release-firmware.ps1 publishes smarttoolbox-<v>.merged.bin alongside the app
  // binary, for the USB recovery path in docs/PLAN-usb-flashing.md. Those must
  // never be served over OTA: a merged image is the whole 8 MB flash, and a
  // device handed one as an application update would write a bootloader into its
  // app partition. The file pattern is anchored so they cannot match - this test
  // is here so that stays true if anyone ever loosens it.
  const directory = fixtureDir([
    "smarttoolbox-0.2.0.bin",
    "smarttoolbox-0.9.0.merged.bin",
  ]);

  expect(findLatestFirmware(directory)?.version).toBe("0.2.0");
});

test("ignores a merged image even when it is the only file present", () => {
  const directory = fixtureDir(["smarttoolbox-0.9.0.merged.bin"]);

  expect(findLatestFirmware(directory)).toBeNull();
});
