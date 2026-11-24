@echo off
rem Self-play PPO training in the sim (6 headless sim servers on ports 8800+; never touches Play.bat's 8765/8766).
rem   Train.bat                                         new run
rem   Train.bat --resume runs\models\ppo-<ts>\latest.pt  continue a run
rem Logs: runs\train\<ts>\ (train.log, metrics.csv, eval.csv). Checkpoints: runs\models\ppo-<ts>\.
rem Stop: Stop-Train.bat (or Ctrl+C here). Either way latest.pt is saved.
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  echo Python env missing - running Setup-Python.bat first
  call Setup-Python.bat
)
.venv\Scripts\python.exe -m rl.ppo %*
pause
