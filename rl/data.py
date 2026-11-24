"""Behaviour-cloning dataset: run logs (jsonl) -> (obs vector, action mask, chosen slot) samples.

Reads every `runs/<dir>/*.jsonl` given (default runs/human). Uses `d` records that carry obs and the
full legal list (logged with obs on), skips forced (n <= 1) decisions, and drops a decision that the
game then refused (`rej` record right after it). Runs are filtered by the `start` record's policy
(default: human only).
"""

from __future__ import annotations

import glob
import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import RUNS
from .actions import N_ACTIONS, ActionMapper
from .encode import ENCODER


@dataclass
class BCData:
    obs: np.ndarray  # (N, OBS_DIM) float32
    mask: np.ndarray  # (N, N_ACTIONS) bool
    act: np.ndarray  # (N,) int64 slot
    run: np.ndarray  # (N,) int run index
    kinds: list = field(default_factory=list)
    runs: list = field(default_factory=list)
    skipped: dict = field(default_factory=dict)

    def __len__(self):
        return len(self.act)


def iter_files(paths: list[str] | None) -> list[Path]:
    paths = paths or [str(RUNS / "human")]
    out = []
    for p in paths:
        pp = Path(p)
        if pp.is_dir():
            out += sorted(pp.glob("*.jsonl"))
        else:
            out += [Path(x) for x in sorted(glob.glob(p))]
    return [f for f in out if f.name != "summary.jsonl"]


def load(paths: list[str] | None = None, policies=("human",)) -> BCData:
    mapper = ActionMapper()
    obs, masks, acts, runs, kinds, run_names = [], [], [], [], [], []
    skipped = {"no_obs": 0, "forced": 0, "rejected": 0, "unmapped": 0, "policy": 0}
    for f in iter_files(paths):
        recs = [json.loads(l) for l in f.read_text(encoding="utf-8").splitlines() if l.strip()]
        start = next((r for r in recs if r.get("t") == "start"), {})
        if policies and start.get("policy") not in policies:
            skipped["policy"] += 1
            continue
        ri = len(run_names)
        run_names.append(f.stem)
        for j, r in enumerate(recs):
            if r.get("t") != "d":
                continue
            if "obs" not in r or "actions" not in r:
                skipped["no_obs"] += 1
                continue
            if len(r["actions"]) <= 1:
                skipped["forced"] += 1
                continue
            if j + 1 < len(recs) and recs[j + 1].get("t") == "rej":
                skipped["rejected"] += 1
                continue
            mask, _, i2s = mapper.map(r["actions"])
            slot = i2s[r["chosen"]] if 0 <= r["chosen"] < len(i2s) else None
            if slot is None:
                skipped["unmapped"] += 1
                continue
            obs.append(ENCODER.encode(r))
            masks.append(mask)
            acts.append(slot)
            runs.append(ri)
            kinds.append(r.get("kind"))
    return BCData(
        obs=np.asarray(obs, dtype=np.float32).reshape(-1, ENCODER.dim),
        mask=np.asarray(masks, dtype=bool).reshape(-1, N_ACTIONS),
        act=np.asarray(acts, dtype=np.int64),
        run=np.asarray(runs, dtype=np.int64),
        kinds=kinds,
        runs=run_names,
        skipped={**skipped, **dict(mapper.stats)},
    )
