<#
.SYNOPSIS
  AXON CLI installer for Windows PowerShell.

.DESCRIPTION
  Usage:
    iwr -useb https://raw.githubusercontent.com/atharva7577/axon-cli/main/install.ps1 | iex

  Detects node + npm, fails cleanly when missing, then installs @axon/cli from
  the project's GitHub repo into the global npm prefix.

  Aborts on any error — strict mode is intentional so a half-installed CLI never
  silently lingers.
#>
$ErrorActionPreference = 'Stop'

$Repo          = 'atharva7577/axon-cli'
$MinNodeMajor  = 20

Write-Host ''
Write-Host '  AXON CLI installer'
Write-Host ''

function Abort($msg) {
  Write-Host "  ✗ $msg" -ForegroundColor Red
  exit 1
}

# ─── node ───────────────────────────────────────────────────────────────────
$nodeExe = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeExe) {
  Abort @'
Node.js not found in PATH.
    Install Node 20+ from https://nodejs.org/ or via winget:
      winget install OpenJS.NodeJS.LTS
    Then re-run this installer.
'@
}

try {
  $nodeVersion = (& node -v).TrimStart('v')
  $nodeMajor   = [int]($nodeVersion.Split('.')[0])
} catch {
  Abort "Could not parse Node version output: $($_.Exception.Message)"
}

if ($nodeMajor -lt $MinNodeMajor) {
  Abort "Node $nodeVersion found. AXON CLI requires Node $MinNodeMajor or newer."
}

# ─── npm ────────────────────────────────────────────────────────────────────
$npmExe = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npmExe) {
  Abort 'npm not found in PATH. It usually ships with Node — make sure your install is complete.'
}

# ─── install ────────────────────────────────────────────────────────────────
Write-Host "  Installing @axon/cli from github:$Repo (this runs the package's build script)…"
Write-Host ''
& npm install -g "github:$Repo"
if ($LASTEXITCODE -ne 0) {
  Abort "npm install failed with exit code $LASTEXITCODE."
}

# ─── done ───────────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '  ✓ Done. Run `axon` to get started.' -ForegroundColor Green
Write-Host '    First-run wizard will appear when no API key is on file.'
Write-Host ''
