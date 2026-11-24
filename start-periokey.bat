@echo off
rem PerioKey: double-click to start. Right-click, Run as administrator, if Eaglesoft runs as administrator.
rem Each start pulls the newest version from GitHub. If offline, it starts the current version.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js LTS from https://nodejs.org, then run this again.
  pause
  exit /b 1
)
if not exist .git goto install
where git >nul 2>nul
if errorlevel 1 goto install
set GIT_TERMINAL_PROMPT=0
for /f %%i in ('git rev-parse HEAD') do set BEFORE=%%i
git pull --ff-only
if errorlevel 1 echo Offline or update skipped -- starting current version.
for /f %%i in ('git rev-parse HEAD') do set AFTER=%%i
if "%BEFORE%"=="%AFTER%" goto install
git diff --name-only %BEFORE% %AFTER% | findstr /i "package.json" >nul
if not errorlevel 1 call npm.cmd install --omit=dev
:install
if not exist node_modules call npm.cmd install --omit=dev
start "" http://localhost:4317
node src/server.ts
if errorlevel 1 pause
