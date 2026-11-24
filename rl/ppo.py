"""Masked PPO self-play training in the sim (Endless).

  python -m rl.ppo                                    # new run, 6 own sim servers, runs until stopped
  python -m rl.ppo --resume runs/models/ppo-<ts>/latest.pt
  python -m rl.ppo --init-bc runs/models/bc-XXXX.pt --bc-coef 0.05   # start from a BC model, keep a BC aux loss
  python -m rl.ppo --total-steps 200000 --eval-every 20

Design
  * Actor-critic = rl.policy.MaskedPolicy (shared MLP body, policy head over the 213 fixed slots, value head),
    dropout 0. Illegal slots are masked before softmax, so sampling / log-probs / entropy are over legal slots.
    Checkpoints are plain MaskedPolicy files, so `python -m rl.evaluate --model <ckpt>` works on them.
  * Rollouts: n_envs x n_steps from the Gymnasium vector env (own recycled sim servers, ports 8800+).
    Gymnasium's next-step autoreset means the step after an episode end is a dummy (its action is ignored);
    those transitions are dropped from the loss and from GAE. A truncated episode (limit) bootstraps with the
    value of its last real state; a wipe does not bootstrap.
  * GAE(gamma, lambda), advantage normalisation per minibatch, clipped surrogate + clipped value loss,
    entropy bonus, grad-norm clip, early stop per update on approx-KL > target_kl.
  * Optional BC auxiliary loss: cross-entropy on human decisions (runs/human) each minibatch (--bc-coef).
  * Reward = rl.env.RewardConfig. Defaults here: +1 per wave cleared, +3 per boss wave (every 10th), +10 more per
    multiple of 50; +0.5 per party level gained (EXP proxy, capped at 1.5 per step); +0.5 per foe for a battle won by KO
    (not fled, not caught); +0.5 x party HP kept over such a battle; -0.3 per own faint; -0.001 per decision; -2 for a run
    cut by a limit, and a Python-side per-wave decision cap (300) that ends menu loops early. Fleeing still gets the
    +1 per wave but none of the battle terms. Each component is logged per episode in episodes.csv (r_*, n_*).
  * --init <ckpt> --reset-value --value-warmup N: start from any model, re-initialise the value head and fit it
    for N updates with the policy frozen (use after a reward change).
  * Eval: every --eval-every updates the current policy plays the fixed held-out seeds (default 9000-9049,
    never used for training) sampled and/or greedy; random is measured once on the same seeds at the start.

Outputs
  runs/train/<ts>/  train.log, metrics.csv (per update), eval.csv (per eval), episodes.csv, config.json, pid.txt
  runs/models/ppo-<ts>/  ckpt-<update>.pt every --save-every updates, latest.pt, best.pt (best eval mean)

Stop: create runs/train/<ts>/STOP - Stop-Train.bat does that for every running trainer.
The trainer finishes the current update, saves latest.pt, shuts its sim servers down and exits.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import time
import traceback
from dataclasses import asdict
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from . import RUNS
from .actions import N_ACTIONS
from .encode import OBS_DIM
from .env import COMPONENTS, COUNTERS, RewardConfig, make_vec_env
from .policy import MaskedPolicy

TRAIN_SEED_BASE = 100_000  # training seeds; eval seeds (9000+) are never used for training


def build_model(hidden: int, layers: int, device) -> MaskedPolicy:
    m = MaskedPolicy(OBS_DIM, N_ACTIONS, hidden=hidden, layers=layers, dropout=0.0)
    for mod in m.body:
        if isinstance(mod, nn.Linear):
            nn.init.orthogonal_(mod.weight, np.sqrt(2))
            nn.init.zeros_(mod.bias)
    nn.init.orthogonal_(m.head.weight, 0.01)  # ~uniform over legal slots at the start (= the random baseline)
    nn.init.zeros_(m.head.bias)
    nn.init.orthogonal_(m.value.weight, 1.0)
    nn.init.zeros_(m.value.bias)
    return m.to(device)


def forward(model: MaskedPolicy, obs: torch.Tensor, mask: torch.Tensor):
    h = model.body(obs)
    logits = model.head(h).masked_fill(~mask, -1e9)
    return logits, model.value(h).squeeze(-1)


def masked_entropy(logits: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    logp = F.log_softmax(logits, -1)
    return -(torch.where(mask, logp.exp() * logp, torch.zeros_like(logp))).sum(-1)


class CSVLog:
    def __init__(self, path: Path, fields: list[str]):
        new = not path.exists()
        self.f = open(path, "a", newline="", encoding="utf-8")
        self.w = csv.DictWriter(self.f, fieldnames=fields, extrasaction="ignore")
        if new:
            self.w.writeheader()

    def write(self, row: dict):
        self.w.writerow({k: (f"{v:.5g}" if isinstance(v, float) else v) for k, v in row.items()})
        self.f.flush()


def save_ckpt(path: Path, model, opt, state: dict, args: dict):
    tmp = path.with_suffix(".tmp")
    torch.save({"config": model.config, "state_dict": model.state_dict(), "optimizer": opt.state_dict(),
                "state": state, "args": args, "kind": "ppo"}, tmp)
    os.replace(tmp, path)


def kill_orphan_servers(since: float, log) -> None:
    """After a forced vector-env close, sim servers whose env worker died are orphaned (Windows does not kill
    grandchildren). Kill node `serve.mjs --no-http` processes in our port range (8800-9099) that started after
    this trainer and whose parent process is gone. Servers with a live parent (Play.bat, other tools) are left alone."""
    if os.name != "nt":
        return
    import subprocess
    ps = (
        "$p = Get-CimInstance Win32_Process; $ids = @{}; $p | % { $ids[[int]$_.ProcessId] = 1 }; "
        "$p | ? { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'serve\\.mjs.*--no-http.*--tcp-port (\\d+)' -and "
        "[int]$Matches[1] -ge 8800 -and [int]$Matches[1] -lt 9100 -and -not $ids.ContainsKey([int]$_.ParentProcessId) -and "
        f"$_.CreationDate -gt (Get-Date).AddSeconds(-{int(time.time() - since) + 5}) }} | % {{ $_.ProcessId }}"
    )
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True, timeout=60).stdout
        pids = [int(x) for x in out.split() if x.strip().isdigit()]
        for pid in pids:
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(pid)], capture_output=True)
        if pids:
            log(f"[sim] killed {len(pids)} orphaned sim server(s): {pids}")
    except Exception as e:  # best effort
        log(f"[sim] orphan cleanup failed: {e}")


def close_vec(vec, since: float, log) -> None:
    try:
        vec.close(timeout=90)
    except Exception:
        try:
            vec.close(terminate=True)
        except Exception:
            pass
    kill_orphan_servers(since, log)


def run_eval(vec, model, device, seeds: int, seed_base: int, mode: str, max_seconds: float, log):
    from .evaluate import evaluate, model_policy, random_policy
    if mode == "random":
        fn = random_policy(seed_base)
    else:
        torch.manual_seed(seed_base)
        fn = model_policy(model, greedy=(mode == "greedy"))
    model.eval()
    r = evaluate(vec, fn, seeds, seed_base, max_seconds=max_seconds, progress_s=120)
    model.train()
    log(f"[eval] {mode:<7} mean {r['mean_waves']:.2f} median {r['median_waves']:.1f} max {r['max_waves']} "
        f"past-50 {sum(v['waves'] >= 50 for v in r['per_seed'].values())} "
        f"(n={r['episodes']}, ends {r['ends']}, {r['seconds']:.0f} s)")
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--servers", type=int, default=6, help="parallel envs, each with its own recycled sim server")
    ap.add_argument("--recycle-every", type=int, default=40)
    ap.add_argument("--n-steps", type=int, default=256, help="rollout length per env per update")
    ap.add_argument("--epochs", type=int, default=4)
    ap.add_argument("--minibatch", type=int, default=512)
    ap.add_argument("--lr", type=float, default=2.5e-4)
    ap.add_argument("--gamma", type=float, default=0.997)
    ap.add_argument("--gae-lambda", type=float, default=0.95)
    ap.add_argument("--clip", type=float, default=0.2)
    ap.add_argument("--ent-coef", type=float, default=0.01)
    ap.add_argument("--vf-coef", type=float, default=0.5)
    ap.add_argument("--max-grad-norm", type=float, default=0.5)
    ap.add_argument("--target-kl", type=float, default=0.03)
    ap.add_argument("--hidden", type=int, default=256)
    ap.add_argument("--layers", type=int, default=2)
    # reward shaping (RewardConfig)
    ap.add_argument("--per-wave", type=float, default=1.0)
    ap.add_argument("--boss-bonus", type=float, default=3.0, help="extra per boss wave (every 10th) cleared")
    ap.add_argument("--major-boss-bonus", type=float, default=10.0, help="extra per wave that is a multiple of 50 cleared")
    ap.add_argument("--exp-per-level", type=float, default=0.5, help="per party level gained (EXP proxy)")
    ap.add_argument("--exp-step-cap", type=float, default=1.5)
    ap.add_argument("--win-bonus", type=float, default=0.5, help="per foe when a battle ends without fleeing")
    ap.add_argument("--catch-bonus", type=float, default=0.0, help="when a battle ends with a catch (no KO bonus then)")
    ap.add_argument("--hp-keep", type=float, default=0.5, help="x party HP kept over a won battle (end/start, <= 1)")
    ap.add_argument("--faint-penalty", type=float, default=0.3, help="per own mon that faints")
    ap.add_argument("--wipe-penalty", type=float, default=0.0)
    ap.add_argument("--hp-delta", type=float, default=0.0)
    ap.add_argument("--step-cost", type=float, default=0.001)
    ap.add_argument("--limit-penalty", type=float, default=2.0)
    ap.add_argument("--max-wave-decisions", type=int, default=300, help="cut an episode after this many decisions in one wave (0 = sim's own cap)")
    ap.add_argument("--max-episode-seconds", type=float, default=900)
    # init / aux
    ap.add_argument("--resume", help="ppo checkpoint to continue from (model, optimizer, counters)")
    ap.add_argument("--init-bc", "--init", dest="init_bc", help="start from a BC or PPO model's weights (same hidden/layers); new counters and optimizer")
    ap.add_argument("--reset-value", action="store_true", help="with --init: re-initialise the value head (e.g. after a reward change)")
    ap.add_argument("--value-warmup", type=int, default=0, help="first N updates train only the value head (policy frozen)")
    ap.add_argument("--bc-coef", type=float, default=0.0, help="weight of a BC cross-entropy loss on human decisions")
    ap.add_argument("--bc-data", nargs="*", help="BC data dirs (default runs/human)")
    # schedule
    ap.add_argument("--total-steps", type=int, default=0, help="stop after this many env steps (0 = until STOP)")
    ap.add_argument("--save-every", type=int, default=10)
    ap.add_argument("--eval-every", type=int, default=30, help="updates between evals (0 = never)")
    ap.add_argument("--eval-seeds", type=int, default=50)
    ap.add_argument("--eval-seed-base", type=int, default=9000)
    ap.add_argument("--eval-modes", default="sample", help="comma list of sample,greedy")
    ap.add_argument("--eval-random", action="store_true", default=True)
    ap.add_argument("--no-eval-random", dest="eval_random", action="store_false")
    ap.add_argument("--eval-max-seconds", type=float, default=1200)
    ap.add_argument("--max-restarts", type=int, default=20, help="restart the sim envs after a crash this many times")
    ap.add_argument("--name", help="run name (default timestamp)")
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()

    ts = a.name or time.strftime("%Y%m%d-%H%M%S")
    run_dir = RUNS / "train" / ts
    model_dir = RUNS / "models" / f"ppo-{ts}"
    run_dir.mkdir(parents=True, exist_ok=True)
    model_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "pid.txt").write_text(str(os.getpid()))
    for f in ("STOP", "finished"):
        (run_dir / f).unlink(missing_ok=True)
    logf = open(run_dir / "train.log", "a", encoding="utf-8")

    def log(msg):
        line = f"{time.strftime('%H:%M:%S')} {msg}"
        print(line, flush=True)
        logf.write(line + "\n")
        logf.flush()

    def stop_requested():
        return (run_dir / "STOP").exists()

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    torch.manual_seed(a.seed)
    rng = np.random.default_rng(a.seed)
    reward = RewardConfig(per_wave=a.per_wave, boss_bonus=a.boss_bonus, wipe_penalty=a.wipe_penalty, hp_delta=a.hp_delta,
                          step_cost=a.step_cost, limit_penalty=a.limit_penalty, major_boss_bonus=a.major_boss_bonus,
                          exp_per_level=a.exp_per_level, exp_step_cap=a.exp_step_cap, win_bonus=a.win_bonus, hp_keep=a.hp_keep,
                          faint_penalty=a.faint_penalty, catch_bonus=a.catch_bonus)
    args = vars(a) | {"reward": asdict(reward), "device": str(device), "run_dir": str(run_dir), "model_dir": str(model_dir)}

    model = build_model(a.hidden, a.layers, device)
    opt = torch.optim.Adam(model.parameters(), lr=a.lr, eps=1e-5)
    state = {"update": 0, "global_steps": 0, "episodes": 0, "seed_block": 0, "best_eval": -1.0, "train_seconds": 0.0}
    if a.resume:
        ck = torch.load(a.resume, map_location=device, weights_only=False)
        model.load_state_dict(ck["state_dict"])
        if "optimizer" in ck:
            opt.load_state_dict(ck["optimizer"])
            for g in opt.param_groups:
                g["lr"] = a.lr
        state.update(ck.get("state", {}))
        log(f"[ppo] resumed from {a.resume} at update {state['update']}, {state['global_steps']} steps")
        args["resumed_from"] = a.resume
    elif a.init_bc:
        ck = torch.load(a.init_bc, map_location=device, weights_only=False)
        missing = model.load_state_dict(ck["state_dict"], strict=False)
        if a.reset_value:
            nn.init.orthogonal_(model.value.weight, 1.0)
            nn.init.zeros_(model.value.bias)
        log(f"[ppo] initialised from {a.init_bc} ({missing}){'; value head reset' if a.reset_value else ''}")
    (run_dir / "config.json").write_text(json.dumps(args, indent=1, default=str))

    bc = None
    if a.bc_coef > 0:
        from .data import load as load_data
        d = load_data(a.bc_data)
        if len(d):
            bc = (torch.as_tensor(d.obs, device=device), torch.as_tensor(d.mask, device=device).bool(),
                  torch.as_tensor(d.act, device=device))
            log(f"[ppo] BC aux loss on {len(d)} human decisions from {len(d.runs)} run(s), coef {a.bc_coef}")
        else:
            log("[ppo] --bc-coef given but no human data; BC aux loss off")

    mlog = CSVLog(run_dir / "metrics.csv", ["update", "global_steps", "wall_s", "sps", "episodes", "ep_waves_mean", "ep_waves_max",
                                             "ep_len_mean", "ep_return_mean", "limit_ends", "pg_loss", "v_loss", "entropy", "approx_kl",
                                             "clipfrac", "explained_var", "bc_loss", "epochs_run", "valid_frac", "run_pct", "fight_pct", "warmup"])
    elog = CSVLog(run_dir / "eval.csv", ["update", "global_steps", "wall_s", "mode", "episodes", "mean_waves", "median_waves",
                                          "max_waves", "std_waves", "pass50", "ends", "seconds"])
    eplog = CSVLog(run_dir / "episodes.csv", ["update", "global_steps", "seed", "waves", "decisions", "return", "end"]
                   + [f"r_{k}" for k in COMPONENTS] + [f"n_{k}" for k in COUNTERS])

    n, T = a.servers, a.n_steps
    vec = None
    t_start = time.time()
    restarts = 0
    eval_modes = [m for m in a.eval_modes.split(",") if m]

    def open_vec():
        log(f"[sim] starting {n} sim servers (recycled every {a.recycle_every} episodes; cold start ~25-60 s)")
        return make_vec_env(None, n=n, recycle_every=a.recycle_every, reward=reward, max_episode_seconds=a.max_episode_seconds,
                            max_wave_decisions=a.max_wave_decisions or None)

    def fresh_reset():
        state["seed_block"] += 1
        o, _ = vec.reset(seed=TRAIN_SEED_BASE + 10_000 * state["seed_block"])
        return o

    def do_eval():
        for mode in eval_modes:
            r = run_eval(vec, model, device, a.eval_seeds, a.eval_seed_base, mode, a.eval_max_seconds, log)
            elog.write({"update": state["update"], "global_steps": state["global_steps"], "wall_s": time.time() - t_start, "mode": mode,
                        **{k: r[k] for k in ("episodes", "mean_waves", "median_waves", "max_waves", "std_waves", "seconds")},
                        "pass50": sum(v["waves"] >= 50 for v in r["per_seed"].values()),
                        "ends": json.dumps(r["ends"])})
            if mode == eval_modes[0] and r["mean_waves"] > state["best_eval"]:
                state["best_eval"] = r["mean_waves"]
                save_ckpt(model_dir / "best.pt", model, opt, state, args)
                log(f"[eval] new best {r['mean_waves']:.2f} -> {model_dir / 'best.pt'}")

    # rollout buffers
    obs_b = torch.zeros((T, n, OBS_DIM), device=device)
    mask_b = torch.zeros((T, n, N_ACTIONS), dtype=torch.bool, device=device)
    act_b = torch.zeros((T, n), dtype=torch.long, device=device)
    logp_b = torch.zeros((T, n), device=device)
    val_b = torch.zeros((T, n), device=device)
    rew_b = np.zeros((T, n), dtype=np.float32)
    term_b = np.zeros((T, n), dtype=bool)  # wipe: no bootstrap
    trunc_b = np.zeros((T, n), dtype=bool)  # limit: bootstrap with own value
    valid_b = np.zeros((T, n), dtype=bool)

    ep_ret = np.zeros(n)
    recent = []  # finished training episodes since the last metrics line
    log(f"[ppo] run {ts} on {device}; {n} envs x {T} steps = {n * T} per update; logs {run_dir}; checkpoints {model_dir}")

    try:
        while True:
            if stop_requested():
                log("[ppo] STOP file found; stopping")
                break
            if a.total_steps and state["global_steps"] >= a.total_steps:
                log(f"[ppo] reached --total-steps {a.total_steps}")
                break
            try:
                if vec is None:
                    vec = open_vec()
                    if a.eval_random and state["update"] == 0 and not (run_dir / "random_done").exists() and a.eval_every:
                        r = run_eval(vec, model, device, a.eval_seeds, a.eval_seed_base, "random", a.eval_max_seconds, log)
                        elog.write({"update": 0, "global_steps": 0, "wall_s": time.time() - t_start, "mode": "random",
                                    **{k: r[k] for k in ("episodes", "mean_waves", "median_waves", "max_waves", "std_waves", "seconds")},
                        "pass50": sum(v["waves"] >= 50 for v in r["per_seed"].values()),
                                    "ends": json.dumps(r["ends"])})
                        (run_dir / "random_done").write_text("1")
                        if state["update"] == 0:
                            do_eval()  # untrained policy (~uniform) on the same seeds
                    obs = fresh_reset()
                    prev_done = np.ones(n, dtype=bool)  # first step after a reset may be an ignored autoreset step
                    ep_ret[:] = 0

                # ---------------- rollout ----------------
                t0 = time.time()
                model.eval()
                for t in range(T):
                    o = torch.as_tensor(obs["obs"], dtype=torch.float32, device=device)
                    m = torch.as_tensor(obs["action_mask"], device=device).bool()
                    with torch.no_grad():
                        logits, v = forward(model, o, m)
                        dist = torch.distributions.Categorical(logits=logits)
                        act = dist.sample()
                        logp = dist.log_prob(act)
                    obs_b[t], mask_b[t], act_b[t], logp_b[t], val_b[t] = o, m, act, logp, v
                    valid_b[t] = ~prev_done
                    obs, r, term, trunc, info = vec.step(act.cpu().numpy())
                    r = np.where(prev_done, 0.0, r)
                    rew_b[t], term_b[t], trunc_b[t] = r, term & ~prev_done, trunc & ~prev_done
                    ep_ret += r
                    done = (term | trunc) & ~prev_done
                    for i in np.flatnonzero(done):
                        end = str(info["end"][i]) if "end" in info and info.get("_end", np.ones(n, bool))[i] else "?"
                        e = {"seed": int(info["seed"][i]), "waves": int(info["waves_cleared"][i]), "decisions": int(info["decisions"][i]),
                             "return": float(ep_ret[i]), "end": end}
                        for k in [f"r_{c}" for c in COMPONENTS] + [f"n_{c}" for c in COUNTERS]:
                            if k in info and info.get("_" + k, np.ones(n, bool))[i]:
                                e[k] = round(float(info[k][i]), 3)
                        recent.append(e)
                        eplog.write({"update": state["update"] + 1, "global_steps": state["global_steps"] + t * n, **e})
                        ep_ret[i] = 0
                        state["episodes"] += 1
                    prev_done = done
                last_obs, last_prev_done = obs, prev_done
                t_roll = time.time() - t0
            except Exception:
                restarts += 1
                log(f"[ppo] sim/env error (restart {restarts}/{a.max_restarts}):\n{traceback.format_exc()}")
                save_ckpt(model_dir / "latest.pt", model, opt, state, args)
                if vec is not None:
                    close_vec(vec, t_start, log)
                vec = None
                if restarts > a.max_restarts:
                    raise
                time.sleep(10)
                continue

            # ---------------- GAE ----------------
            with torch.no_grad():
                o = torch.as_tensor(last_obs["obs"], dtype=torch.float32, device=device)
                m = torch.as_tensor(last_obs["action_mask"], device=device).bool()
                _, v_last = forward(model, o, m)
            vals = val_b.cpu().numpy()
            v_last = v_last.cpu().numpy()
            adv = np.zeros((T, n), dtype=np.float32)
            for i in range(n):
                gae, next_v = 0.0, (0.0 if last_prev_done[i] else v_last[i])
                for t in reversed(range(T)):
                    if not valid_b[t, i]:
                        gae, next_v = 0.0, 0.0
                        continue
                    if term_b[t, i]:
                        delta, gae = rew_b[t, i] - vals[t, i], 0.0
                    elif trunc_b[t, i]:
                        delta, gae = rew_b[t, i] + a.gamma * vals[t, i] - vals[t, i], 0.0
                    else:
                        delta = rew_b[t, i] + a.gamma * next_v - vals[t, i]
                    gae = delta + a.gamma * a.gae_lambda * gae
                    adv[t, i] = gae
                    next_v = vals[t, i]
            ret = adv + vals
            vi = np.flatnonzero(valid_b.reshape(-1))
            B_obs, B_mask = obs_b.reshape(T * n, -1)[vi], mask_b.reshape(T * n, -1)[vi]
            B_act, B_logp, B_val = act_b.reshape(-1)[vi], logp_b.reshape(-1)[vi], val_b.reshape(-1)[vi]
            B_adv = torch.as_tensor(adv.reshape(-1)[vi], device=device)
            B_ret = torch.as_tensor(ret.reshape(-1)[vi], device=device)

            # ---------------- PPO update ----------------
            model.train()
            N = len(vi)
            warm = state["update"] < a.value_warmup
            stats = {"pg_loss": [], "v_loss": [], "entropy": [], "approx_kl": [], "clipfrac": [], "bc_loss": []}
            epochs_run = 0
            for ep in range(a.epochs):
                perm = torch.randperm(N, device=device)
                kls = []
                for k in range(0, N, a.minibatch):
                    mb = perm[k : k + a.minibatch]
                    if warm:  # value head only, on frozen features; the policy does not move
                        with torch.no_grad():
                            h = model.body(B_obs[mb])
                            logits = model.head(h).masked_fill(~B_mask[mb], -1e9)
                        v = model.value(h).squeeze(-1)
                    else:
                        logits, v = forward(model, B_obs[mb], B_mask[mb])
                    logp_all = F.log_softmax(logits, -1)
                    newlogp = logp_all.gather(1, B_act[mb, None]).squeeze(1)
                    ratio = (newlogp - B_logp[mb]).exp()
                    madv = B_adv[mb]
                    madv = (madv - madv.mean()) / (madv.std() + 1e-8) if len(mb) > 1 else madv
                    pg = torch.max(-madv * ratio, -madv * ratio.clamp(1 - a.clip, 1 + a.clip)).mean()
                    v_clip = B_val[mb] + (v - B_val[mb]).clamp(-a.clip * 5, a.clip * 5)
                    vl = 0.5 * torch.max((v - B_ret[mb]) ** 2, (v_clip - B_ret[mb]) ** 2).mean()
                    ent = masked_entropy(logits, B_mask[mb]).mean()
                    loss = a.vf_coef * vl if warm else pg + a.vf_coef * vl - a.ent_coef * ent
                    if bc is not None and not warm:
                        bi = torch.randint(0, len(bc[2]), (min(a.minibatch, len(bc[2])),), device=device)
                        bl, _ = forward(model, bc[0][bi], bc[1][bi])
                        bcl = F.cross_entropy(bl, bc[2][bi])
                        loss = loss + a.bc_coef * bcl
                        stats["bc_loss"].append(bcl.item())
                    opt.zero_grad()
                    loss.backward()
                    nn.utils.clip_grad_norm_(model.parameters(), a.max_grad_norm)
                    opt.step()
                    with torch.no_grad():
                        lr_ = newlogp - B_logp[mb]
                        kl = ((lr_.exp() - 1) - lr_).mean().item()
                    kls.append(kl)
                    stats["pg_loss"].append(pg.item()); stats["v_loss"].append(vl.item()); stats["entropy"].append(ent.item())
                    stats["approx_kl"].append(kl); stats["clipfrac"].append(((ratio - 1).abs() > a.clip).float().mean().item())
                epochs_run += 1
                if a.target_kl and np.mean(kls) > a.target_kl:
                    break
            yv, yp = B_ret.cpu().numpy(), B_val.cpu().numpy()
            ev = float(1 - np.var(yv - yp) / np.var(yv)) if np.var(yv) > 0 else float("nan")

            state["update"] += 1
            state["global_steps"] += T * n
            wall = time.time() - t_start
            row = {"update": state["update"], "global_steps": state["global_steps"], "wall_s": wall, "sps": T * n / t_roll,
                   "episodes": len(recent), "explained_var": ev, "epochs_run": epochs_run, "valid_frac": N / (T * n), "warmup": int(warm),
                   **{k: (float(np.mean(v)) if v else float("nan")) for k, v in stats.items()}}
            if recent:
                w = [e["waves"] for e in recent]
                row.update(ep_waves_mean=float(np.mean(w)), ep_waves_max=max(w), ep_len_mean=float(np.mean([e["decisions"] for e in recent])),
                           ep_return_mean=float(np.mean([e["return"] for e in recent])),
                           limit_ends=sum(1 for e in recent if e["end"] not in ("wipe", "?")))
                cmd = sum(e.get("n_cmd", 0) for e in recent)
                if cmd:
                    row.update(run_pct=100 * sum(e.get("n_run", 0) for e in recent) / cmd, fight_pct=100 * sum(e.get("n_fight", 0) for e in recent) / cmd)
            mlog.write(row)
            log(f"[ppo] upd {state['update']:4d} steps {state['global_steps']:8d} sps {row['sps']:5.0f} | eps {len(recent):2d} "
                f"waves {row.get('ep_waves_mean', float('nan')):5.2f} (max {row.get('ep_waves_max', '-')}) limits {row.get('limit_ends', 0)} | "
                f"pg {row['pg_loss']:+.3f} v {row['v_loss']:.3f} ent {row['entropy']:.2f} kl {row['approx_kl']:.4f} "
                f"clip {row['clipfrac']:.2f} ev {ev:.2f} ep {epochs_run} | run {row.get('run_pct', float('nan')):.0f}% fight {row.get('fight_pct', float('nan')):.0f}%"
                f"{' (value warmup)' if warm else ''}")
            recent = []

            if state["update"] % a.save_every == 0:
                save_ckpt(model_dir / f"ckpt-{state['update']:05d}.pt", model, opt, state, args)
            save_ckpt(model_dir / "latest.pt", model, opt, state, args)
            if a.eval_every and state["update"] % a.eval_every == 0:
                try:
                    do_eval()
                    obs = fresh_reset()
                    prev_done = np.ones(n, dtype=bool)
                    ep_ret[:] = 0
                except Exception:
                    log(f"[eval] failed:\n{traceback.format_exc()}")
                    close_vec(vec, t_start, log)
                    vec = None
            else:
                obs, prev_done = last_obs, last_prev_done
    finally:
        save_ckpt(model_dir / "latest.pt", model, opt, state, args)
        log(f"[ppo] saved {model_dir / 'latest.pt'} (update {state['update']}, {state['global_steps']} steps); closing sim servers")
        if vec is not None:
            close_vec(vec, t_start, log)
        log("[ppo] done")
        (run_dir / "finished").write_text(time.strftime("%Y-%m-%d %H:%M:%S"))


if __name__ == "__main__":
    main()
