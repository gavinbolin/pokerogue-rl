"""Which slots a checkpoint picks, per decision kind, plus Run% / Fight% of battle commands.

  python -m rl.action_stats runs/models/ppo-<ts>/best.pt 10 [--base-port 9300]
Plays seeds 9000.. (sampled policy) on one own sim server (ports 9300+ by default, clear of a trainer's 8800+).
"""
import argparse
from collections import Counter, defaultdict

from rl.env import BALL_SLOTS, FIGHT_SLOTS, RUN_SLOT, PokeRogueEnv
from rl.policy import load

ap = argparse.ArgumentParser()
ap.add_argument("ckpt")
ap.add_argument("episodes", type=int, nargs="?", default=3)
ap.add_argument("--base-port", type=int, default=9300)
ap.add_argument("--seed-base", type=int, default=9000)
a = ap.parse_args()
m = load(a.ckpt, "cpu")
env = PokeRogueEnv(None, base_seed=a.seed_base, base_port=a.base_port, max_wave_decisions=300)
by = defaultdict(Counter); waves = []
try:
    for e in range(a.episodes):
        o, info = env.reset(seed=a.seed_base) if e == 0 else env.reset()
        done = False
        while not done:
            act = int(m.act(o["obs"][None], o["action_mask"][None], greedy=False)[0])
            if len(env._s2i) > 1:
                by[env._decision.get("kind")][act] += 1
            o, r, term, trunc, info = env.step(act)
            done = term or trunc
        waves.append((info["waves_cleared"], info.get("end"), info["decisions"]))
finally:
    env.close()
print("episodes (waves, end, decisions):", waves)
print("mean waves", sum(w for w, *_ in waves) / len(waves))
for k, c in by.items():
    print(f"{k:<12}", c.most_common(10))
c = by.get("command", Counter()); n = sum(c.values()) or 1
print(f"command decisions {n}: run {100 * c[RUN_SLOT] / n:.1f}%  fight {100 * sum(c[s] for s in FIGHT_SLOTS) / n:.1f}%  "
      f"ball {100 * sum(c[s] for s in BALL_SLOTS) / n:.1f}%  switch {100 * sum(c[s] for s in range(10, 16)) / n:.1f}%")
