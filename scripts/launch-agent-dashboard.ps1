param(
  [int]$Port = 9999
)

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$server = Join-Path $repo "dashboard\server.cjs"

if (-not (Test-Path $server)) {
  throw "Cannot find dashboard server at $server"
}

function Test-DashboardReady {
  param(
    [int]$CheckPort
  )

  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$CheckPort/api/state" -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Get-AppBrowser {
  $candidates = @(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
  )

  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      return $candidate
    }
  }

  return $null
}

$env:AGENT_DASHBOARD_PORT = "$Port"
$env:AGENT_DASHBOARD_REPO = $repo

if (-not (Test-DashboardReady -CheckPort $Port)) {
  Start-Process -FilePath "node" -ArgumentList "dashboard\server.cjs" -WorkingDirectory $repo -WindowStyle Hidden
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 250
    if (Test-DashboardReady -CheckPort $Port) {
      break
    }
  }
}

if (-not (Test-DashboardReady -CheckPort $Port)) {
  throw "Control Tower did not start on port $Port"
}

$browser = Get-AppBrowser

if ($browser) {
  Start-Process -FilePath $browser -ArgumentList "--app=http://127.0.0.1:$Port/?theme=light"
} else {
  Start-Process "http://127.0.0.1:$Port/?theme=light"
}
