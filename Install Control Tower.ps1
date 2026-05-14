$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$installer = Join-Path $repo "scripts\install.ps1"
$shortcut = Join-Path $repo "scripts\create-desktop-shortcut.ps1"

Write-Host "Installing Control Tower..."
Write-Host "Repo: $repo"
Write-Host ""

& $installer
Write-Host ""
& $shortcut

Write-Host ""
Write-Host "Done."
Write-Host "Use the Control Tower desktop shortcut or taskbar shortcut, or open http://127.0.0.1:9999 after launching."
