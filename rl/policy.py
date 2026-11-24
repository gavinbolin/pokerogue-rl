"""Small masked policy net and helpers."""

from __future__ import annotations

import numpy as np
import torch
import torch.nn as nn

from .actions import N_ACTIONS
from .encode import OBS_DIM


class MaskedPolicy(nn.Module):
    """MLP: obs -> logits over the fixed slots; illegal slots get -inf before softmax / argmax."""

    def __init__(self, obs_dim: int = OBS_DIM, n_actions: int = N_ACTIONS, hidden: int = 256, layers: int = 2, dropout: float = 0.1):
        super().__init__()
        mods, d = [], obs_dim
        for _ in range(layers):
            mods += [nn.Linear(d, hidden), nn.LayerNorm(hidden), nn.ReLU(), nn.Dropout(dropout)]
            d = hidden
        self.body = nn.Sequential(*mods)
        self.head = nn.Linear(d, n_actions)
        self.value = nn.Linear(d, 1)  # unused by BC; there for PPO later
        self.config = dict(obs_dim=obs_dim, n_actions=n_actions, hidden=hidden, layers=layers, dropout=dropout)

    def forward(self, obs: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
        logits = self.head(self.body(obs))
        return logits.masked_fill(~mask.bool(), torch.finfo(logits.dtype).min)

    @torch.no_grad()
    def act(self, obs: np.ndarray, mask: np.ndarray, greedy: bool = True, temperature: float = 1.0) -> np.ndarray:
        dev = next(self.parameters()).device
        o = torch.as_tensor(obs, dtype=torch.float32, device=dev)
        m = torch.as_tensor(mask, device=dev).bool()
        logits = self.forward(o, m)
        if greedy:
            return logits.argmax(-1).cpu().numpy()
        return torch.distributions.Categorical(logits=logits / temperature).sample().cpu().numpy()


def save(model: MaskedPolicy, path, extra: dict | None = None):
    torch.save({"config": model.config, "state_dict": model.state_dict(), **(extra or {})}, path)


def load(path, device="cpu") -> MaskedPolicy:
    ck = torch.load(path, map_location=device, weights_only=False)
    m = MaskedPolicy(**ck["config"])
    m.load_state_dict(ck["state_dict"])
    return m.to(device).eval()


def random_actions(mask: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Uniform over legal slots per row (same as the sim's random policy over legal actions)."""
    out = np.empty(len(mask), dtype=np.int64)
    for i, row in enumerate(mask):
        legal = np.flatnonzero(row)
        out[i] = rng.choice(legal)
    return out
