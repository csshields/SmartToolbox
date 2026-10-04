<#
.SYNOPSIS
Stamps a version into the sketch, compiles it, and drops the binary where the
OTA endpoint can serve it.

.DESCRIPTION
Replaces the manual `arduino-cli upload` trip to the device. Rewrites
FIRMWARE_VERSION in the sketch, compiles, and copies the result to the drop
folder as smarttoolbox-<version>.bin. With -Push it also copies the binary to
the Pi, which is what actually makes it available for a device to pull.

The device compares its own FIRMWARE_VERSION against the newest file in the
drop folder, so the stamped version and the file name have to agree - that is
why this script owns both rather than leaving the .ino edit to a human.

.EXAMPLE
.\release-firmware.ps1 -Version 0.3.0

.EXAMPLE
.\release-firmware.ps1 -Version 0.3.0 -Push

.EXAMPLE
# Publish and have the device fetch it within one heartbeat, rather than
# waiting up to 30 minutes for its next scheduled check.
.\release-firmware.ps1 -Version 0.3.0 -Push -Now

.EXAMPLE
# A build whose partition table changed. Puts the flashable image on the Pi
# without publishing the OTA binary, because a device on the old table that
# pulled this would crash in setup() and need the USB cable anyway.
.\release-firmware.ps1 -Version 0.28.0 -Push -MergedOnly
#>
param(
	[Parameter(Mandatory = $true)]
	[string]$Version,
	# Copy the built binary to the Pi. Without this the release is local only
	# and no device can see it.
	[switch]$Push,
	# Overwrite a version that already exists in the drop folder.
	[switch]$Force,
	# Queue a check-firmware command after publishing, so the device picks the
	# build up on its next heartbeat instead of waiting up to 30 minutes for its
	# next scheduled check. Requires -Push; there is nothing to collect without it.
	[switch]$Now,
	# Push the merged image for USB flashing but NOT the app binary the OTA
	# endpoint serves.
	#
	# For a build whose partition table has changed. OTA writes an application
	# into an app slot and never repartitions, so a device on the old table that
	# pulls such a build gets firmware expecting partitions it does not have. A
	# build that links ESP_SR then calls esp_srmodel_init("model"), finds no such
	# partition, and hands a null model set to the AFE - which is a crash in
	# setup(), on a device that just overwrote its only working firmware to get
	# there. Recovering that is the USB cable.
	#
	# So: -MergedOnly puts the flashable image on the Pi and leaves the OTA
	# folder alone. Flash over USB, confirm the box is up, then release again
	# without this switch to make the build available over the air.
	[switch]$MergedOnly,
	# Override when deploying to a different Pi; defaults match sync.ps1.
	[string]$PiHost = "shields@192.168.50.30",
	[string]$KeyPath = (Join-Path $env:USERPROFILE ".ssh\smarttoolbox_pi_ed25519")
)

$ErrorActionPreference = "Stop"

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
	throw "Version must be major.minor.patch (for example 0.3.0). Got: $Version"
}

# Paths resolve from this script's own location so the repo can live anywhere.
$apiRoot = Split-Path $PSScriptRoot -Parent
$repoRoot = Split-Path $apiRoot -Parent
$sketchDir = Join-Path $repoRoot "firmware\smarttoolbox"
$sketchFile = Join-Path $sketchDir "smarttoolbox.ino"
$dropDir = Join-Path $apiRoot "firmware"
$buildDir = Join-Path $env:TEMP "smarttoolbox-build-$Version"
# The fqbn and the core and library versions all live in the sketch profile now,
# so a release build does not depend on what happens to be installed globally on
# the machine running this script. PSRAM=opi is pinned in there too, and it is
# load-bearing rather than tuning: the bare fqbn takes the first PSRAM menu
# entry, which is Disabled, and ps_malloc then returns null on every call - so
# the microphone buffer cannot be allocated at all.
$profileName = "release"
$sketchProfile = Join-Path $sketchDir "sketch.yaml"
$targetName = "smarttoolbox-$Version.bin"
$targetPath = Join-Path $dropDir $targetName

if (-not (Test-Path $sketchFile)) {
	throw "Sketch not found at $sketchFile"
}

