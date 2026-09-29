# Apex CRM one-time setup for Windows PowerShell.
#
# Run from the Apex-CRM folder:
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
#
# It checks Node.js, installs packages, creates .env from .env.example, asks for
# each API key (press Enter to skip or keep the current one), and can start the app.
# Keys are typed hidden and only ever written to your local .env file.

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

function Write-Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }

# 1. Node.js 24 or newer (needed for the built-in SQLite database)
Write-Step 'Checking Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host 'Node.js is not installed. Install the LTS version (24 or newer) from https://nodejs.org, then run this script again.' -ForegroundColor Red
  exit 1
}
$nodeMajor = [int]((node -v).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 24) {
  Write-Host "Node.js $(node -v) is too old. Install version 24 or newer from https://nodejs.org, then run this script again." -ForegroundColor Red
  exit 1
}
Write-Host "Node.js $(node -v) found."

# 2. Packages
Write-Step 'Installing packages (this can take a few minutes the first time)'
npm install
if ($LASTEXITCODE -ne 0) {
  Write-Host 'npm install failed. Check the messages above, then run this script again.' -ForegroundColor Red
  exit 1
}

# 3. .env file
Write-Step 'Preparing .env'
if (-not (Test-Path '.env')) {
  Copy-Item '.env.example' '.env'
  Write-Host 'Created .env from .env.example.'
} else {
  Write-Host 'Found existing .env. Keys you skip below stay as they are.'
}

function Set-EnvValue([string]$name, [string]$value) {
  $lines = [System.Collections.Generic.List[string]](Get-Content '.env')
  $escaped = $value.Replace('"', '\"')
  $newLine = "$name=`"$escaped`""
  $index = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^\s*$([regex]::Escape($name))\s*=") { $index = $i; break }
  }
  if ($index -ge 0) { $lines[$index] = $newLine } else { $lines.Add($newLine) }
  # UTF-8 without a byte-order mark, so dotenv reads the first line correctly.
  [System.IO.File]::WriteAllLines((Join-Path (Get-Location) '.env'), $lines, [System.Text.UTF8Encoding]::new($false))
}

function Read-Key([string]$name, [string]$label) {
  $secure = Read-Host -AsSecureString "$label (paste, then Enter; just Enter to skip)"
  $plain = [System.Net.NetworkCredential]::new('', $secure).Password.Trim()
  if ($plain) {
    Set-EnvValue $name $plain
    Write-Host "  Saved $name." -ForegroundColor Green
    return $true
  }
  Write-Host "  Skipped $name."
  return $false
}

# 4. Keys
Write-Step 'API keys (typing is hidden)'
$hasBrightData = Read-Key 'BRIGHTDATA_API_TOKEN' 'Bright Data API key'
$hasTavily = Read-Key 'TAVILY_API_KEY' 'Tavily API key'
$hasAtria = Read-Key 'ATRIA_API_KEY' 'Atria API key'
if ($hasAtria) { Set-EnvValue 'ATRIA_PRIORITY' 'primary' }
$hasOpenAI = Read-Key 'OPENAI_API_KEY' 'Byesu / OpenAI-compatible API key'
$hasOpenRouter = Read-Key 'OPENROUTER_API_KEY' 'OpenRouter API key (free AI models)'
if ($hasOpenRouter) {
  Set-EnvValue 'OPENROUTER_BASE_URL' 'https://openrouter.ai/api/v1'
  Set-EnvValue 'OPENROUTER_MODEL' 'nvidia/nemotron-3-super-120b-a12b:free'
  Set-EnvValue 'OPENROUTER_PROVIDER_NAME' 'OpenRouter'
}
# Example keys such as "sk-..." count as set and make every AI call try them first, so clear them.
foreach ($name in 'OPENAI_API_KEY', 'BYESU_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY') {
  if ((Get-Content '.env' -Raw) -match "(?m)^\s*$name\s*=\s*`"?[a-z-]*\.\.\.`"?\s*$") { Set-EnvValue $name '' }
}
Set-EnvValue 'DISCOVERY_PROVIDER_MODE' 'hybrid'

# 5. Summary
Write-Step 'Summary'
$envText = Get-Content '.env' -Raw
function Test-Configured($name, $placeholderPattern) {
  return ($envText -match "(?m)^\s*$name\s*=\s*`"?([^`"\r\n]+)") -and ($Matches[1] -notmatch $placeholderPattern)
}
$aiReady = (Test-Configured 'ATRIA_API_KEY' '^$') -or (Test-Configured 'OPENAI_API_KEY' '^sk-\.\.\.$') -or (Test-Configured 'OPENROUTER_API_KEY' '^sk-or-\.\.\.$')
$searchReady = (Test-Configured 'BRIGHTDATA_API_TOKEN' '^MY_BRIGHTDATA') -or (Test-Configured 'TAVILY_API_KEY' '^MY_TAVILY')
Write-Host ("AI key:      " + ($(if ($aiReady) { 'ready' } else { 'MISSING (add OpenRouter, Atria or Byesu/OpenAI)' })))
Write-Host ("Search key:  " + ($(if ($searchReady) { 'ready' } else { 'MISSING (add Bright Data or Tavily)' })))
if (-not ($aiReady -and $searchReady)) {
  Write-Host "`nLead search needs at least one AI key and one search key. Run this script again to add them." -ForegroundColor Yellow
}

# 6. Start
$start = Read-Host "`nStart Apex CRM now? (Y/n)"
if ($start -eq '' -or $start -match '^[Yy]') {
  Write-Host 'Starting... open http://127.0.0.1:3000 in your browser. Press Ctrl+C here to stop.' -ForegroundColor Cyan
  npm run dev
} else {
  Write-Host 'Done. Start the app any time with: npm run dev'
}
