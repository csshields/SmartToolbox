import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Compiled binaries are dropped here by hand or by a release script. This
// mirrors data/ and logs/: it lives under the working directory on the Pi
// rather than in the repo, because sync.ps1 does not copy deploy/ and firmware
// images have no business in git.
export const FIRMWARE_DIR = "firmware";

const FIRMWARE_FILE_PATTERN = /^smarttoolbox-(\d+)\.(\d+)\.(\d+)\.bin$/;

export type FirmwareImage = {
  version: string;
  parts: [number, number, number];
  fileName: string;
  path: string;
  size: number;
};

export function parseVersion(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());

  if (!match) {
    return null;
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(a: [number, number, number], b: [number, number, number]) {
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) {
      return a[index] < b[index] ? -1 : 1;
    }
  }

  return 0;
}

// Files that do not match the naming convention are skipped rather than
// rejected: the drop folder is a working directory, and a stray README or a
// half-copied file should not take the endpoint down.
export function listFirmwareImages(directory: string): FirmwareImage[] {
  let entries: string[];

  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }

  const images: FirmwareImage[] = [];

  for (const fileName of entries) {
    const match = FIRMWARE_FILE_PATTERN.exec(fileName);

    if (!match) {
      continue;
    }

    const path = join(directory, fileName);
    let size: number;

    try {
      const stats = statSync(path);

      if (!stats.isFile()) {
        continue;
      }

      size = stats.size;
    } catch {
      continue;
    }

    images.push({
      version: `${match[1]}.${match[2]}.${match[3]}`,
      parts: [Number(match[1]), Number(match[2]), Number(match[3])],
      fileName,
      path,
      size,
    });
  }

  return images.sort((a, b) => compareVersions(a.parts, b.parts));
}

export function findLatestFirmware(directory: string): FirmwareImage | null {
  const images = listFirmwareImages(directory);

  return images.length > 0 ? images[images.length - 1]! : null;
}

// An unparseable currentVersion is treated as "older than everything" so a
// device reporting garbage still gets offered an update rather than being
// stranded on firmware that may be what broke its version string.
export function isUpdateAvailable(latest: FirmwareImage, currentVersion: string) {
  const current = parseVersion(currentVersion);

  if (!current) {
    return true;
  }

  return compareVersions(latest.parts, current) > 0;
}
