@echo off
title PokeRogue RL - Play
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js not found on PATH. & pause & exit /b 1)
if not exist "vendor\pokerogue\package.json" (
  echo First run: setting up game checkout...
  call node scripts\setup.mjs || (echo Setup failed. & pause & exit /b 1)
)
echo Starting sim server (about 30 s). The browser opens at http://127.0.0.1:8765/ when ready.
echo Close this window to stop the server.
call npm run play -- --open
pause
