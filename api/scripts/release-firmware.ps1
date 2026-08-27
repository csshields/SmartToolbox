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
#>
param(
	[Parameter(Mandatory = $true)]
	[string]$Version,
	# Copy the built binary to the Pi. Without this the release is local only
	# and no device can see it.
	[switch]$Push,
	# Overwrite a version that already exists in the drop folder.
	[switch]$Force,
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
$fqbn = "esp32:esp32:XIAO_ESP32S3"
$targetName = "smarttoolbox-$Version.bin"
$targetPath = Join-Path $dropDir $targetName

if (-not (Test-Path $sketchFile)) {
	throw "Sketch not found at $sketchFile"
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
$pattern = '(?m)^#define\s+FIRMWARE_VERSION\s+"[^"]*"$'

if ($source -notmatch $pattern) {
	throw "Could not find a '#define FIRMWARE_VERSION `"x.y.z`"' line in $sketchFile"
}

$updated = [regex]::Replace($source, $pattern, "#define FIRMWARE_VERSION `"$Version`"")
# Write without a BOM: the file is C++ source, and the toolchain has no reason
# to meet one at the top of it.
[System.IO.File]::WriteAllText($sketchFile, $updated, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "Compiling for $fqbn..."
if (Test-Path $buildDir) {
	Remove-Item $buildDir -Recurse -Force
}

arduino-cli compile --fqbn $fqbn --output-dir $buildDir $sketchDir
if ($LASTEXITCODE -ne 0) {
	throw "arduino-cli compile failed with exit code $LASTEXITCODE"
}

$builtBin = Join-Path $buildDir "smarttoolbox.ino.bin"
if (-not (Test-Path $builtBin)) {
	throw "Expected build output not found at $builtBin"
}

if (-not (Test-Path $dropDir)) {
	New-Item -ItemType Directory -Path $dropDir | Out-Null
}

Copy-Item $builtBin $targetPath -Force
$sizeKb = [math]::Round((Get-Item $targetPath).Length / 1KB, 1)
Write-Host "Wrote $targetPath ($sizeKb KB)" -ForegroundColor Green

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

	scp @sshOptions $targetPath "${PiHost}:~/smarttoolbox/firmware/$targetName"
	if ($LASTEXITCODE -ne 0) {
		throw "scp failed with exit code $LASTEXITCODE"
	}

	Write-Host "$targetName is now available on the Pi." -ForegroundColor Green
	Write-Host "Devices reporting a version below $Version will pull it on their next check."
} else {
	Write-Host "Local release only. Re-run with -Push to make it available to devices."
}
