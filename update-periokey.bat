@echo off
rem PerioKey: double-click to get the newest version.
cd /d "%~dp0"
git pull --ff-only
if errorlevel 1 ( pause & exit /b 1 )
call npm.cmd install --omit=dev --no-package-lock
if errorlevel 1 ( pause & exit /b 1 )
echo PerioKey is up to date.
pause
