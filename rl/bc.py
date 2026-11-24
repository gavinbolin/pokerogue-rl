"""Behaviour cloning on human run logs, then evaluation in the sim.

  python -m rl.bc                                   # train on runs/human, eval 20 seeds vs random (6 servers)
  python -m rl.bc --epochs 50 --eval-episodes 0     # train only
  python -m rl.bc --data runs/human runs/other --ports 8800,8801   # more data dirs; reuse running servers

Saves runs/models/bc-<timestamp>.pt (runs/ is gitignored).
"""

from __future__ import annotations

import argparse
import json
import time
from collections import Counter

import numpy as np
import torch
import torch.nn.functional as F

from . import RUNS
from .data import load as load_data
from .policy import MaskedPolicy, save


def train(data, epochs=40, lr=1e-3, batch=64, val_frac=0.15, hidden=256, layers=2, seed=0, device=None, log=print):
    device = device or ("cuda" if torch.cuda.is_available() else "cpu")
    g = np.random.default_rng(seed)
    torch.manual_seed(seed)
    n = len(data)
    # hold out whole runs when there are several, else a random slice of decisions
    runs = np.unique(data.run)
    if len(runs) >= 4:
        val_runs = g.choice(runs, max(1, int(len(runs) * val_frac)), replace=False)
        val = np.isin(data.run, val_runs)
    else:
        val = np.zeros(n, bool)
        val[g.choice(n, max(1, int(n * val_frac)), replace=False)] = True
    tr = ~val
    O = torch.as_tensor(data.obs, device=device)
    M = torch.as_tensor(data.mask, device=device)
    A = torch.as_tensor(data.act, device=device)
    model = MaskedPolicy(hidden=hidden, layers=layers).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    tri, vai = np.flatnonzero(tr), np.flatnonzero(val)
    hist = []

    def acc_on(idx):
        model.eval()
        with torch.no_grad():
            lg = model(O[idx], M[idx])
            loss = F.cross_entropy(lg, A[idx]).item()
            acc = (lg.argmax(-1) == A[idx]).float().mean().item()
        model.train()
        return loss, acc

    # chance accuracy = mean 1/legal-count (what a uniform-random picker would score)
    chance = float((1.0 / data.mask[vai].sum(1)).mean()) if len(vai) else float("nan")
    t0 = time.time()
    for ep in range(1, epochs + 1):
        perm = g.permutation(tri)
        tot = 0.0
        for k in range(0, len(perm), batch):
            b = perm[k : k + batch]
            loss = F.cross_entropy(model(O[b], M[b]), A[b], label_smoothing=0.05)
            opt.zero_grad()
            loss.backward()
            opt.step()
            tot += loss.item() * len(b)
        if ep == 1 or ep % max(1, epochs // 8) == 0 or ep == epochs:
            tl, ta = acc_on(tri)
            vl, va = acc_on(vai)
            hist.append(dict(epoch=ep, train_loss=tl, train_acc=ta, val_loss=vl, val_acc=va))
            log(f"[bc] epoch {ep:3d}  train loss {tl:.3f} acc {ta:.2f} | val loss {vl:.3f} acc {va:.2f} (chance {chance:.2f})")
    log(f"[bc] trained {epochs} epochs on {len(tri)} samples ({len(vai)} val) in {time.time() - t0:.1f} s on {device}")
    return model.eval(), {"history": hist, "chance_val_acc": chance, "n_train": len(tri), "n_val": len(vai), "device": device}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", nargs="*", help="run dirs or globs (default runs/human)")
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--hidden", type=int, default=256)
    ap.add_argument("--layers", type=int, default=2)
    ap.add_argument("--eval-episodes", type=int, default=20)
    ap.add_argument("--seed-base", type=int, default=9000)
    ap.add_argument("--servers", type=int, default=6)
    ap.add_argument("--ports")
    ap.add_argument("--max-episode-seconds", type=float, default=600, help="eval: cut an episode after this long")
    ap.add_argument("--out")
    a = ap.parse_args()

    data = load_data(a.data)
    print(f"[bc] {len(data)} samples from {len(data.runs)} run(s) {data.runs}; kinds {dict(Counter(data.kinds))}; skipped {data.skipped}")
    if len(data) < 10:
        raise SystemExit("not enough samples; play some runs first (Play.bat)")
    model, meta = train(data, epochs=a.epochs, lr=a.lr, hidden=a.hidden, layers=a.layers)
    out = a.out or str(RUNS / "models" / f"bc-{time.strftime('%Y%m%d-%H%M%S')}.pt")
    (RUNS / "models").mkdir(parents=True, exist_ok=True)
    save(model, out, {"meta": meta, "runs": data.runs})
    print(f"[bc] saved {out}")

    if a.eval_episodes > 0:
        from .env import make_vec_env
        from .evaluate import evaluate, fmt, model_policy, random_policy
        from .servers import servers_or_ports

        ports, pool = servers_or_ports(a.servers, a.ports)
        try:
            vec = make_vec_env(ports, max_episode_seconds=a.max_episode_seconds)
            torch.manual_seed(a.seed_base)
            try:
                res = {}
                for name, fn in [("bc greedy", model_policy(model, greedy=True)),
                                 ("bc sample", model_policy(model, greedy=False)),
                                 ("random", random_policy(a.seed_base))]:
                    res[name] = evaluate(vec, fn, a.eval_episodes, a.seed_base)
                    print(fmt(name, res[name]), flush=True)
            finally:
                vec.close()
        finally:
            if pool:
                pool.stop()
        summ = {k: {kk: v[kk] for kk in ("episodes", "mean_waves", "median_waves", "max_waves", "ends", "steps_per_s")} for k, v in res.items()}
        with open(out.replace(".pt", ".eval.json"), "w") as f:
            json.dump({"seed_base": a.seed_base, "results": summ, "per_seed": {k: v["per_seed"] for k, v in res.items()}}, f, indent=1)


if __name__ == "__main__":
    main()
