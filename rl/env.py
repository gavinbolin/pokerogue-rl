"""Gymnasium env over one sim server, plus a vector-env factory over N servers.

Observation: Dict(obs = float32[OBS_DIM] (rl.encode), action_mask = int8[N_ACTIONS] (rl.actions)).
Action: Discrete(N_ACTIONS); the slot must be legal (mask 1), else ValueError (or a random legal slot
with invalid_action="random"). Runs are started with policy "agent" and log=False, so nothing is written
to runs/ (runs/human is only for Play.bat).

Seeds: env k of a vector of n envs plays sim seeds base+k, base+k+n, base+k+2n, ... where base comes from
`reset(seed=...)` (the vector env passes seed+k to env k) or `base_seed`. So `vec.reset(seed=S)` with n envs
covers seeds S, S+1, S+2, ... across envs with no repeats.

Rewards are computed here from the observations (RewardConfig); see its fields.
On termination the returned observation is all zeros with only slot 0 unmasked (a dummy; the next step
of a Gymnasium vector env autoresets and ignores its action).
"""

from __future__ import annotations

import functools
import random
import time
from dataclasses import asdict, dataclass

import gymnasium as gym
import numpy as np

from .actions import N_ACTIONS, ActionMapper
from .client import SimClient
from .encode import ENCODER, OBS_DIM


@dataclass
class RewardConfig:
    per_wave: float = 1.0  # per wave cleared
    boss_bonus: float = 0.0  # extra for clearing a boss wave (every 10th)
    wipe_penalty: float = 0.0  # subtracted when the party wipes
    hp_delta: float = 0.0  # x change in total party HP fraction between decisions
    step_cost: float = 0.0  # subtracted every decision
    truncation_value: float = 0.0  # added when a run is cut (max_waves, turn/decision limit)

    @classmethod
    def from_any(cls, x):
        if x is None:
            return cls()
        if isinstance(x, cls):
            return x
        return cls(**x)


def party_hp_frac(obs: dict) -> float:
    party = obs.get("party") or []
    mhp = sum(max(m.get("maxHp") or 0, 0) for m in party)
    return sum(max(m.get("hp") or 0, 0) for m in party) / mhp if mhp else 0.0


