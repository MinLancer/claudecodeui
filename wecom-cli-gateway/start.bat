@echo off
REM ============================================================
REM  WeCom CLI Gateway launcher (Windows) - double-click to run
REM  Calls start.ps1 to start claudecodeui server(3001) + gateway(3002)
REM ============================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
echo.
pause
