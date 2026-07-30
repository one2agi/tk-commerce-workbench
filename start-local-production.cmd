@echo off
setlocal
cd /d "%~dp0"

where wsl.exe >nul 2>nul
if errorlevel 1 (
  echo [error] wsl.exe not found. Please run: node scripts\start-local-production.mjs
  pause
  exit /b 1
)

for /f "usebackq delims=" %%i in (`wsl.exe wslpath -a "%CD%"`) do set "WSL_REPO=%%i"
echo [start] TK Commerce Workbench local production
echo [repo] %WSL_REPO%
wsl.exe bash -lc "cd '%WSL_REPO%' && node scripts/start-local-production.mjs"

echo.
echo [done] Press any key to close this window.
pause >nul
