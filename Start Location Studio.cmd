@echo off
rem =====================================================================
rem  Location Studio - quick start (double-click this file to run)
rem
rem  What it does, in order:
rem   1. points the app at the project's .venv Python (pymobiledevice3),
rem      when the venv exists next to this file;
rem   2. launches the packaged build in release\, but only when that build
rem      is at least as new as the sources it was made from - a stale
rem      packaged exe quietly runs code the project has moved on from;
rem   3. otherwise starts the app from source with "npm start";
rem   4. names the startup log if the window never appeared.
rem
rem  Force a path explicitly:
rem      "Start Location Studio.cmd"              newest available build
rem      "Start Location Studio.cmd" dev          from source
rem      "Start Location Studio.cmd" packaged     the release\ build as it is
rem =====================================================================
setlocal
cd /d "%~dp0"

if exist ".venv\Scripts\python.exe" set "LOCATION_STUDIO_PYTHON=%CD%\.venv\Scripts\python.exe"

set "MODE=%~1"

set "PORTABLE="
for %%F in ("release\LocationStudio-*-win-x64.exe") do if exist "%%~fF" set "PORTABLE=%%~fF"

if /i "%MODE%"=="dev" goto :fromsource
if not defined PORTABLE goto :fromsource
if /i "%MODE%"=="packaged" goto :launch

rem Compare the packaged build's timestamp with the newest source file.
set "STALE=0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$src = Get-ChildItem -Path electron,renderer,bridge -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in '.cjs','.js','.mjs','.html','.css','.py' }; $src += Get-Item -Path package.json; $exe = Get-Item -Path '%PORTABLE%'; $newest = ($src | Measure-Object -Property LastWriteTime -Maximum).Maximum; Write-Host ('  packaged build : ' + $exe.LastWriteTime.ToString('yyyy-MM-dd HH:mm')); Write-Host ('  newest source  : ' + $newest.ToString('yyyy-MM-dd HH:mm')); if ($newest -gt $exe.LastWriteTime) { exit 1 }"
if errorlevel 1 (
  echo NOTE: the build in release\ is older than the sources, so it would run old
  echo       code. Starting from source instead - run "npm run dist" to refresh it.
  echo.
  goto :fromsource
)

:launch
echo Starting the packaged build:
echo     %PORTABLE%
start "" "%PORTABLE%"
goto :report

:fromsource
where npm >nul 2>nul
if errorlevel 1 (
  echo.
  echo Neither a usable packaged build in release\ nor npm on PATH was found.
  echo Build the app first:
  echo     npm install
  echo     npm run dist
  echo.
  pause
  exit /b 1
)
echo Starting from source with "npm start".
call npm start

:report
echo.
echo If no window appeared, another instance already owns this profile and this
echo start created none. The reason is written to the startup log:
echo     %APPDATA%\Location Studio\logs\location-studio.log
echo Close that instance to free it.
endlocal
