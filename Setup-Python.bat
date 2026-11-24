@echo off
rem One-time setup of the Python training env (.venv with CUDA torch). Safe to rerun.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\setup_py.ps1"
pause
