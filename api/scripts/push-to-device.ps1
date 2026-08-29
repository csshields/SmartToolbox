<#
.SYNOPSIS
Queues a command for the XIAO and waits for it to be collected.

.DESCRIPTION
The Pi cannot push. The serial protocol has no Pi-initiated message type - the
device speaks first, always - so a command is left waiting and collected on the
device's next heartbeat. That is every 30 seconds while it is running, and every
2 seconds while it is still waiting for the Pi at boot.

So this is not instant, and it deliberately does not pretend to be: it queues,
then watches until the device acts, and tells you which happened.

Commands:
  check-firmware  Ask the device to look for an update now, instead of waiting
                  up to 30 minutes for its next scheduled check.
  reboot          Restart the device.

.EXAMPLE
.\push-to-device.ps1 check-firmware

.EXAMPLE
# Release a build and get it onto the device without waiting for the interval.
.\release-firmware.ps1 -Version 0.21.0 -Push
.\push-to-device.ps1 check-firmware
#>
param(
	[Parameter(Position = 0)]
	[ValidateSet("check-firmware", "reboot")]
	[string]$Command = "check-firmware",
	# Override when talking to a different Pi; the default matches sync.ps1.
	[string]$ApiBase = "http://192.168.50.30:3000",
	# How long to watch for the device to act. The heartbeat is 30s, so anything
	# under about 45 gives a false negative on a perfectly healthy device.
	[int]$WaitSeconds = 90,
	# Queue it and return, without watching.
	[switch]$NoWait
)

$ErrorActionPreference = "Stop"

function Get-DeviceState {
	try {
		return Invoke-RestMethod -Uri "$ApiBase/api/devices" -TimeoutSec 8
	} catch {
		throw "Cannot reach the API at $ApiBase - is the Pi up? ($($_.Exception.Message))"
	}
}

$before = Get-DeviceState

if (-not $before.device) {
	Write-Warning "The Pi has never seen this device. Queueing anyway, but nothing will collect it."
} else {
	Write-Host "Device is on v$($before.device.firmwareVersion), last seen $($before.device.lastSeen)."
}

if ($Command -eq "check-firmware" -and $before.firmware -and -not $before.firmware.updateAvailable) {
	Write-Host "Note: the Pi has no newer build than the device is already running." -ForegroundColor Yellow
	Write-Host "      Release one first with release-firmware.ps1 -Push." -ForegroundColor Yellow
}

$body = @{ command = $Command } | ConvertTo-Json -Compress
$queued = Invoke-RestMethod -Uri "$ApiBase/api/devices/command" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 8
Write-Host "Queued '$($queued.queued.command)'. $($queued.message)"

if ($NoWait) {
	return
}

# What "it worked" looks like differs by command, so watch for the right thing
# rather than for a generic acknowledgement the protocol does not have.
#  - check-firmware: either the version changes, or the command is collected and
#    the device decides it is already up to date.
#  - reboot: uptimeMs runs backwards, which is how the Pi detects a restart at
#    all - the boot announcement is not reliable enough to watch for.
$deadline = (Get-Date).AddSeconds($WaitSeconds)
$startVersion = $before.device.firmwareVersion
$startUptime = $before.device.uptimeMs
$collected = $false

Write-Host "Waiting up to $WaitSeconds s for the device to collect it..."

while ((Get-Date) -lt $deadline) {
	Start-Sleep -Seconds 3
	$now = Get-DeviceState

	if (-not $collected -and -not $now.pendingCommand) {
		$collected = $true
		Write-Host "  collected by the device." -ForegroundColor Green
		if ($Command -eq "check-firmware") {
			Write-Host "  it is checking now; a download and reboot takes another 20-40 s."
		}
	}

	if (-not $now.device) { continue }

	if ($Command -eq "check-firmware" -and $now.device.firmwareVersion -ne $startVersion) {
		Write-Host "Done: v$startVersion -> v$($now.device.firmwareVersion)." -ForegroundColor Green
		return
	}

	if ($Command -eq "reboot" -and $now.device.uptimeMs -lt $startUptime) {
		Write-Host "Done: the device restarted (uptime ran backwards)." -ForegroundColor Green
		return
	}
}

if ($collected) {
	# Not a failure. For check-firmware the usual reason is the honest one.
	Write-Host "Collected, but nothing changed within $WaitSeconds s." -ForegroundColor Yellow
	Write-Host "For check-firmware that normally means the device was already up to date."
} else {
	Write-Warning "Still not collected after $WaitSeconds s. The device may be unplugged, or the serial listener may be down - check GET $ApiBase/api/devices."
}
