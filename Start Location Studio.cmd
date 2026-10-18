@echo off
rem =====================================================================
rem  Location Studio - quick start (double-click this file to run)
rem
rem  What it does, in order:
rem   1. points the app at the project's .venv Python (pymobiledevice3),
rem      when the venv exists next to this file;
rem   2. launches the packaged build in release\ (portable exe), if built;
rem   3. otherwise starts the app from source with "npm start".
rem =====================================================================
setlocal
cd /d "%~dp0"

if exist ".venv\Scripts\python.exe" set "LOCATION_STUDIO_PYTHON=%CD%\.venv\Scripts\python.exe"

set "PORTABLE="
for %%F in ("release\LocationStudio-*-win-x64.exe") do if exist "%%~fF" set "PORTABLE=%%~fF"

if defined PORTABLE (
  start "" "%PORTABLE%"
  exit /b 0
)

where npm >nul 2>nul
if errorlevel 1 (
  echo.
  echo Neither a packaged build in release\ nor npm on PATH was found.
  echo Build the app first:
  echo     npm install
  echo     npm run dist
  echo.
  pause
  exit /b 1
)

call npm start
