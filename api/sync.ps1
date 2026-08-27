param(
	[switch]$SetupKey,
	[switch]$InstallService,
	[switch]$Status,
	# Override when deploying to a different Pi. Defaults match the documented
	# development box; see .github/copilot-instructions.md > Deployment.
	[string]$PiHost = "shields@192.168.50.30",
	[string]$KeyPath = (Join-Path $env:USERPROFILE ".ssh\smarttoolbox_pi_ed25519")
)

$ErrorActionPreference = "Stop"

$sshHost = $PiHost
# Use a dedicated deploy key so syncs stay passwordless without depending on the user's default SSH identity.
$keyPath = $KeyPath
$pubKeyPath = "$keyPath.pub"

# Paths resolve from this script's own location so the repo can live anywhere.
$apiRoot = $PSScriptRoot
$candidateSourcePaths = @(
	(Join-Path $apiRoot "package.json"),
	(Join-Path $apiRoot "tsconfig.json"),
	(Join-Path $apiRoot "src"),
	(Join-Path $apiRoot "public"),
	(Join-Path $apiRoot "scripts")
)
# git does not track empty directories, so a fresh clone may be missing some of
# these. Skip what is absent rather than failing the whole sync.
$sourcePaths = @($candidateSourcePaths | Where-Object { Test-Path $_ })

if ($sourcePaths.Count -eq 0) {
	throw "No source paths found under $apiRoot. Run this script from within the repository."
}

$remotePath = "~/smarttoolbox/"
$serviceName = "smarttoolbox"
$serviceSourcePath = Join-Path $apiRoot "deploy\smarttoolbox.service"
$remoteServicePath = "/etc/systemd/system/$serviceName.service"
$sshOptions = @(
	"-i", $keyPath,
	"-o", "BatchMode=yes",
	"-o", "IdentitiesOnly=yes",
	"-o", "PreferredAuthentications=publickey",
	"-o", "PubkeyAuthentication=yes"
)
$setupSshOptions = @(
	"-i", $keyPath,
	"-o", "IdentitiesOnly=yes"
)

function Ensure-SshKey {
	if (-not (Test-Path $keyPath)) {
		Write-Host "Creating SSH key at $keyPath..."
		$startInfo = New-Object System.Diagnostics.ProcessStartInfo
		$startInfo.FileName = "ssh-keygen"
		$startInfo.Arguments = "-t ed25519 -f `"$keyPath`" -N `"`""
		$startInfo.UseShellExecute = $false
		$startInfo.RedirectStandardOutput = $true
		$startInfo.RedirectStandardError = $true

		$keygenProcess = [System.Diagnostics.Process]::Start($startInfo)
		$keygenProcess.WaitForExit()
		$keygenStdOut = $keygenProcess.StandardOutput.ReadToEnd()
		$keygenStdErr = $keygenProcess.StandardError.ReadToEnd()

		if ($keygenStdOut) {
			Write-Host $keygenStdOut.TrimEnd()
		}

		if ($keygenProcess.ExitCode -ne 0 -and $keygenStdErr) {
			Write-Error $keygenStdErr.TrimEnd()
		}

		if ($keygenProcess.ExitCode -ne 0 -or -not (Test-Path $keyPath)) {
			throw "Failed to create the deploy SSH key at $keyPath."
		}
	}

	if (-not (Test-Path $pubKeyPath)) {
		Write-Host "Rebuilding missing public key at $pubKeyPath..."
		if (-not (Test-Path $keyPath)) {
			throw "Cannot rebuild the public key because the private key at $keyPath does not exist."
		}

		$publicKey = & ssh-keygen -y -f $keyPath

		if ($LASTEXITCODE -ne 0 -or -not $publicKey) {
			throw "Failed to rebuild the public key at $pubKeyPath."
		}

		Set-Content -Path $pubKeyPath -Value $publicKey -NoNewline
	}
}

function Test-KeyAuth {
	& ssh @sshOptions $sshHost "exit" *> $null
	return $LASTEXITCODE -eq 0
}

function Install-PublicKey {
	$publicKey = (Get-Content -Raw $pubKeyPath).Trim()

	if ($publicKey.Contains("'")) {
		throw "The public key contains a single quote, which this script cannot safely install automatically."
	}

	Write-Host "Installing public key on Pi. You may be prompted for your Pi password one last time..."

	$remoteCommand = "umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; grep -qxF '$publicKey' ~/.ssh/authorized_keys || echo '$publicKey' >> ~/.ssh/authorized_keys"
	& ssh @setupSshOptions $sshHost $remoteCommand

	if ($LASTEXITCODE -ne 0) {
		throw "Failed to install the public key on the Pi."
	}
}

function Install-RemoteService {
	if (-not (Test-Path $serviceSourcePath)) {
		throw "Service file not found at $serviceSourcePath."
	}

	Write-Host "Copying systemd service file to Pi..."
	& scp @sshOptions $serviceSourcePath "$sshHost`:~/smarttoolbox.service"

	if ($LASTEXITCODE -ne 0) {
		throw "Failed to copy the systemd service file to the Pi."
	}

	Write-Host "Installing and enabling systemd service on Pi..."
	& ssh @sshOptions $sshHost "sudo install -m 644 ~/smarttoolbox.service $remoteServicePath && sudo systemctl daemon-reload && sudo systemctl enable --now $serviceName"

	if ($LASTEXITCODE -ne 0) {
		throw "Failed to install or enable the systemd service on the Pi."
	}

	Write-Host "Systemd service installed. The server will now start automatically when the Pi boots."
}

function Restart-RemoteServer {
	Write-Host "Restarting server on Pi..."
	& ssh @sshOptions $sshHost "if sudo systemctl list-unit-files $serviceName.service >/dev/null 2>&1; then sudo systemctl restart $serviceName; else cd ~/smarttoolbox && pkill -f 'bun run start'; sleep 1; nohup bun run start > server.log 2>&1 & fi"

	if ($LASTEXITCODE -ne 0) {
		throw "Server restart failed."
	}
}

function Show-RemoteStatus {
	Write-Host "Checking service status on Pi..."
	& ssh @sshOptions $sshHost "sudo systemctl --no-pager --full status $serviceName; echo; echo 'Recent service log:'; tail -n 20 ~/smarttoolbox/logs/service.log 2>/dev/null || true; echo; echo 'Recent service error log:'; tail -n 20 ~/smarttoolbox/logs/service-error.log 2>/dev/null || true"

	if ($LASTEXITCODE -ne 0) {
		throw "Failed to read service status from the Pi."
	}
}

Ensure-SshKey

if ($SetupKey) {
	Install-PublicKey

	if (-not (Test-KeyAuth)) {
		throw "Key-based SSH auth still failed after setup. Confirm that ~/.ssh/authorized_keys exists on the Pi and that SSH allows public-key auth."
	}

	Write-Host "SSH key setup complete. Future syncs should not ask for a password."
	exit 0
}

if (-not (Test-KeyAuth)) {
	throw "Key-based SSH auth is not configured on the Pi. Run .\sync.ps1 -SetupKey once to install your public key."
}

if ($Status) {
	Show-RemoteStatus
	exit 0
}

Write-Host "Syncing files to Pi..."
& scp @sshOptions -r $sourcePaths "$sshHost`:$remotePath" 2>&1 | Where-Object { $_ -notmatch "^$" }

if ($LASTEXITCODE -ne 0) {
	throw "File sync failed."
}

if ($InstallService) {
	Install-RemoteService
}

Restart-RemoteServer

Write-Host "Done! Server restarted."