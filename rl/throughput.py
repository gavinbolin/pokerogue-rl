"""Throughput check: random policy through the vector env over N sim servers.

  python -m rl.throughput --servers 6 --seconds 60 [--sync] [--ports 8800,...]
"""

from __future__ import annotations

import argparse
import time

import numpy as np

from .env import make_vec_env
from .policy import random_actions
from .servers import servers_or_ports


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--servers", type=int, default=6)
    ap.add_argument("--ports")
    ap.add_argument("--seconds", type=float, default=60)
    ap.add_argument("--sync", action="store_true", help="SyncVectorEnv (one Python process) instead of Async")
    a = ap.parse_args()
    t0 = time.time()
    ports, pool = servers_or_ports(a.servers, a.ports)
    try:
        vec = make_vec_env(ports, asynchronous=not a.sync)
        try:
            rng = np.random.default_rng(0)
            obs, _ = vec.reset(seed=50000)
            for _ in range(20):  # warm-up
                obs, *_ = vec.step(random_actions(obs["action_mask"], rng))
            steps = eps = waves = 0
            t1 = time.time()
            while time.time() - t1 < a.seconds:
                obs, r, term, trunc, info = vec.step(random_actions(obs["action_mask"], rng))
                steps += len(r)
                done = term | trunc
                eps += int(done.sum())
                waves += float(r.sum())  # default reward = 1 per wave cleared
            dt = time.time() - t1
            print(f"[throughput] {len(ports)} servers ({'sync' if a.sync else 'async'}): {steps / dt:.0f} decisions/s, "
                  f"{waves / dt:.1f} waves/s, {eps} episodes finished in {dt:.0f} s (startup {t1 - t0:.0f} s)")
        finally:
            vec.close()
    finally:
        if pool:
            pool.stop()


if __name__ == "__main__":
    main()
