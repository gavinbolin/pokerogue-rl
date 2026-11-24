@echo off
rem Asks every running PPO trainer (runs\train\<ts>\ without a "finished" file) to stop: it finishes the
rem current update, saves runs\models\ppo-<ts>\latest.pt, shuts its sim servers down and exits.
cd /d "%~dp0"
powershell -NoProfile -Command "$n=0; Get-ChildItem runs\train -Directory -ErrorAction SilentlyContinue | ? { (Test-Path (Join-Path $_.FullName 'pid.txt')) -and -not (Test-Path (Join-Path $_.FullName 'finished')) -and (Get-Process -Id (Get-Content (Join-Path $_.FullName 'pid.txt')) -ErrorAction SilentlyContinue) } | %% { New-Item -ItemType File -Force (Join-Path $_.FullName 'STOP') | Out-Null; Write-Host ('stop requested: ' + $_.Name + ' (pid ' + (Get-Content (Join-Path $_.FullName 'pid.txt')) + ')'); $n++ }; if (-not $n) { Write-Host 'no running trainer found' }"
echo It stops after the current update (under a minute; longer if an eval is running).
pause
