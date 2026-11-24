"""Which slots a checkpoint picks, per decision kind (one own sim server on ports 9300+)."""
import sys
from collections import Counter, defaultdict
import numpy as np, torch
from rl.env import PokeRogueEnv
from rl.policy import load
ck, eps = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 3
m = load(ck, "cpu")
env = PokeRogueEnv(None, base_seed=9000, base_port=9300, max_wave_decisions=300)
by = defaultdict(Counter); waves = []
try:
    for e in range(eps):
        o, info = env.reset(seed=9000 + e) if e == 0 else env.reset()
        done = False
        while not done:
            a = int(m.act(o["obs"][None], o["action_mask"][None], greedy=False)[0])
            kind = env._decision.get("kind")
            legal = len(env._s2i)
            by[kind][(a, legal > 1)] += 1
            o, r, term, trunc, info = env.step(a)
            done = term or trunc
        waves.append((info["waves_cleared"], info.get("end"), info["decisions"]))
finally:
    env.close()
print("episodes", waves)
for k, c in by.items():
    print(k, sorted(((s, n) for (s, choice), n in c.items() if choice), key=lambda x: -x[1])[:10])
