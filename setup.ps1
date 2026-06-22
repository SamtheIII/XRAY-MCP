#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

$ProjectRoot = $PSScriptRoot

function Write-Step([string]$msg) { Write-Host "`n>> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "   OK  $msg" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "  WARN $msg" -ForegroundColor Yellow }
function Abort([string]$msg)      { Write-Host "`nERROR: $msg" -ForegroundColor Red; exit 1 }

# ── 1. Node.js check ──────────────────────────────────────────────────────────
Write-Step "Checking Node.js"
try { $nodeVersion = node --version 2>$null } catch { Abort "Node.js not found. Install 18+ from https://nodejs.org" }
$nodeMajor = [int]($nodeVersion -replace 'v(\d+).*','$1')
if ($nodeMajor -lt 18) { Abort "Node.js 18+ required. Current: $nodeVersion" }
Write-Ok "Node.js $nodeVersion"

# ── 2. npm install ────────────────────────────────────────────────────────────
Write-Step "Installing dependencies"
Push-Location $ProjectRoot
try {
    npm install --prefer-offline --no-fund --no-audit 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Abort "npm install failed" }
} finally { Pop-Location }
Write-Ok "Dependencies installed"

# ── 3. Build ──────────────────────────────────────────────────────────────────
Write-Step "Building TypeScript"
Push-Location $ProjectRoot
try {
    npm run build 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Abort "Build failed. Run 'npm run build' manually to see errors." }
} finally { Pop-Location }
Write-Ok "Build succeeded -> dist/stdio.js"

# ── 4. Credentials ────────────────────────────────────────────────────────────
Write-Step "Xray API credentials"
$envFile = Join-Path $ProjectRoot '.env.local'

$existingId     = ''
$existingSecret = ''
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^XRAY_CLIENT_ID=(.+)$')     { $existingId     = $Matches[1] }
        if ($line -match '^XRAY_CLIENT_SECRET=(.+)$') { $existingSecret = $Matches[1] }
    }
}

$promptId = if ($existingId) { " (Enter to keep existing)" } else { "" }
$clientId = Read-Host "  XRAY_CLIENT_ID$promptId"
if ($clientId -eq '' -and $existingId) { $clientId = $existingId }
if ($clientId -eq '') { Abort "XRAY_CLIENT_ID is required" }

$promptSecret = if ($existingSecret) { " (Enter to keep existing)" } else { "" }
$clientSecret = Read-Host "  XRAY_CLIENT_SECRET$promptSecret"
if ($clientSecret -eq '' -and $existingSecret) { $clientSecret = $existingSecret }
if ($clientSecret -eq '') { Abort "XRAY_CLIENT_SECRET is required" }

# Write without BOM — dotenv is sensitive to the BOM marker
$envContent = "XRAY_CLIENT_ID=$clientId`nXRAY_CLIENT_SECRET=$clientSecret"
[System.IO.File]::WriteAllText($envFile, $envContent, [System.Text.UTF8Encoding]::new($false))
Write-Ok ".env.local written"

# ── 5. Claude Desktop config ──────────────────────────────────────────────────
Write-Step "Registering MCP server in Claude Desktop"

# Claude Desktop can live in three locations depending on install type.
# Check Store package path first (wildcard for the package ID suffix), then
# the two standard paths, then default to the Roaming path if none exist yet.
$storeConfig = Get-ChildItem "$env:LOCALAPPDATA\Packages\Claude_*\LocalCache\Roaming\Claude\claude_desktop_config.json" -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
$claudeConfigLocal   = Join-Path $env:LOCALAPPDATA 'Claude\claude_desktop_config.json'
$claudeConfigRoaming = Join-Path $env:APPDATA      'Claude\claude_desktop_config.json'
if      ($storeConfig)                   { $claudeConfigPath = $storeConfig }
elseif  (Test-Path $claudeConfigLocal)   { $claudeConfigPath = $claudeConfigLocal }
elseif  (Test-Path $claudeConfigRoaming) { $claudeConfigPath = $claudeConfigRoaming }
else                                     { $claudeConfigPath = $claudeConfigRoaming }

$stdioPath = Join-Path $ProjectRoot 'dist\stdio.js'

if (Test-Path $claudeConfigPath) {
    $raw = [System.IO.File]::ReadAllText($claudeConfigPath).Trim()
    $config = if ($raw.Length -gt 0) { $raw | ConvertFrom-Json } else { $null }
    if ($null -eq $config) { $config = [PSCustomObject]@{} }
} else {
    $claudeDir = Split-Path $claudeConfigPath
    if (-not (Test-Path $claudeDir)) { New-Item -ItemType Directory -Force -Path $claudeDir | Out-Null }
    $config = [PSCustomObject]@{}
}

# Ensure mcpServers exists and is an object (guard against null in existing config)
$hasMcp = Get-Member -InputObject $config -Name 'mcpServers' -MemberType NoteProperty -ErrorAction SilentlyContinue
if (-not $hasMcp -or $null -eq $config.mcpServers) {
    if ($hasMcp) { $config.PSObject.Properties.Remove('mcpServers') }
    $config | Add-Member -MemberType NoteProperty -Name 'mcpServers' -Value ([PSCustomObject]@{})
}

# Build xray entry — credentials stay in .env.local, not in the config file
$xrayEntry = [PSCustomObject]@{
    command = 'node'
    args    = @($stdioPath)
}

$hasXray = Get-Member -InputObject $config.mcpServers -Name 'xray' -MemberType NoteProperty -ErrorAction SilentlyContinue
if ($hasXray) { Write-Warn "Existing 'xray' entry replaced" }
$config.mcpServers | Add-Member -MemberType NoteProperty -Name 'xray' -Value $xrayEntry -Force

# Write without BOM
$json = $config | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($claudeConfigPath, $json, [System.Text.UTF8Encoding]::new($false))
Write-Ok "Config updated: $claudeConfigPath"

# ── 6. Claude Code (CLI) ──────────────────────────────────────────────────────
Write-Step "Registering MCP server in Claude Code"
$claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
if ($claudeCmd) {
    claude mcp remove xray 2>$null | Out-Null
    claude mcp add xray node $stdioPath --scope user 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Ok "Registered in Claude Code (user scope)"
    } else {
        Write-Warn "Could not register in Claude Code — run manually: claude mcp add xray node `"$stdioPath`" --scope user"
    }
} else {
    Write-Warn "Claude Code CLI not found — skipping. If you install it later, run: claude mcp add xray node `"$stdioPath`" --scope user"
}

# ── Done ──────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  Setup complete." -ForegroundColor Green
Write-Host "  - Restart Claude Desktop to load the Xray tools there." -ForegroundColor Green
Write-Host "  - Start a new Claude Code session to use the Xray tools there." -ForegroundColor Green
Write-Host ""
