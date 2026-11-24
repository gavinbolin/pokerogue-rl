"""Throughput check: random policy through the vector env over N sim servers.

  python -m rl.throughput --servers 6 --seconds 60 [--sync] [--ports 8800,...]
"""

from __future__ import annotations

import argparse
import time

import numpy as np

from .env import make_vec_env
from .policy import random_actions


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--servers", type=int, default=6)
    ap.add_argument("--ports", help="use running servers (python -m rl.servers) instead of starting own ones")
    ap.add_argument("--recycle-every", type=int, default=40, help="replace each own sim server after this many episodes (0 = never)")
    ap.add_argument("--seconds", type=float, default=60)
    ap.add_argument("--sync", action="store_true", help="SyncVectorEnv (one Python process) instead of Async")
    a = ap.parse_args()
    t0 = time.time()
    from .servers import parse_ports
    ports, pool = parse_ports(a.ports), None
    if ports is None:
        print(f"[sim] starting {a.servers} sim servers (own, recycled every {a.recycle_every} episodes; cold start ~25-60 s)", flush=True)
    try:
        vec = make_vec_env(ports, n=a.servers, recycle_every=a.recycle_every, asynchronous=not a.sync)
        try:
            rng = np.random.default_rng(0)
            obs, _ = vec.reset(seed=50000)
            for _ in range(20):  # warm-up
                obs, *_ = vec.step(random_actions(obs["action_mask"], rng))
            steps = eps = waves = 0
            t1 = win_t = time.time(); win_steps = 0
            while time.time() - t1 < a.seconds:
                obs, r, term, trunc, info = vec.step(random_actions(obs["action_mask"], rng))
                steps += len(r); win_steps += len(r)
                eps += int((term | trunc).sum())
                waves += float(r.sum())  # default reward = 1 per wave cleared
                if time.time() - win_t >= 60:
                    print(f"[throughput]   {time.time() - t1:4.0f} s: {win_steps / (time.time() - win_t):.0f} decisions/s in the last minute, {eps} episodes", flush=True)
                    win_t, win_steps = time.time(), 0
            dt = time.time() - t1
            print(f"[throughput] {vec.num_envs} servers ({'sync' if a.sync else 'async'}): {steps / dt:.0f} decisions/s, "
                  f"{waves / dt:.1f} waves/s, {eps} episodes finished in {dt:.0f} s (startup {t1 - t0:.0f} s)")
        finally:
            vec.close()
    finally:
        if pool:
            pool.stop()


if __name__ == "__main__":
    main()
