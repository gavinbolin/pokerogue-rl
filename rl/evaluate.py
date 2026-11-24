"""Play N seeds through the vector env with a policy and report waves cleared.

  python -m rl.evaluate --random --episodes 20                 # random baseline (starts 6 servers)
  python -m rl.evaluate --model runs/models/bc-XXXX.pt --episodes 20 [--sample]
  add --ports 8800,8801,... to reuse servers you already started (python -m rl.servers)
"""

from __future__ import annotations

import argparse
import time

import numpy as np

from .env import make_vec_env
from .policy import random_actions


def evaluate(vec, policy_fn, episodes: int, seed: int, max_seconds: float = 1800.0) -> dict:
    """policy_fn(obs_batch, mask_batch) -> actions. Plays seeds seed..seed+episodes-1 once each."""
    obs, info = vec.reset(seed=seed)
    want = set(range(seed, seed + episodes))
    results = {}
    steps, t0 = 0, time.time()
    while want - results.keys():
        acts = policy_fn(obs["obs"], obs["action_mask"])
        obs, rew, term, trunc, info = vec.step(acts)
        steps += len(acts)
        for i in np.flatnonzero(term | trunc):
            s = int(info["seed"][i])
            if s in want and s not in results:
                results[s] = {"waves": int(info["waves_cleared"][i]), "end": str(info["end"][i]) if "end" in info else "?",
                              "decisions": int(info["decisions"][i])}
        if time.time() - t0 > max_seconds:
            print(f"[eval] time limit hit with {len(results)}/{episodes} episodes")
            break
    w = np.array([r["waves"] for r in results.values()], dtype=float)
    dt = time.time() - t0
    return {"episodes": len(results), "mean_waves": float(w.mean()) if len(w) else float("nan"),
            "median_waves": float(np.median(w)) if len(w) else float("nan"), "max_waves": int(w.max()) if len(w) else 0,
            "std_waves": float(w.std()) if len(w) else float("nan"),
            "ends": {e: sum(1 for r in results.values() if r["end"] == e) for e in {r["end"] for r in results.values()}},
            "steps": steps, "seconds": dt, "steps_per_s": steps / dt, "per_seed": dict(sorted(results.items()))}


def fmt(name: str, r: dict) -> str:
    return (f"{name:<14} mean {r['mean_waves']:.2f}  median {r['median_waves']:.1f}  max {r['max_waves']}  "
            f"(n={r['episodes']}, ends {r['ends']}, {r['steps_per_s']:.0f} steps/s)")


def random_policy(seed: int = 0):
    rng = np.random.default_rng(seed)
    return lambda o, m: random_actions(m, rng)


def model_policy(model, greedy=True, temperature=1.0):
    return lambda o, m: model.act(o, m, greedy=greedy, temperature=temperature)


def main():
    from .servers import servers_or_ports

    ap = argparse.ArgumentParser()
    ap.add_argument("--model")
    ap.add_argument("--random", action="store_true")
    ap.add_argument("--sample", action="store_true", help="sample from the policy instead of argmax")
    ap.add_argument("--episodes", type=int, default=20)
    ap.add_argument("--seed-base", type=int, default=9000)
    ap.add_argument("--servers", type=int, default=6)
    ap.add_argument("--ports")
    ap.add_argument("--max-waves", type=int)
    a = ap.parse_args()
    ports, pool = servers_or_ports(a.servers, a.ports)
    try:
        vec = make_vec_env(ports, max_waves=a.max_waves)
        try:
            if a.model:
                import torch

                from .policy import load
                dev = "cuda" if torch.cuda.is_available() else "cpu"
                r = evaluate(vec, model_policy(load(a.model, dev), greedy=not a.sample), a.episodes, a.seed_base)
                print(fmt("model", r))
            if a.random or not a.model:
                r = evaluate(vec, random_policy(a.seed_base), a.episodes, a.seed_base)
                print(fmt("random", r))
        finally:
            vec.close()
    finally:
        if pool:
            pool.stop()


if __name__ == "__main__":
    main()