# Without this the compile below would silently fall back to the globally
# installed libraries, which is the whole thing the profile exists to prevent.
if (-not (Test-Path $sketchProfile)) {
	throw "No build profile at $sketchProfile. A release must build against pinned versions."
}

if ((Test-Path $targetPath) -and (-not $Force)) {
	throw "$targetName already exists in the drop folder. Bump the version, or pass -Force to overwrite."
}

# Warn rather than block: re-releasing an older version is occasionally what you
# want (rolling back a bad build), but it is never what you want by accident.
if (Test-Path $dropDir) {
	$existing = Get-ChildItem $dropDir -Filter "smarttoolbox-*.bin" -ErrorAction SilentlyContinue
	foreach ($file in $existing) {
		if ($file.Name -match '^smarttoolbox-(\d+)\.(\d+)\.(\d+)\.bin$') {
			$other = [version]"$($matches[1]).$($matches[2]).$($matches[3])"
			if ($other -gt [version]$Version) {
				Write-Warning "$($file.Name) in the drop folder is newer than $Version. Devices will keep pulling that one."
			}
		}
	}
}

Write-Host "Stamping FIRMWARE_VERSION $Version into the sketch..."
$source = [System.IO.File]::ReadAllText($sketchFile)
# Deliberately not anchored to end-of-line. A '$' here matches before the \n but
# after the \r of a CRLF file, so the match silently fails the moment an editor
# saves with Windows line endings - and consuming the \r to fix that would
# rewrite the line ending and leave the file mixed. The leading ^ plus the
# literal directive is specific enough on its own.
$pattern = '(?m)^[ \t]*#define[ \t]+FIRMWARE_VERSION[ \t]+"[^"]*"'
$matchCount = ([regex]::Matches($source, $pattern)).Count

