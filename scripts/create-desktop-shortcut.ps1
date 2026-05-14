param(
  [int]$Port = 9999
)

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$server = Join-Path $repo "dashboard\server.cjs"
$launcher = Join-Path $repo "scripts\launch-agent-dashboard.ps1"
$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "Agent Dashboard.lnk"

if (-not (Test-Path $server)) {
  throw "Cannot find dashboard server at $server"
}

if (-not (Test-Path $launcher)) {
  throw "Cannot find dashboard launcher at $launcher"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "powershell.exe"
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`" -Port $Port"
$shortcut.WorkingDirectory = $repo
$shortcut.Description = "Launch Agent Dashboard"
$shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,220"
$shortcut.Save()

Write-Host "Created Agent Dashboard shortcut: $shortcutPath"
