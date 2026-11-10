# Codex Image Gateway launcher (Windows PowerShell 5.1+ and PowerShell 7+ compatible)
#
# Starts scripts/codex-image-gateway.mjs, which reads ~/.codex/auth.json and exposes
# OpenAI-compatible /v1/images/* endpoints locally.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\start-codex-gateway.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\start-codex-gateway.ps1 -Port 8790 -Model gpt-image-2.5-sunburst
param(
  [int]$Port = 8788,
  [string]$Model = 'gpt-image-2.5-flare',
  [string]$GatewayKey = '',
  [switch]$NoProxy
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$gateway = Join-Path $repoRoot 'scripts\codex-image-gateway.mjs'
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $nodeCmd) {
  Write-Host 'ERROR: Node.js not found. Install Node.js 18+ first.' -ForegroundColor Red
  exit 1
}
$node = $nodeCmd.Source
if (-not (Test-Path $gateway)) {
  Write-Host "ERROR: gateway script not found: $gateway" -ForegroundColor Red
  exit 1
}

# Codex CLI credentials (created by `codex login`)
if ($env:CODEX_HOME) { $codexHome = $env:CODEX_HOME } else { $codexHome = Join-Path $env:USERPROFILE '.codex' }
$authPath = Join-Path $codexHome 'auth.json'
if (-not (Test-Path $authPath)) {
  Write-Host "ERROR: Codex credentials not found: $authPath" -ForegroundColor Red
  Write-Host 'Run `codex login` first (or set CODEX_HOME to the directory containing auth.json).' -ForegroundColor Yellow
  exit 1
}

$env:CODEX_IMAGE_GATEWAY_PORT = [string]$Port
$env:CODEX_IMAGE_MODEL = $Model
if ([string]::IsNullOrWhiteSpace($GatewayKey)) {
  Remove-Item Env:CODEX_IMAGE_GATEWAY_KEY -ErrorAction SilentlyContinue
} else {
  $env:CODEX_IMAGE_GATEWAY_KEY = $GatewayKey
}

# Use the Windows system proxy (Clash/V2Ray/etc.) so Node fetch can reach chatgpt.com
if (-not $NoProxy) {
  try {
    $ie = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop
    if ($ie.ProxyEnable -eq 1 -and $ie.ProxyServer) {
      $server = [string]$ie.ProxyServer
      if ($server -match '=') {
        $https = ($server -split ';' | Where-Object { $_ -match '^https=' } | Select-Object -First 1) -replace '^https=', ''
        if (-not $https) {
          $https = ($server -split ';' | Where-Object { $_ -match '^http=' } | Select-Object -First 1) -replace '^http=', ''
        }
        $server = $https
      }
      if ($server) {
        if ($server -notmatch '^[a-z]+://') { $server = 'http://' + $server }
        $env:HTTP_PROXY = $server
        $env:HTTPS_PROXY = $server
        $env:NODE_USE_ENV_PROXY = '1'
        Write-Host "[gateway] system proxy: $server" -ForegroundColor DarkGray
      }
    }
  } catch {
    Write-Host '[gateway] system proxy not detected (set HTTPS_PROXY manually if needed)' -ForegroundColor DarkGray
  }
}

Write-Host "[gateway] credentials: $authPath" -ForegroundColor DarkGray
Write-Host "[gateway] port: $Port   model: $Model" -ForegroundColor DarkGray
Write-Host ''
Write-Host 'Configure AI studio -> API settings -> OpenAI GPT Image:' -ForegroundColor Cyan
Write-Host "  Base URL : http://127.0.0.1:$Port/v1"
if ([string]::IsNullOrWhiteSpace($GatewayKey)) {
  Write-Host '  API Key  : sk-local-codex'
} else {
  Write-Host "  API Key  : $GatewayKey"
}
Write-Host "  Model    : $Model"
Write-Host '  Endpoint : images_edits_json'
Write-Host '  Image pass mode: base64'
Write-Host '  Note: subscription image safety rejects pose/mannequin references; use portrait+costume only.'
Write-Host ''
Write-Host 'Press Ctrl+C to stop the gateway.' -ForegroundColor DarkGray
Write-Host ''

Push-Location $repoRoot
try {
  & $node $gateway
} finally {
  Pop-Location
}
