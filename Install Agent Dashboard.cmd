@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install Agent Dashboard.ps1"
echo.
pause
