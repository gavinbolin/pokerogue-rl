"""Python side of pokerogue-rl: sim-server client, server launcher, Gymnasium env, BC tooling.

Run modules from the repo root with the project venv, e.g. `.venv\\Scripts\\python -m rl.bc`.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUNS = ROOT / "runs"
