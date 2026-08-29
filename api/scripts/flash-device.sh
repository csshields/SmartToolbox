#!/usr/bin/env bash
#
# Flash the XIAO from the Pi, over the USB cable that already carries
# /dev/ttyACM0. See docs/PLAN-usb-flashing.md.
#
# This is the path that works when Wi-Fi OTA cannot: an application-level update
# needs working firmware to receive it, so a build that crashes in setup() or
# breaks the serial link cannot be replaced over the air. The ROM bootloader runs
# before the application and does not care that it is broken.
#
# Usage:
#   flash-device.sh <version>          e.g. flash-device.sh 0.21.1
#   flash-device.sh <path-to-.bin>
#   flash-device.sh --list             show what is available to flash
#
# Deliberately not `set -e`. A failure here has to reach the trap that restarts
# the service, and an early exit that skips it would leave the box with no API,
# no dashboard and no serial link - which is worse than the failed flash.
set -uo pipefail

FIRMWARE_DIR="${FIRMWARE_DIR:-$HOME/smarttoolbox/firmware}"
PORT="${PORT:-/dev/ttyACM0}"
SERVICE="${SERVICE:-smarttoolbox}"
# Absolute, because Debian's package installs `esptool` (not esptool.py) and it
# is not on the PATH of a non-interactive SSH shell.
ESPTOOL="${ESPTOOL:-/usr/bin/esptool}"

list_available() {
	echo "Merged images in $FIRMWARE_DIR:"
	ls -1 "$FIRMWARE_DIR"/*.merged.bin 2>/dev/null | sed 's#.*/#  #' || echo "  (none)"
	echo
	echo "Only merged images can be flashed this way. An app-only .bin written to"
	echo "app0 while otadata points at app1 would report success and change nothing."
}

if [ $# -lt 1 ] || [ "$1" = "--list" ] || [ "$1" = "-l" ]; then
	list_available
	[ $# -lt 1 ] && exit 1
	exit 0
fi

TARGET="$1"

if [ -f "$TARGET" ]; then
	IMAGE="$TARGET"
else
	IMAGE="$FIRMWARE_DIR/smarttoolbox-$TARGET.merged.bin"
fi

if [ ! -f "$IMAGE" ]; then
	echo "No such image: $IMAGE" >&2
	echo >&2
	list_available >&2
	exit 1
fi

# The merged image is a whole 8 MB flash. Refuse anything that is obviously the
# 1 MB app binary instead - flashing that at 0x0 would overwrite the bootloader
# with application code and produce exactly the brick this script exists to fix.
SIZE=$(stat -c %s "$IMAGE")
if [ "$SIZE" -lt 2000000 ]; then
	echo "Refusing to flash $IMAGE at 0x0: it is ${SIZE} bytes." >&2
	echo "That is an app-only binary. Writing it at 0x0 would overwrite the" >&2
	echo "bootloader and brick the device. Use the *.merged.bin." >&2
	exit 1
fi

if [ ! -x "$ESPTOOL" ]; then
	echo "esptool not found at $ESPTOOL. Install it with: sudo apt-get install -y esptool" >&2
	exit 1
fi

echo "Image:   $IMAGE ($SIZE bytes)"
echo "Port:    $PORT"
echo

# Whatever happens below, the service comes back. This is the single most
# important line in the script.
SERVICE_WAS_ACTIVE=$(systemctl is-active "$SERVICE" 2>/dev/null || true)
restore_service() {
	local rc=$?
	if [ "$SERVICE_WAS_ACTIVE" = "active" ]; then
		echo
		echo "Restarting $SERVICE..."
		sudo systemctl start "$SERVICE"
		echo "$SERVICE is now: $(systemctl is-active "$SERVICE")"
	fi
	exit $rc
}
trap restore_service EXIT

if [ "$SERVICE_WAS_ACTIVE" = "active" ]; then
	echo "Stopping $SERVICE to free $PORT..."
	sudo systemctl stop "$SERVICE"
	# The serial transport reconnects on an unlimited retry with a 5s ceiling,
	# so give it a moment to actually let go of the port rather than racing it.
	sleep 2
fi

if [ ! -e "$PORT" ]; then
	echo "No device at $PORT. Is the XIAO plugged in?" >&2
	exit 1
fi

echo "Flashing..."
START=$(date +%s)

# --no-stub is mandatory here, not a preference: Debian ships esptool as
# 4.7.0+dfsg with the precompiled stub flasher blobs stripped as non-free, so
# without it every command dies on a missing stub_flasher_32s3.json - and it dies
# *late*, after connect and chip detection, which reads like a corrupt install.
#
# -z compresses. The 8 MB image is mostly 0xFF padding and goes over at about
# 11:1, so the size is not the transfer cost it appears to be.
# esptool prints one "Writing at 0x..." line per block - about 600 of them for
# this image, which buries the handful of lines that actually say anything: the
# chip it found, the compressed size, and whether the hash verified. They are
# thinned to roughly one in sixty unless VERBOSE is set, which still leaves a
# sign of life across the ~26s write.
#
# The awk is deliberately plain: `match($0, re, arr)` is a gawk extension and
# this Pi may well have mawk, where it fails at parse time.
if [ "${VERBOSE:-0}" = "1" ]; then
	"$ESPTOOL" --chip esp32s3 --port "$PORT" --baud 460800 --no-stub \
		write_flash -z 0x0 "$IMAGE"
	RC=$?
else
	"$ESPTOOL" --chip esp32s3 --port "$PORT" --baud 460800 --no-stub \
		write_flash -z 0x0 "$IMAGE" 2>&1 |
		awk '/^Writing at/ { n++; if (n % 60 == 0) print; next } { print }'
	RC=${PIPESTATUS[0]}
fi

ELAPSED=$(( $(date +%s) - START ))

echo
if [ $RC -eq 0 ]; then
	echo "Flashed and verified in ${ELAPSED}s."
	echo "The device is rebooting. It should report its new version within ~30s."
else
	echo "FLASH FAILED (exit $RC) after ${ELAPSED}s." >&2
	echo >&2
	echo "The device is most likely sitting in the ROM bootloader, which is" >&2
	echo "recoverable: run this script again. The bootloader is in silicon and" >&2
	echo "does not depend on anything that was being written." >&2
fi

exit $RC
