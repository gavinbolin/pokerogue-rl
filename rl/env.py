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
    limit_penalty: float = 0.0  # subtracted when a run is cut by a limit (turn / decision / stall / time / per-wave
    #                             decision cap), not by a wipe or max_waves; discourages menu loops
    # --- battle shaping (all 0 = off). Only uses what the live UI shows (levels, HP, fainted, wave). ---
    major_boss_bonus: float = 0.0  # extra for clearing a wave that is a multiple of 50 (on top of boss_bonus)
    exp_per_level: float = 0.0  # per party level gained (same mon id, between decisions); EXP proxy, see below
    exp_step_cap: float = 1.0  # cap on the level reward in one step
    win_bonus: float = 0.0  # per foe, when a battle ends by KO (not fled, not caught)
    catch_bonus: float = 0.0  # when a battle ends with a catch
    fled_wave_scale: float = 1.0  # x per_wave / boss terms for a wave left by fleeing (1 = waves count the same)
    caught_wave_scale: float = 1.0  # x per_wave / boss terms for a wave ended by a catch
    hp_keep: float = 0.0  # x (party HP fraction at battle end / at battle start, clipped to [0, 1]); won battles only
    faint_penalty: float = 0.0  # per own mon that newly faints (any battle, fled or not)

    @classmethod
    def from_any(cls, x):
        if x is None:
            return cls()
        if isinstance(x, cls):
            return x
        return cls(**x)


RUN_SLOT = 21
FIGHT_SLOTS = set(range(0, 10))  # move:i, tera:i, struggle
BALL_SLOTS = set(range(16, 21))
COMPONENTS = ("wave", "boss", "exp", "win", "hp_keep", "faint", "hp_delta", "step", "wipe", "limit")
COUNTERS = ("cmd", "run", "fight", "ball", "switch", "won", "fled", "caught", "levels")


def party_levels(obs: dict) -> dict:
    return {m.get("id"): m.get("level") or 0 for m in obs.get("party") or [] if m.get("id") is not None}


def party_fainted(obs: dict) -> set:
    return {m.get("id") for m in obs.get("party") or [] if m.get("fainted") or (m.get("hp") or 0) <= 0}


def party_hp_frac(obs: dict) -> float:
    party = obs.get("party") or []
    mhp = sum(max(m.get("maxHp") or 0, 0) for m in party)
    return sum(max(m.get("hp") or 0, 0) for m in party) / mhp if mhp else 0.0


