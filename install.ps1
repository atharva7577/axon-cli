<#
.SYNOPSIS
  AXON CLI installer for Windows PowerShell.

.DESCRIPTION
  Usage:
    iwr -useb https://raw.githubusercontent.com/atharva7577/axon-cli/main/install.ps1 | iex

  Detects node + npm, then installs @axon/cli from the project's GitHub repo
  into the global npm prefix. After install, verifies the `axon` shim is
  reachable from PATH and tells the user exactly what to do if it isn't.

  This script is designed to be safe when piped through `iex` — it NEVER
  calls `exit`, because `exit` would terminate the host PowerShell window.
  Failures `return` instead.
#>

# Intentionally NOT setting $ErrorActionPreference = 'Stop'. On PS 5.1, that
# promotes npm's benign stderr writes (funding notices, "added N packages")
# to terminating NativeCommandError records — and combined with `exit 1`
# would close the user's window.
$Repo         = 'atharva7577/axon-cli'
$MinNodeMajor = 20
$ok = $true

function Write-Banner {
    Write-Host ''
    Write-Host '  ==> AXON CLI installer'
    Write-Host ''
}

function Write-Fail($msg) {
    Write-Host "  [FAIL] $msg" -ForegroundColor Red
}

function Write-Ok($msg) {
    Write-Host "  [OK]   $msg" -ForegroundColor Green
}

function Write-Hint($msg) {
    Write-Host "  [!]    $msg" -ForegroundColor Yellow
}

Write-Banner

# --- node --------------------------------------------------------------------
$nodeExe = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeExe) {
    Write-Fail 'Node.js not found in PATH.'
    Write-Host '         Install Node 20+ from https://nodejs.org/ then re-run this installer.'
    Write-Host '         Or via winget:  winget install OpenJS.NodeJS.LTS'
    return
}

$nodeVersion = $null
try {
    $nodeVersion = (& node -v).TrimStart('v')
    $nodeMajor   = [int]($nodeVersion.Split('.')[0])
} catch {
    Write-Fail "Could not parse node version output: $($_.Exception.Message)"
    return
}

if ($nodeMajor -lt $MinNodeMajor) {
    Write-Fail "Node $nodeVersion found. AXON CLI requires Node $MinNodeMajor or newer."
    return
}

# --- npm ---------------------------------------------------------------------
$npmExe = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npmExe) {
    Write-Fail 'npm not found in PATH. It usually ships with Node - make sure your install is complete.'
    return
}

# --- install -----------------------------------------------------------------
Write-Host "  Installing @axon/cli from github:$Repo ..."
Write-Host ''
# --install-links forces npm to COPY files instead of creating a junction to
# its temp git-clone dir. Without it, the temp dir gets cleaned up after the
# install and the global `axon` shim points at a dangling path -- the classic
# Windows-only failure mode for `npm i -g github:user/repo`.
& npm install -g "github:$Repo" --install-links
$installExit = $LASTEXITCODE

if ($installExit -ne 0) {
    Write-Fail "npm install exited with code $installExit."
    Write-Host '         Look in the most recent log under %LOCALAPPDATA%\npm-cache\_logs for the cause.'
    return
}

# --- post-install PATH sanity ------------------------------------------------
$prefix = $null
try { $prefix = (& npm prefix -g).Trim() } catch { $prefix = $null }

$axonOnPath = Get-Command axon -ErrorAction SilentlyContinue

if ($axonOnPath) {
    Write-Host ''
    Write-Ok "@axon/cli installed and ready. Run 'axon' to start."
    Write-Host '         First-run wizard will appear when no API key is on file.'
    Write-Host ''
    return
}

# axon not on PATH yet — figure out why and tell the user precisely what to do.
$shimPath = if ($prefix) { Join-Path $prefix 'axon.cmd' } else { $null }
$shimExists = $shimPath -and (Test-Path $shimPath)

Write-Host ''
if ($shimExists) {
    Write-Ok "@axon/cli installed at: $prefix"
    Write-Hint "Open a NEW PowerShell window to use it."
    Write-Host '         The official Node installer adds this directory to PATH, but only for'
    Write-Host '         shells started AFTER the install. Your current shell still has the old PATH.'
    Write-Host ''
    Write-Host '         Or run it directly from this shell:'
    Write-Host "             & '$shimPath' --version"
    Write-Host ''
} else {
    Write-Fail "npm reported success but no axon shim was found at expected prefix: $prefix"
    Write-Host '         Open an issue with the output above and the contents of'
    Write-Host '         %LOCALAPPDATA%\npm-cache\_logs (latest *-debug-0.log).'
    Write-Host ''
}
