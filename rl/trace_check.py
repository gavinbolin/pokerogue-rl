"""Determinism / slowdown check: same seeds with a seeded random policy, first in a fresh server and again after K other episodes."""
import json, sys, time
import numpy as np
from rl.servers import ServerPool
from rl.env import PokeRogueEnv

def trace(e, seed):
    rng = np.random.default_rng(seed)
    o, i = e.reset(seed=seed); tr = []
    while True:
        legal = np.flatnonzero(o["action_mask"]); a = int(rng.choice(legal))
        tr.append(e._decision["actions"][e._s2i[a]]["id"])
        o, r, te, tru, i = e.step(a)
        if te or tru:
            return tr, i["waves_cleared"]

K = int(sys.argv[1]) if len(sys.argv) > 1 else 60
out = sys.argv[2] if len(sys.argv) > 2 else None
seeds = [4242, 4243, 4244]
with ServerPool(1, base_port=8820) as pool:
    e = PokeRogueEnv(pool.ports[0])
    first = {s: trace(e, s) for s in seeds}
    t = time.time(); n = 0
    for k in range(K):
        tr, w = trace(e, 100000 + k); n += len(tr)
    rate = n / (time.time() - t)
    later = {s: trace(e, s) for s in seeds}
    e.close()
for s in seeds:
    print(s, "first", len(first[s][0]), "dec", first[s][1], "waves | after", K, ":", len(later[s][0]), "dec", later[s][1], "waves | same:", first[s] == later[s])
print(f"filler episodes: {n / max(1, K):.0f} decisions avg, {rate:.0f} decisions/s overall")
if out:
    json.dump({str(s): first[s] for s in seeds}, open(out, "w"))