class PokeRogueEnv(gym.Env):
    metadata = {"render_modes": []}

    def __init__(self, port: int | None = None, env_index: int = 0, num_envs: int = 1, base_seed: int = 0, reward=None,
                 max_waves: int | None = None, max_decisions: int = 20000, max_episode_seconds: float | None = None, team=None,
                 max_wave_decisions: int | None = None,
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
        self.max_wave_decisions = max_wave_decisions  # Python-side cap on decisions within one wave (None = sim's own cap)
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
        # gymnasium 1.4 AsyncVectorEnv (shared_memory=False) keeps a stale autoreset flag across vec.reset(), so
        # the first step after a reset can call reset() again; ignore a seedless reset of an unplayed episode
        # instead of skipping a seed.
        if seed is None and getattr(self, "_fresh", None) is not None:
            return self._fresh
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
        self.wave_decisions = 0
        self.t_start = time.time()
        if "decision" not in r:  # ended before any decision (shouldn't happen)
            raise RuntimeError(f"seed {self.sim_seed}: run ended at reset: {r.get('end')}")
        d = r["decision"]
        self.wave = d.get("wave") or 1
        self.cleared = max(self.wave - 1, 0)
        o = d.get("obs") or {}
        self.hp = party_hp_frac(o)
        self.comp = dict.fromkeys(COMPONENTS, 0.0)
        self.cnt = dict.fromkeys(COUNTERS, 0)
        self._levels, self._fainted = party_levels(o), party_fainted(o)
        self._battle_start_hp, self._battle_open, self._last_cmd = self.hp, d.get("kind") != "reward", None
        self._foes = len(o.get("enemies") or [])
        self._outcome_scale = 1.0
        self._fresh = (self._observe(d), self._info({"kind": d.get("kind")}))
        return self._fresh

    def step(self, action):
        self._fresh = None
        a = int(action)
        if a not in self._s2i:
            if self.invalid_action != "random":
                raise ValueError(f"illegal action slot {a} at {self._decision.get('kind')} (legal: {sorted(self._s2i)})")
            a = self._rng.choice(sorted(self._s2i))
        idx = self._s2i[a]
        kind = self._decision.get("kind")
        if kind == "command":
            self.cnt["cmd"] += 1
            self.cnt["run"] += a == RUN_SLOT
            self.cnt["fight"] += a in FIGHT_SLOTS
            self.cnt["ball"] += a in BALL_SLOTS
            self.cnt["switch"] += 10 <= a <= 15
            self._last_cmd = a
        r = self.client.step(idx, expect=self._decision["actions"][idx]["id"])
        self.decisions += 1
        cfg = self.reward_cfg
        comp = dict.fromkeys(COMPONENTS, 0.0)
        comp["step"] = -cfg.step_cost
        if "end" in r:
            end = r["end"] or {}
            cleared = int(end.get("wavesCleared", self.cleared))
            self._wave_reward(self.cleared, cleared, comp)
            self.cleared = cleared
            self.wave = end.get("wave", self.wave)
            cause = str(end.get("cause"))
            terminated = cause == "wipe"
            if terminated:
                comp["wipe"] -= cfg.wipe_penalty
                if cfg.hp_delta:
                    comp["hp_delta"] -= cfg.hp_delta * self.hp
                newly = {i for i in self._levels if i not in self._fainted}  # the rest of the party fell
                comp["faint"] -= cfg.faint_penalty * len(newly)
            else:
                comp["limit"] += cfg.truncation_value
                if not cause.startswith("max_waves"):
                    comp["limit"] -= cfg.limit_penalty
            rew = self._add(comp)
            return self._terminal_obs(), rew, terminated, not terminated, self._info(self._episode_info({"end": cause, "kind": "end"}))
        d = r["decision"]
        o = d.get("obs") or {}
        wave = d.get("wave") or self.wave
        cleared = max(self.cleared, wave - 1)
        prev_cleared = self.cleared
        new_wave = wave != self.wave
        self.wave_decisions = 0 if new_wave else self.wave_decisions + 1
        self.cleared, self.wave = cleared, wave
        hp = party_hp_frac(o)
        if cfg.hp_delta:
            comp["hp_delta"] += cfg.hp_delta * (hp - self.hp)
        # levels gained by mons that were already in the party (EXP proxy: the sim shows level, not the EXP bar)
        levels = party_levels(o)
        gained = sum(max(lv - self._levels[i], 0) for i, lv in levels.items() if i in self._levels)
        self.cnt["levels"] += gained
        comp["exp"] += min(cfg.exp_per_level * gained, cfg.exp_step_cap)
        fainted = party_fainted(o)
        comp["faint"] -= cfg.faint_penalty * len({i for i in fainted - self._fainted if i in self._levels})
        # battle end: the reward screen (won / caught) or a new wave without one (fled, or no rewards)
        if self._battle_open and (d.get("kind") == "reward" or new_wave):
            if self._last_cmd == RUN_SLOT:
                self.cnt["fled"] += 1
                self._outcome_scale = cfg.fled_wave_scale
            elif self._last_cmd in BALL_SLOTS:  # ended by a catch: no KO bonus (else catching becomes the new shortcut)
                self.cnt["caught"] += 1
                comp["win"] += cfg.catch_bonus
                self._outcome_scale = cfg.caught_wave_scale
            else:
                self._outcome_scale = 1.0
                self.cnt["won"] += 1
                comp["win"] += cfg.win_bonus * max(self._foes, 1)
                if cfg.hp_keep and self._battle_start_hp > 0:
                    comp["hp_keep"] += cfg.hp_keep * min(max(hp / self._battle_start_hp, 0.0), 1.0)
            self._battle_open = False
        self._wave_reward(prev_cleared, cleared, comp, self._outcome_scale)
        if new_wave:  # next battle starts
            self._outcome_scale = 1.0
            self._battle_open, self._battle_start_hp, self._last_cmd = True, hp, None
            self._foes = len(o.get("enemies") or [])
        elif self._battle_open:
            self._foes = max(self._foes, len(o.get("enemies") or []))
        self._levels, self._fainted, self.hp = levels, fainted, hp
        info = self._info({"kind": d.get("kind")})
        truncated = False
        if self.decisions >= self.max_decisions:
            truncated, info["end"] = True, f"py_decision_limit:{self.max_decisions}"
        elif self.max_episode_seconds and time.time() - self.t_start > self.max_episode_seconds:
            truncated, info["end"] = True, f"py_time_limit:{self.max_episode_seconds:g}s"
        elif self.max_wave_decisions and self.wave_decisions >= self.max_wave_decisions:
            truncated, info["end"] = True, f"py_wave_decision_limit:{self.max_wave_decisions}"
        if truncated:
            comp["limit"] += cfg.truncation_value - cfg.limit_penalty
            try:
                self.client.call("abandon")
            except Exception:
                pass
        rew = self._add(comp)
        if truncated:
            info = self._episode_info(info)
        return self._observe(d), rew, False, truncated, info

    def _add(self, comp: dict) -> float:
        for k, v in comp.items():
            self.comp[k] += v
        return float(sum(comp.values()))

    def _episode_info(self, info: dict) -> dict:
        """Per-episode reward components (r_<name>) and action / battle counters (n_<name>) on the last step."""
        info.update({f"r_{k}": v for k, v in self.comp.items()})
        info.update({f"n_{k}": v for k, v in self.cnt.items()})
        return info

    def _wave_reward(self, old: int, new: int, comp: dict, scale: float = 1.0) -> None:
        if new <= old:
            return
        cfg = self.reward_cfg
        comp["wave"] += scale * cfg.per_wave * (new - old)
        comp["boss"] += scale * cfg.boss_bonus * sum(1 for w in range(old + 1, new + 1) if w % 10 == 0)
        comp["boss"] += scale * cfg.major_boss_bonus * sum(1 for w in range(old + 1, new + 1) if w % 50 == 0)

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
