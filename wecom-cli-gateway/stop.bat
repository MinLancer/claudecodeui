@echo off
REM ============================================================
REM  WeCom CLI Gateway stopper (Windows) - double-click to run
REM  Calls stop.ps1 to stop gateway + claudecodeui server
REM ============================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
echo.
pause
