@echo off
if /i "%~1"=="--open-browser" (
  timeout /t 3 /nobreak >nul
  start "" "http://127.0.0.1:%~2"
  exit /b
)

setlocal enableextensions
chcp 65001 >nul
title 2AIO Dashboard

set "ROOT=%~dp0"
set "DASHBOARD=%ROOT%dashboard"

if not exist "%DASHBOARD%\server.mjs" (
  echo [error] dashboard\server.mjs not found. Run this file from the repository root.
  pause
  endlocal
  exit /b 1
)

if defined PORT (
  set "DASHBOARD_PORT=%PORT%"
) else (
  set "DASHBOARD_PORT=7801"
)

where node >nul 2>nul
if errorlevel 1 (
  echo [error] Node.js not found in PATH. Install Node.js 20+ and reopen this window.
  pause
  endlocal
  exit /b 1
)

if not exist "%DASHBOARD%\node_modules" (
  echo [setup] Installing dependencies (first run only)...
  pushd "%DASHBOARD%"
  call npm install
  set "INSTALL_EXIT=%ERRORLEVEL%"
  popd
  if not "%INSTALL_EXIT%"=="0" (
    echo [error] npm install failed. See the log above.
    pause
    endlocal
    exit /b 1
  )
)

netstat -ano -p tcp | findstr /R /C:"^[ ]*TCP[ ]*127\.0\.0\.1:%DASHBOARD_PORT%[ ][ ]*.*[ ]LISTENING[ ][ ]*" >nul
if not errorlevel 1 (
  echo [info] Port %DASHBOARD_PORT% is already in use - the dashboard is probably running.
  echo [info] Opening http://127.0.0.1:%DASHBOARD_PORT% instead.
  start "" "http://127.0.0.1:%DASHBOARD_PORT%"
  pause
  endlocal
  exit /b 0
)

start "" /min "%~f0" --open-browser %DASHBOARD_PORT%
echo [2aio] Starting dashboard on http://127.0.0.1:%DASHBOARD_PORT%
echo [2aio] Close this window to stop the server.

pushd "%DASHBOARD%"
node server.mjs
set "SERVER_EXIT=%ERRORLEVEL%"
popd

echo [2aio] Server exited (code %SERVER_EXIT%).
pause
endlocal & exit /b %SERVER_EXIT%
