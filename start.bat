@echo off
REM Double-click launcher for WP Site Builder. No terminal interaction needed.
cd /D "%~dp0"
title WP Site Builder

if not exist "node_modules\" (
  echo Installing dependencies, one moment...
  call npm install || goto failed
)

if not exist "dist\ui\index.html" (
  echo Building the interface, one moment...
  call npm run ui:build || goto failed
)

echo Starting WP Site Builder... your browser will open shortly.
node server\index.ts
goto end

:failed
echo.
echo Startup failed. The message above says why.
pause

:end
