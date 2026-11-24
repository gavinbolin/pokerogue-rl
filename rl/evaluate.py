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


def evaluate(vec, policy_fn, episodes: int, seed: int, max_seconds: float = 1800.0, progress_s: float = 60.0) -> dict:
    """policy_fn(obs_batch, mask_batch) -> actions. Plays seeds seed..seed+episodes-1 once each.

    Episodes count when they end (wipe) or are truncated (sim turn/decision limits, max_waves, or the env's
    max_decisions / max_episode_seconds); the truncation cause is in `ends`. Prints the still-running seeds
    every `progress_s` seconds so a stuck or very long episode is visible.
    """
    obs, info = vec.reset(seed=seed)
    want = set(range(seed, seed + episodes))
    results = {}
    steps, t0, last = 0, time.time(), time.time()
    while want - results.keys():
        if time.time() - last > progress_s:
            last = time.time()
            live = [f"{int(info['seed'][i])}:w{int(info['wave'][i])}/d{int(info['decisions'][i])}" for i in range(len(info["seed"]))
                    if int(info["seed"][i]) in want - results.keys()]
            print(f"[eval] {len(results)}/{episodes} done after {last - t0:.0f} s; running {live}", flush=True)
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
    
    ap = argparse.ArgumentParser()
    ap.add_argument("--model")
    ap.add_argument("--random", action="store_true")
    ap.add_argument("--sample", action="store_true", help="sample from the policy instead of argmax")
    ap.add_argument("--episodes", type=int, default=20)
    ap.add_argument("--seed-base", type=int, default=9000)
    ap.add_argument("--servers", type=int, default=6)
    ap.add_argument("--ports", help="use running servers (python -m rl.servers) instead of starting own ones")
    ap.add_argument("--recycle-every", type=int, default=40, help="replace each own sim server after this many episodes (0 = never)")
    ap.add_argument("--max-waves", type=int)
    ap.add_argument("--max-episode-seconds", type=float, default=600)
    a = ap.parse_args()
    from .servers import parse_ports
    ports, pool = parse_ports(a.ports), None
    if ports is None:
        print(f"[sim] starting {a.servers} sim servers (own, recycled every {a.recycle_every} episodes; cold start ~25-60 s)", flush=True)
    try:
        vec = make_vec_env(ports, n=a.servers, recycle_every=a.recycle_every, max_waves=a.max_waves, max_episode_seconds=a.max_episode_seconds)
        try:
            if a.model:
                import torch

                from .policy import load
                dev = "cuda" if torch.cuda.is_available() else "cpu"
                torch.manual_seed(a.seed_base)
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
