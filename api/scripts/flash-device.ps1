<#
.SYNOPSIS
Flashes the XIAO from the Pi over USB, and confirms it came back.

.DESCRIPTION
The recovery path. Wi-Fi OTA needs working firmware to receive an update, so a
build that crashes in setup() or breaks the serial link cannot be replaced over
the air - the thing that would accept the next update is the thing that is
broken. This talks to the ROM bootloader instead, which runs before the
application and does not care that it is broken.

Nothing new gets plugged in: it uses the USB cable already carrying
/dev/ttyACM0 between the XIAO and the Pi.

Use it when OTA cannot help, or when flashing a build you do not trust. Normal
releases should still go out with release-firmware.ps1 -Push -Now.

.EXAMPLE
# Flash a version already published to the Pi.
.\flash-device.ps1 -Version 0.21.1

.EXAMPLE
# See what the Pi can flash.
.\flash-device.ps1 -List

.EXAMPLE
# Flash a locally built image that was never published.
.\flash-device.ps1 -Version 0.22.0 -Upload
#>
param(
	[Parameter(Position = 0)]
	[string]$Version,
	# Upload the local merged image for $Version before flashing, instead of
	# using one already in the Pi's drop folder. For builds that were never
	# released - which includes anything you are testing.
	[switch]$Upload,
	# Show what the Pi has available and exit.
	[switch]$List,
	[string]$PiHost = "shields@192.168.50.30",
	[string]$KeyPath = (Join-Path $env:USERPROFILE ".ssh\smarttoolbox_pi_ed25519"),
	[string]$ApiBase = "http://192.168.50.30:3000",
	# How long to wait for the device to report in after the reset.
	[int]$WaitSeconds = 60
)

$ErrorActionPreference = "Stop"

$sshOptions = @("-i", $KeyPath, "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10")
$remoteScript = "~/smarttoolbox/scripts/flash-device.sh"

if ($List) {
	ssh @sshOptions $PiHost "bash $remoteScript --list"
	exit $LASTEXITCODE
}

if (-not $Version) {
	throw "Give a version, for example: .\flash-device.ps1 -Version 0.21.1  (or -List to see what the Pi has)"
}

if ($Upload) {
	# The merged image is not in the repo's drop folder - release-firmware.ps1
	# leaves it in the build directory, because it is 8 MB and only this path
	# wants it.
	$mergedLocal = Join-Path $env:TEMP "smarttoolbox-build-$Version\smarttoolbox.ino.merged.bin"
	if (-not (Test-Path $mergedLocal)) {
		throw "No local merged image for $Version at $mergedLocal. Build it first: .\release-firmware.ps1 -Version $Version"
	}

	Write-Host "Uploading merged image for $Version..."
	scp @sshOptions $mergedLocal "${PiHost}:~/smarttoolbox/firmware/smarttoolbox-$Version.merged.bin.tmp"
	if ($LASTEXITCODE -ne 0) { throw "Upload failed with exit code $LASTEXITCODE" }

	# Rename after the copy completes, for the same reason release-firmware.ps1
	# does: a half-copied image that looks flashable is worse than no image.
	ssh @sshOptions $PiHost "mv ~/smarttoolbox/firmware/smarttoolbox-$Version.merged.bin.tmp ~/smarttoolbox/firmware/smarttoolbox-$Version.merged.bin"
	if ($LASTEXITCODE -ne 0) { throw "Could not publish the uploaded image (exit code $LASTEXITCODE)" }
}

# Read the state first so the confirmation afterwards means something. If the
# device is bricked this will be stale or absent, which is fine - that is the
# case this script exists for.
$before = $null
try {
	$before = Invoke-RestMethod -Uri "$ApiBase/api/devices" -TimeoutSec 8
	if ($before.device) {
		Write-Host "Device currently reports v$($before.device.firmwareVersion), last seen $($before.device.lastSeen)."
	}
} catch {
	Write-Warning "Could not read $ApiBase/api/devices. Continuing - a device that cannot be read is exactly what this fixes."
}

Write-Host ""
ssh @sshOptions $PiHost "bash $remoteScript $Version"
$flashExit = $LASTEXITCODE

if ($flashExit -ne 0) {
	throw "Flash failed with exit code $flashExit. The device is most likely in the ROM bootloader; re-running this recovers it."
}

# The flash reports its own success, but "esptool wrote and verified bytes" is
# not the same claim as "the device is running them". Wait for the box itself.
Write-Host ""
Write-Host "Waiting up to $WaitSeconds s for the device to report in..."

$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
	Start-Sleep -Seconds 3
	try {
		$now = Invoke-RestMethod -Uri "$ApiBase/api/devices" -TimeoutSec 8
	} catch {
		continue
	}

	if (-not $now.device) { continue }

	# A fresh uptime is the signal, not the version: flashing the same version
	# it was already running is a legitimate thing to do, and the version alone
	# could not tell that apart from nothing having happened.
	if ($now.device.firmwareVersion -eq $Version -and $now.device.uptimeMs -lt 60000) {
		Write-Host "Confirmed: the device is running v$($now.device.firmwareVersion), up $([math]::Round($now.device.uptimeMs / 1000, 1))s." -ForegroundColor Green
		exit 0
	}
}

Write-Warning "Flashed and verified, but the device has not reported v$Version within $WaitSeconds s."
Write-Host "Check the serial log:  ssh $PiHost 'tail -20 ~/smarttoolbox/logs/service.log'"
