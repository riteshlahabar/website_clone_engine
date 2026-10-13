@echo off
REM Stops a WP Site Builder server that is still holding port 5174 — usually one
REM whose window was lost rather than closed. Closing the start.bat window is the
REM normal way to stop it; this is the escape hatch when that window is gone.
cd /D "%~dp0"
title Stop WP Site Builder

set "FOUND="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:"127.0.0.1:5174 .*LISTENING"') do (
  set "FOUND=1"
  echo Stopping WP Site Builder ^(process %%P^)...
  taskkill /PID %%P /F >nul 2>&1
)

if not defined FOUND (
  echo WP Site Builder is not running — nothing on port 5174.
) else (
  echo Stopped. You can run start.bat again now.
)

echo.
pause
