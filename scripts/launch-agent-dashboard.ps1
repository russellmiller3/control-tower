param(
  [int]$Port = 9999
)

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$server = Join-Path $repo "dashboard\server.cjs"

if (-not (Test-Path $server)) {
  throw "Cannot find dashboard server at $server"
}

$env:AGENT_DASHBOARD_PORT = "$Port"
$env:AGENT_DASHBOARD_REPO = $repo

Start-Process -FilePath "node" -ArgumentList "dashboard\server.cjs" -WorkingDirectory $repo -WindowStyle Hidden
Start-Sleep -Seconds 1
Start-Process "http://127.0.0.1:$Port"
