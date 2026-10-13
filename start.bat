@echo off
REM Double-click launcher for WP Site Builder. No terminal interaction needed.
cd /D "%~dp0"
title WP Site Builder

REM An instance left running from last time holds port 5174, and the server then
REM dies instantly with EADDRINUSE. Without this check the window closed before
REM anyone could read the error, which looks exactly like "it will not run".
netstat -ano | findstr /R /C:"127.0.0.1:5174 .*LISTENING" >nul
if not errorlevel 1 (
  echo WP Site Builder is already running.
  echo.
  echo Opening http://127.0.0.1:5174 in your browser.
  echo If you meant to restart it, close the other WP Site Builder window first,
  echo or run stop.bat and try again.
  start "" "http://127.0.0.1:5174"
  echo.
  pause
  goto end
)

if not exist "node_modules\" (
  echo Installing dependencies, one moment...
  call npm install || goto failed
)

if not exist "dist\ui\index.html" (
  echo Building the interface, one moment...
  call npm run ui:build || goto failed
)

echo Starting WP Site Builder... your browser will open shortly.
echo Keep this window open. Closing it stops the server.
echo.
node server\index.ts
if errorlevel 1 goto failed
goto end

:failed
echo.
echo ---------------------------------------------------------------
echo Startup failed. The message above says why.
echo ---------------------------------------------------------------
echo.
pause

:end