class PokeRogueEnv(gym.Env):
    metadata = {"render_modes": []}

    def __init__(self, port: int | None = None, env_index: int = 0, num_envs: int = 1, base_seed: int = 0, reward=None,
                 max_waves: int | None = None, max_decisions: int = 20000, max_episode_seconds: float | None = None, team=None,
                 invalid_action: str = "raise", connect_retry_s: float = 30.0,
                 base_port: int = 8800, recycle_every: int = 40):
        """port=None: the env starts and owns its own sim server (ports base_port + 50*env_index ...),
        replacing it every `recycle_every` episodes (see servers.RecyclingServer). port=N: use a running server."""
        self.env_index, self.num_envs = env_index, num_envs
        self.server = None
        if port in (8765, 8766):
            raise ValueError("ports 8765/8766 are the Play.bat server; refusing")
        # connect lazily on the first reset (the vector env builds a throwaway copy just to read the spaces)
        self.port, self._base_port, self._recycle_every = port, base_port, recycle_every
        self._connect_retry_s = connect_retry_s
        self.client = None
        self.base = base_seed + env_index
        self.episode = 0
        self.reward_cfg = RewardConfig.from_any(reward)
        self.max_waves, self.max_decisions, self.team = max_waves, max_decisions, team
        self.max_episode_seconds = max_episode_seconds
        self.invalid_action = invalid_action
        self.mapper = ActionMapper()
        self.observation_space = gym.spaces.Dict({
            "obs": gym.spaces.Box(-np.inf, np.inf, (OBS_DIM,), np.float32),
            "action_mask": gym.spaces.Box(0, 1, (N_ACTIONS,), np.int8),
        })
        self.action_space = gym.spaces.Discrete(N_ACTIONS)
        self._rng = random.Random(base_seed * 1000 + env_index)

    # ------------------------------------------------------------------
    def _observe(self, d: dict):
        mask, s2i, _ = self.mapper.map(d["actions"])
        self._decision, self._s2i = d, s2i
        self._mask = np.asarray(mask, dtype=np.int8)
        return {"obs": ENCODER.encode(d), "action_mask": self._mask}

    def _terminal_obs(self):
        m = np.zeros(N_ACTIONS, dtype=np.int8)
        m[0] = 1
        return {"obs": np.zeros(OBS_DIM, dtype=np.float32), "action_mask": m}

    def _info(self, extra=None):
        info = {"seed": self.sim_seed, "wave": self.wave, "waves_cleared": self.cleared, "decisions": self.decisions,
                "seconds": time.time() - self.t_start}
        if extra:
            info.update(extra)
        return info

    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        if seed is not None:
            self.base, self.episode = int(seed), 0
            self._rng.seed(seed)
        if self.client is None:
            if self.port is None:
                from .servers import RecyclingServer
                self.server = RecyclingServer(self._base_port + 50 * self.env_index, self._recycle_every)
                self.port = self.server.port
            self.client = SimClient(self.port, connect_retry_s=self._connect_retry_s)
        elif self.server is not None and self.server.on_reset():
            self.client.close()
            self.port = self.server.port
            self.client = SimClient(self.port, connect_retry_s=30)
        self.sim_seed = self.base + self.episode * self.num_envs
        self.episode += 1
        r = self.client.reset(seed=self.sim_seed, team=self.team, max_waves=self.max_waves)
        self.decisions = 0
        self.t_start = time.time()
        if "decision" not in r:  # ended before any decision (shouldn't happen)
            raise RuntimeError(f"seed {self.sim_seed}: run ended at reset: {r.get('end')}")
        d = r["decision"]
        self.wave = d.get("wave") or 1
        self.cleared = max(self.wave - 1, 0)
        self.hp = party_hp_frac(d.get("obs") or {})
        return self._observe(d), self._info({"kind": d.get("kind")})

    def step(self, action):
        a = int(action)
        if a not in self._s2i:
            if self.invalid_action != "random":
                raise ValueError(f"illegal action slot {a} at {self._decision.get('kind')} (legal: {sorted(self._s2i)})")
            a = self._rng.choice(sorted(self._s2i))
        idx = self._s2i[a]
        r = self.client.step(idx, expect=self._decision["actions"][idx]["id"])
        self.decisions += 1
        cfg = self.reward_cfg
        rew = -cfg.step_cost
        if "end" in r:
            end = r["end"] or {}
            cleared = int(end.get("wavesCleared", self.cleared))
            rew += self._wave_reward(self.cleared, cleared)
            self.cleared = cleared
            self.wave = end.get("wave", self.wave)
            cause = str(end.get("cause"))
            terminated = cause == "wipe"
            if terminated:
                rew -= cfg.wipe_penalty
                if cfg.hp_delta:
                    rew -= cfg.hp_delta * self.hp
            else:
                rew += cfg.truncation_value
            return self._terminal_obs(), rew, terminated, not terminated, self._info({"end": cause, "kind": "end"})
        d = r["decision"]
        wave = d.get("wave") or self.wave
        cleared = max(self.cleared, wave - 1)
        rew += self._wave_reward(self.cleared, cleared)
        self.cleared, self.wave = cleared, wave
        hp = party_hp_frac(d.get("obs") or {})
        if cfg.hp_delta:
            rew += cfg.hp_delta * (hp - self.hp)
        self.hp = hp
        info = self._info({"kind": d.get("kind")})
        truncated = False
        if self.decisions >= self.max_decisions:
            truncated, info["end"] = True, f"py_decision_limit:{self.max_decisions}"
        elif self.max_episode_seconds and time.time() - self.t_start > self.max_episode_seconds:
            truncated, info["end"] = True, f"py_time_limit:{self.max_episode_seconds:g}s"
        if truncated:
            rew += cfg.truncation_value
            try:
                self.client.call("abandon")
            except Exception:
                pass
        return self._observe(d), rew, False, truncated, info

    def _wave_reward(self, old: int, new: int) -> float:
        if new <= old:
            return 0.0
        r = self.reward_cfg.per_wave * (new - old)
        if self.reward_cfg.boss_bonus:
            r += self.reward_cfg.boss_bonus * sum(1 for w in range(old + 1, new + 1) if w % 10 == 0)
        return r

    def action_masks(self):  # sb3-contrib MaskablePPO convention
        return self._mask.astype(bool)

    def close(self):
        if self.client is not None:
            self.client.close()
            self.client = None
        if self.server is not None:
            self.server.stop()
            self.server = None


def make_env(port: int | None, env_index: int = 0, num_envs: int = 1, **kw) -> PokeRogueEnv:
    return PokeRogueEnv(port, env_index=env_index, num_envs=num_envs, **kw)


def make_vec_env(ports: list[int] | None = None, n: int | None = None, asynchronous: bool = True, **kw) -> gym.vector.VectorEnv:
    """One sub-env per sim server. ports=[...]: use running servers. ports=None: n envs that each start and
    recycle their own server (recommended; ports 8800+, cold start ~25-50 s). Async = one worker process per env."""
    if ports is None:
        if not n:
            raise ValueError("give ports or n")
        ports = [None] * n
    n = len(ports)
    fns = [functools.partial(make_env, p, i, n, **kw) for i, p in enumerate(ports)]
    if asynchronous:
        return gym.vector.AsyncVectorEnv(fns, context="spawn", shared_memory=False)
    return gym.vector.SyncVectorEnv(fns)


def reward_config_dict(cfg: RewardConfig) -> dict:
    return asdict(cfg)