if ($matchCount -ne 1) {
	throw "Expected exactly one '#define FIRMWARE_VERSION `"x.y.z`"' line in $sketchFile, found $matchCount"
}

$updated = [regex]::Replace($source, $pattern, "#define FIRMWARE_VERSION `"$Version`"")
# Write without a BOM: the file is C++ source, and the toolchain has no reason
# to meet one at the top of it.
[System.IO.File]::WriteAllText($sketchFile, $updated, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "Compiling with the '$profileName' profile..."
if (Test-Path $buildDir) {
	Remove-Item $buildDir -Recurse -Force
}

# The first profile build on a machine downloads its own copy of the core and
# toolchain and takes many minutes. That is the cost of not sharing state with
# the global install; later builds reuse the same cache and are normal speed.
arduino-cli compile --profile $profileName --output-dir $buildDir $sketchDir
if ($LASTEXITCODE -ne 0) {
	throw "arduino-cli compile failed with exit code $LASTEXITCODE"
}

$builtBin = Join-Path $buildDir "smarttoolbox.ino.bin"
if (-not (Test-Path $builtBin)) {
	throw "Expected build output not found at $builtBin"
}

# Read the app slot size out of the sketch's own partition table and check the
# binary against it.
#
# This is not belt and braces, it is the only check there is. arduino-cli takes
# the "Maximum is ..." figure it prints from the board definition's
# upload.maximum_size, not from partitions.csv - so with our table it reports the
# binary as 65% of 3,342,336 when it is really 90% of 2,424,832. A build that
# overflows the real slot would compile, report two thirds full, produce a
# merged image, and fail at the box.
$partitionsFile = Join-Path $sketchDir "partitions.csv"
if (Test-Path $partitionsFile) {
	$appRow = Get-Content $partitionsFile |
		Where-Object { $_ -match '^\s*app0\s*,' } |
		Select-Object -First 1

	if (-not $appRow) {
		throw "No app0 row found in $partitionsFile"
	}

	# Name, Type, SubType, Offset, Size - size is the fifth field.
	$appSlotSize = [Convert]::ToInt64(($appRow -split ',')[4].Trim(), 16)
	$binSize = (Get-Item $builtBin).Length
	$percent = [math]::Round(100 * $binSize / $appSlotSize, 1)

	if ($binSize -gt $appSlotSize) {
		throw "Binary is $binSize bytes against an app slot of $appSlotSize. It will not fit. Rebalance $partitionsFile - the model partition is the only place the space can come from."
	}

	$colour = if ($percent -gt 90) { "Yellow" } else { "Green" }
	Write-Host "App slot: $binSize of $appSlotSize bytes ($percent%)" -ForegroundColor $colour
}

if (-not (Test-Path $dropDir)) {
	New-Item -ItemType Directory -Path $dropDir | Out-Null
}

Copy-Item $builtBin $targetPath -Force
$sizeKb = [math]::Round((Get-Item $targetPath).Length / 1KB, 1)
Write-Host "Wrote $targetPath ($sizeKb KB)" -ForegroundColor Green

# The merged image is the whole 8 MB flash - bootloader, partition table, otadata
# and application. OTA does not want it (the device writes the app binary into
# the inactive slot itself), but flash-device.sh can only use this: an app-only
# binary written to app0 while otadata points at app1 reports success and changes
# nothing. Published alongside so a known-good image is always on the Pi when the
# recovery path is needed - which is never a moment to be rebuilding one.
$builtMerged = Join-Path $buildDir "smarttoolbox.ino.merged.bin"
$mergedName = "smarttoolbox-$Version.merged.bin"
$mergedPath = Join-Path $dropDir $mergedName
$haveMerged = Test-Path $builtMerged

if ($haveMerged) {
	Copy-Item $builtMerged $mergedPath -Force

	# Splice the ESP-SR speech models into the merged image.
	#
	# **This is what makes USB flashing safe rather than destructive.**
	# arduino-cli builds the merged image out of the bootloader, the partition
	# table, otadata and the application. It knows nothing about the `model`
	# partition, so it leaves that region as 0xFF padding - and flash-device.sh
	# writes the whole 8 MB at offset 0. Without this step every USB flash,
	# including every recovery flash, silently erases the speech models and the
	# device comes back with the wake word dead and no error anywhere to say why.
	# The one path that exists for when OTA cannot help would have been the path
	# that broke this feature.
	#
	# The offset is read from partitions.csv rather than written here twice, so
	# moving the partition cannot leave this script writing to the old address.
	$modelBlob = $null
	if (Test-Path $partitionsFile) {
		$modelRow = Get-Content $partitionsFile |
			Where-Object { $_ -match '^\s*model\s*,' } |
			Select-Object -First 1

		if (-not $modelRow) {
			throw "No model row in $partitionsFile, but the firmware links ESP_SR and expects one."
		}

		$fields = $modelRow -split ','
		$modelOffset = [Convert]::ToInt64($fields[3].Trim(), 16)
		$modelSize = [Convert]::ToInt64($fields[4].Trim(), 16)

		# Tracks the core pinned in sketch.yaml, so a core bump moves this with
		# it instead of quietly flashing last version's models.
		$profileText = Get-Content (Join-Path $sketchDir "sketch.yaml") -Raw
		if ($profileText -notmatch 'platform:\s*esp32:esp32\s*\(([^)]+)\)') {
			throw "Could not read the pinned esp32 core version out of sketch.yaml"
		}
		$coreVersion = $Matches[1].Trim()
		$modelBlob = Join-Path $env:LOCALAPPDATA "Arduino15\packages\esp32\tools\esp32s3-libs\$coreVersion\esp_sr\srmodels.bin"

		if (-not (Test-Path $modelBlob)) {
			throw "Speech models not found at $modelBlob. The firmware links ESP_SR and will not detect a wake word without them."
		}

		$blobBytes = [System.IO.File]::ReadAllBytes($modelBlob)
		if ($blobBytes.Length -gt $modelSize) {
			throw "srmodels.bin is $($blobBytes.Length) bytes against a model partition of $modelSize. Rebalance $partitionsFile."
		}

		$merged = [System.IO.File]::Open($mergedPath, 'Open', 'Write')
		try {
			$merged.Seek($modelOffset, 'Begin') | Out-Null
			$merged.Write($blobBytes, 0, $blobBytes.Length)
		} finally {
			$merged.Close()
		}

		$blobMb = [math]::Round($blobBytes.Length / 1MB, 2)
		Write-Host "Spliced srmodels.bin ($blobMb MB) into the merged image at 0x$($modelOffset.ToString('X'))" -ForegroundColor Green
	}

	$mergedMb = [math]::Round((Get-Item $mergedPath).Length / 1MB, 1)
	Write-Host "Wrote $mergedPath ($mergedMb MB, for flash-device)" -ForegroundColor Green
} else {
	Write-Warning "No merged image at $builtMerged - USB flashing will not have one for $Version."
}

if ($Push) {
	$sshOptions = @(
		"-i", $KeyPath,
		"-o", "BatchMode=yes",
		"-o", "IdentitiesOnly=yes",
		"-o", "PreferredAuthentications=publickey",
		"-o", "PubkeyAuthentication=yes"
	)

	Write-Host "Pushing to $PiHost..."
	ssh @sshOptions $PiHost "mkdir -p ~/smarttoolbox/firmware"
	if ($LASTEXITCODE -ne 0) {
		throw "Could not create the remote drop folder (exit code $LASTEXITCODE)"
	}

	# Upload under a temporary name, then rename. The endpoint scans the folder
	# by file name, so copying straight to the final name publishes a truncated
	# image the moment scp creates it: a device polling mid-transfer would get a
	# partial binary advertised with an honest Content-Length, and only the
	# post-write verification would catch it. mv within one filesystem is atomic.
	if ($MergedOnly) {
		Write-Host "-MergedOnly: skipping the OTA binary, pushing the flashable image only." -ForegroundColor Yellow
	} else {
		scp @sshOptions $targetPath "${PiHost}:~/smarttoolbox/firmware/$targetName.tmp"
		if ($LASTEXITCODE -ne 0) {
			throw "scp failed with exit code $LASTEXITCODE"
		}

		ssh @sshOptions $PiHost "mv ~/smarttoolbox/firmware/$targetName.tmp ~/smarttoolbox/firmware/$targetName"
		if ($LASTEXITCODE -ne 0) {
			throw "Could not publish the uploaded image (exit code $LASTEXITCODE)"
		}
	}

	# Same tmp-then-rename dance. It matters less here - nothing scans for merged
	# images the way the OTA endpoint scans for app binaries - but a half-copied
	# 8 MB file that looks flashable is exactly the wrong thing to find during a
	# recovery.
	if ($haveMerged) {
		Write-Host "Pushing merged image for USB flashing..."
		scp @sshOptions $mergedPath "${PiHost}:~/smarttoolbox/firmware/$mergedName.tmp"
		if ($LASTEXITCODE -ne 0) {
			throw "scp of the merged image failed with exit code $LASTEXITCODE"
		}

		ssh @sshOptions $PiHost "mv ~/smarttoolbox/firmware/$mergedName.tmp ~/smarttoolbox/firmware/$mergedName"
		if ($LASTEXITCODE -ne 0) {
			throw "Could not publish the uploaded merged image (exit code $LASTEXITCODE)"
		}
	}

	if ($MergedOnly) {
		Write-Host "$mergedName is on the Pi for USB flashing. $targetName was NOT published for OTA." -ForegroundColor Green
		Write-Host "Flash it with: .\flash-device.ps1 -Version $Version" -ForegroundColor Cyan
	} else {
		Write-Host "$targetName is now available on the Pi." -ForegroundColor Green
	}

	if ($Now -and $MergedOnly) {
		throw "-Now with -MergedOnly would tell the device to collect a build that was deliberately not published. Drop one of them."
	}

	if ($Now) {
		Write-Host ""
		& (Join-Path $PSScriptRoot "push-to-device.ps1") -Command check-firmware
	} else {
		if ($MergedOnly) {
			Write-Host "No device will pull this on its own - it was not published for OTA. Flash it over USB."
		} else {
			Write-Host "Devices reporting a version below $Version will pull it on their next check."
		}
		Write-Host "Add -Now to have the device fetch it within one heartbeat instead."
	}
} else {
	Write-Host "Local release only. Re-run with -Push to make it available to devices."

	if ($Now) {
		Write-Warning "-Now does nothing without -Push: there is no published build for the device to collect."
	}
}
