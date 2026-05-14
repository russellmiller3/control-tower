param(
  [int]$Port = 9999
)

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$server = Join-Path $repo "dashboard\server.cjs"
$launcher = Join-Path $repo "scripts\launch-control-tower.ps1"
$icon = Join-Path $repo "dashboard\assets\control-tower.ico"
$desktop = [Environment]::GetFolderPath("Desktop")
$taskbar = Join-Path $env:APPDATA "Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"
$shortcutPath = Join-Path $desktop "Control Tower.lnk"
$taskbarShortcutPath = Join-Path $taskbar "Control Tower.lnk"
$legacyDesktopShortcut = Join-Path $desktop "Agent Dashboard.lnk"
$legacyTaskbarShortcut = Join-Path $taskbar "Agent Dashboard.lnk"

if (-not (Test-Path $server)) {
  throw "Cannot find dashboard server at $server"
}

if (-not (Test-Path $launcher)) {
  throw "Cannot find dashboard launcher at $launcher"
}

if (-not (Test-Path $icon)) {
  throw "Cannot find Control Tower icon at $icon"
}

function Write-ControlTowerShortcut {
  param(
    [string]$DestinationPath
  )

  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($DestinationPath)
  $shortcut.TargetPath = "powershell.exe"
  $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`" -Port $Port"
  $shortcut.WorkingDirectory = $repo
  $shortcut.Description = "Launch Control Tower"
  $shortcut.IconLocation = $icon
  $shortcut.Save()
}

function Try-PinControlTower {
  param(
    [string]$ShortcutToPin
  )

  try {
    $shellApp = New-Object -ComObject Shell.Application
    $folder = $shellApp.Namespace((Split-Path $ShortcutToPin))
    $item = $folder.ParseName((Split-Path $ShortcutToPin -Leaf))
    if (-not $item) {
      return $false
    }

    $verb = @($item.Verbs()) | Where-Object {
      ($_.Name -replace "&", "").Trim() -match "^Pin to taskbar$"
    } | Select-Object -First 1

    if (-not $verb) {
      return $false
    }

    $verb.DoIt()
    Start-Sleep -Milliseconds 700
    return $true
  } catch {
    return $false
  }
}

foreach ($legacy in @($legacyDesktopShortcut, $legacyTaskbarShortcut)) {
  if (Test-Path $legacy) {
    Remove-Item $legacy -Force
  }
}

New-Item -ItemType Directory -Force -Path $taskbar | Out-Null
Write-ControlTowerShortcut -DestinationPath $shortcutPath
$pinned = Try-PinControlTower -ShortcutToPin $shortcutPath
Write-ControlTowerShortcut -DestinationPath $taskbarShortcutPath

try {
  Start-Process -FilePath (Join-Path $env:SystemRoot "System32\ie4uinit.exe") -ArgumentList "-show" -WindowStyle Hidden
} catch {
}

Write-Host "Created Control Tower shortcut: $shortcutPath"
if ($pinned) {
  Write-Host "Pinned Control Tower to the taskbar."
} else {
  Write-Host "Updated Control Tower in the taskbar pinned folder: $taskbarShortcutPath"
}
