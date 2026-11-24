"""Observation encoder: decision JSON (server response `decision` or log `d` record) -> fixed float32 vector.

It only reads what the sim exposes, which is limited to what the live UI shows (README: own party in full;
enemy species / level / HP fraction / status / types / boss bars / stat stages; field; money; items; the
current prompt's legal options with their descriptions and prices). Type effectiveness is computed from
visible types with the standard chart, like the game's move-name tint hints.

Layout (ENCODER.dim floats, ENCODER.blocks has the offsets):
  global   wave features, turn, double, money, battle type, biome, weather, terrain, balls, global items
           (hashed bag), terasUsed, lockRarities, decision kind / sub / stage, acting slot, the move being
           learned or targeted, number of legal actions
  party    6 x mon: present, level, HP%, max HP, status, types, stats, stat stages, on-field, fainted, tera,
           tera type, held items (hashed bag), worst incoming type multiplier from each foe, 4 x move
           (type, category, power, accuracy, PP, effectiveness vs each foe, STAB)
  enemies  2 x foe: present, level, HP fraction, status, types, boss, segments, stat stages, shiny, tera
  options  18 x reward/shop card: tier, item type (hashed), price relative to money, log price
Unknown names hash into buckets (crc32), so new items / biomes never break the shape.
"""

from __future__ import annotations

import math
import zlib

import numpy as np

TYPES = ["NORMAL", "FIGHTING", "FLYING", "POISON", "GROUND", "ROCK", "BUG", "GHOST", "STEEL",
         "FIRE", "WATER", "GRASS", "ELECTRIC", "PSYCHIC", "ICE", "DRAGON", "DARK", "FAIRY"]
TI = {t: i for i, t in enumerate(TYPES)}
_CHART = {  # attacker: ({2x}, {0.5x}, {0x})
    "NORMAL": ((), ("ROCK", "STEEL"), ("GHOST",)),
    "FIGHTING": (("NORMAL", "ROCK", "STEEL", "ICE", "DARK"), ("FLYING", "POISON", "BUG", "PSYCHIC", "FAIRY"), ("GHOST",)),
    "FLYING": (("FIGHTING", "BUG", "GRASS"), ("ROCK", "STEEL", "ELECTRIC"), ()),
    "POISON": (("GRASS", "FAIRY"), ("POISON", "GROUND", "ROCK", "GHOST"), ("STEEL",)),
    "GROUND": (("POISON", "ROCK", "STEEL", "FIRE", "ELECTRIC"), ("BUG", "GRASS"), ("FLYING",)),
    "ROCK": (("FLYING", "BUG", "FIRE", "ICE"), ("FIGHTING", "GROUND", "STEEL"), ()),
    "BUG": (("GRASS", "PSYCHIC", "DARK"), ("FIGHTING", "FLYING", "POISON", "GHOST", "STEEL", "FIRE", "FAIRY"), ()),
    "GHOST": (("GHOST", "PSYCHIC"), ("DARK",), ("NORMAL",)),
    "STEEL": (("ROCK", "ICE", "FAIRY"), ("STEEL", "FIRE", "WATER", "ELECTRIC"), ()),
    "FIRE": (("BUG", "STEEL", "GRASS", "ICE"), ("ROCK", "FIRE", "WATER", "DRAGON"), ()),
    "WATER": (("GROUND", "ROCK", "FIRE"), ("WATER", "GRASS", "DRAGON"), ()),
    "GRASS": (("GROUND", "ROCK", "WATER"), ("FLYING", "POISON", "BUG", "STEEL", "FIRE", "GRASS", "DRAGON"), ()),
    "ELECTRIC": (("FLYING", "WATER"), ("GRASS", "ELECTRIC", "DRAGON"), ("GROUND",)),
    "PSYCHIC": (("FIGHTING", "POISON"), ("STEEL", "PSYCHIC"), ("DARK",)),
    "ICE": (("FLYING", "GROUND", "GRASS", "DRAGON"), ("STEEL", "FIRE", "WATER", "ICE"), ()),
    "DRAGON": (("DRAGON",), ("STEEL",), ("FAIRY",)),
    "DARK": (("GHOST", "PSYCHIC"), ("FIGHTING", "DARK", "FAIRY"), ()),
    "FAIRY": (("FIGHTING", "DRAGON", "DARK"), ("POISON", "STEEL", "FIRE"), ()),
}
CHART = np.ones((18, 18), dtype=np.float32)
for _a, (_s, _n, _z) in _CHART.items():
    for _d in _s:
        CHART[TI[_a], TI[_d]] = 2.0
    for _d in _n:
        CHART[TI[_a], TI[_d]] = 0.5
    for _d in _z:
        CHART[TI[_a], TI[_d]] = 0.0


def effectiveness(atk: str, defs: list[str]) -> float:
    a = TI.get(atk)
    if a is None:
        return 1.0
    m = 1.0
    for d in defs:
        j = TI.get(d)
        if j is not None:
            m *= float(CHART[a, j])
    return m


def _eff_feat(m: float) -> float:
    """log2 multiplier scaled to about [-1, 1]; immunity -> -1.5."""
    return -1.5 if m == 0 else math.log2(m) / 2.0


STATUSES = ["POISON", "TOXIC", "PARALYSIS", "SLEEP", "FREEZE", "BURN", "FAINT"]
BATTLE_TYPES = ["WILD", "TRAINER", "CLEAR", "MYSTERY_ENCOUNTER", "NONE"]
BIOMES = ["TOWN", "PLAINS", "GRASS", "TALL_GRASS", "METROPOLIS", "FOREST", "SEA", "SWAMP", "BEACH", "LAKE",
          "SEABED", "MOUNTAIN", "BADLANDS", "CAVE", "DESERT", "ICE_CAVE", "MEADOW", "POWER_PLANT", "VOLCANO",
          "GRAVEYARD", "DOJO", "FACTORY", "RUINS", "WASTELAND", "ABYSS", "SPACE", "CONSTRUCTION_SITE", "JUNGLE",
          "FAIRY_CAVE", "TEMPLE", "SLUM", "SNOWY_FOREST", "ISLAND", "LABORATORY", "END"]
KINDS = ["command", "target", "reward", "party", "learn_move", "catch_full", "biome", "option"]
STAGES = ["from", "item", "qty", "to", "confirm"]
N_GLOBAL_ITEMS, N_HELD, N_SUB, N_OPT_TYPE = 48, 16, 16, 24
N_OPTS = 18  # 8 reward + 10 shop cards


def h(s: str, n: int) -> int:
    return zlib.crc32(s.encode("utf-8")) % n


class Writer:
    __slots__ = ("v", "i")

    def __init__(self, v: np.ndarray, i: int):
        self.v, self.i = v, i

    def f(self, x: float):
        self.v[self.i] = x
        self.i += 1

    def onehot(self, idx: int | None, n: int):
        if idx is not None and 0 <= idx < n:
            self.v[self.i + idx] = 1.0
        self.i += n

    def types(self, ts):
        for t in ts or ():
            j = TI.get(t)
            if j is not None:
                self.v[self.i + j] = 1.0
        self.i += 18

    def bag(self, items, n: int):
        for it in items or ():
            self.v[self.i + h(str(it.get("name")), n)] += math.log1p(it.get("count", 1))
        self.i += n

    def skip(self, n: int):
        self.i += n


MOVE_DIM = 1 + 18 + 3 + 1 + 1 + 1 + 1 + 1 + 2 + 1 + 1
MON_DIM = 1 + 1 + 1 + 1 + 7 + 18 + 6 + 7 + 3 + 18 + N_HELD + 2 + 4 * MOVE_DIM
FOE_DIM = 1 + 1 + 1 + 7 + 18 + 1 + 1 + 1 + 7 + 1 + 1
CTX_MOVE_DIM = 1 + 18 + 3 + 1 + 1 + 2
GLOBAL_DIM = (5 + 1 + 1 + 1 + len(BATTLE_TYPES) + len(BIOMES) + 1 + 10 + 6 + 5 + N_GLOBAL_ITEMS + 2
              + len(KINDS) + 1 + N_SUB + len(STAGES) + 6 + 2 + CTX_MOVE_DIM + 1)
OPT_DIM = 6 + N_OPT_TYPE + 2


class ObsEncoder:
    def __init__(self):
        self.blocks = {}
        off = 0
        for name, size in [("global", GLOBAL_DIM), ("party", 6 * MON_DIM), ("enemies", 2 * FOE_DIM), ("options", N_OPTS * OPT_DIM)]:
            self.blocks[name] = (off, off + size)
            off += size
        self.dim = off

    def zeros(self) -> np.ndarray:
        return np.zeros(self.dim, dtype=np.float32)

    def encode(self, d: dict) -> np.ndarray:
        v = self.zeros()
        o = d.get("obs") or {}
        ctx = d.get("context") or {}
        party = o.get("party") or []
        foes = o.get("enemies") or []
        foe_types = [f.get("types") or [] for f in foes[:2]]
        actions = d.get("actions") or []

        w = Writer(v, 0)
        wave = int(o.get("wave") or d.get("wave") or 0)
        w.f(wave / 100.0); w.f(math.log1p(wave) / 7.0); w.f((wave % 10) / 10.0)
        w.f(1.0 if wave and wave % 10 == 0 else 0.0); w.f(1.0 if wave and wave % 50 == 0 else 0.0)
        w.f(min(float(o.get("turn") or 0), 30.0) / 30.0)
        w.f(1.0 if o.get("double") else 0.0)
        money = float(o.get("money") or 0)
        w.f(math.log1p(money) / 12.0)
        w.onehot(BATTLE_TYPES.index(o["battleType"]) if o.get("battleType") in BATTLE_TYPES else None, len(BATTLE_TYPES))
        b = o.get("biome")
        w.onehot(BIOMES.index(b) if b in BIOMES else None, len(BIOMES))
        w.f(1.0 if b and b not in BIOMES else 0.0)
        w.onehot(h(o["weatherName"], 10) if o.get("weatherName") else None, 10)
        w.onehot(h(o["terrainName"], 6) if o.get("terrainName") else None, 6)
        balls = o.get("balls") or {}
        for k in range(5):
            w.f(math.log1p(float(balls.get(str(k), 0) or 0)) / 4.0)
        w.bag(o.get("items"), N_GLOBAL_ITEMS)
        w.f(float(o.get("terasUsed") or 0)); w.f(1.0 if o.get("lockRarities") else 0.0)
        kind = d.get("kind")
        w.onehot(KINDS.index(kind) if kind in KINDS else None, len(KINDS))
        w.f(1.0 if kind not in KINDS else 0.0)
        w.onehot(h(str(d.get("sub")), N_SUB) if d.get("sub") else None, N_SUB)
        st = ctx.get("stage")
        w.onehot(STAGES.index(st) if st in STAGES else None, len(STAGES))
        slot = ctx.get("slot") if kind in ("command", "learn_move") else None
        w.onehot(slot if isinstance(slot, int) else None, 6)
        fi = ctx.get("fieldIndex")
        w.onehot(fi if isinstance(fi, int) else None, 2)
        # move being learned (learn_move context) or targeted (target context, looked up in the party)
        cm = None
        if kind == "learn_move" and "type" in ctx:
            t = ctx.get("type")
            cm = {"type": TYPES[t] if isinstance(t, int) and 0 <= t < 18 else t, "category": ctx.get("category"),
                  "power": ctx.get("power"), "accuracy": ctx.get("accuracy")}
        elif ctx.get("moveId") is not None:
            for m in party:
                for mv in m.get("moves") or ():
                    if mv.get("id") == ctx["moveId"]:
                        cm = mv
                        break
                if cm:
                    break
        if cm:
            w.f(1.0); w.onehot(TI.get(cm.get("type")), 18); w.onehot(cm.get("category"), 3)
            p, a = cm.get("power") or -1, cm.get("accuracy") or -1
            w.f(max(p, 0) / 150.0); w.f(1.0 if a < 0 else a / 100.0)
            for k in range(2):
                w.f(_eff_feat(effectiveness(cm.get("type"), foe_types[k])) if k < len(foe_types) else 0.0)
        else:
            w.skip(CTX_MOVE_DIM)
        w.f(min(len(actions), 30) / 30.0)
        assert w.i == self.blocks["global"][1], (w.i, self.blocks["global"])

        for s in range(6):
            m = party[s] if s < len(party) else None
            if not m:
                w.skip(MON_DIM)
                continue
            self._mon(w, m, foe_types)
        for k in range(2):
            f = foes[k] if k < len(foes) else None
            if not f:
                w.skip(FOE_DIM)
                continue
            w.f(1.0); w.f((f.get("level") or 0) / 100.0); w.f(float(f.get("hpFrac") or 0))
            w.onehot(STATUSES.index(f["status"]) if f.get("status") in STATUSES else None, 7)
            w.types(f.get("types")); w.f(1.0 if f.get("boss") else 0.0)
            w.f((f.get("bossSegments") or 0) / 5.0); w.f((f.get("bossSegmentIndex") or 0) / 5.0)
            ss = f.get("statStages") or []
            for j in range(7):
                w.f((ss[j] if j < len(ss) else 0) / 6.0)
            w.f(1.0 if f.get("shiny") else 0.0); w.f(1.0 if f.get("tera") else 0.0)
        assert w.i == self.blocks["enemies"][1]

        # reward / shop cards (visible on the reward screen with tier colour, name and price)
        base = self.blocks["options"][0]
        for a in actions:
            aid = a.get("id", "")
            if aid.startswith("reward:"):
                k = int(aid[7:])
            elif aid.startswith("shop:"):
                k = 8 + int(aid[5:])
            else:
                continue
            if not (0 <= k < N_OPTS) or (aid.startswith("reward:") and k >= 8):
                continue
            data = a.get("data") or {}
            ow = Writer(v, base + k * OPT_DIM)
            tier = data.get("tier")
            ow.onehot(tier if isinstance(tier, int) else 5, 6)
            ow.onehot(h(str(data.get("typeId") or a.get("label")), N_OPT_TYPE), N_OPT_TYPE)
            cost = float(data.get("cost") or 0)
            ow.f(min(cost / max(money, 1.0), 2.0)); ow.f(math.log1p(cost) / 10.0)
        return v

    def _mon(self, w: Writer, m: dict, foe_types: list):
        hp, mhp = float(m.get("hp") or 0), float(m.get("maxHp") or 1)
        w.f(1.0); w.f((m.get("level") or 0) / 100.0); w.f(hp / max(mhp, 1.0)); w.f(mhp / 500.0)
        w.onehot(STATUSES.index(m["status"]) if m.get("status") in STATUSES else None, 7)
        types = m.get("types") or []
        w.types(types)
        stats = m.get("stats") or []
        for j in range(6):
            w.f((stats[j] if j < len(stats) else 0) / 300.0)
        ss = m.get("statStages") or []
        for j in range(7):
            w.f((ss[j] if j < len(ss) else 0) / 6.0)
        w.f(1.0 if m.get("onField") else 0.0); w.f(1.0 if m.get("fainted") else 0.0); w.f(1.0 if m.get("tera") else 0.0)
        w.onehot(TI.get(m.get("teraType")), 18)
        w.bag(m.get("items"), N_HELD)
        for k in range(2):  # worst incoming STAB multiplier from foe k's visible types
            if k < len(foe_types) and foe_types[k]:
                w.f(_eff_feat(max(effectiveness(t, types) for t in foe_types[k])))
            else:
                w.f(0.0)
        moves = m.get("moves") or []
        for j in range(4):
            mv = moves[j] if j < len(moves) else None
            if not mv:
                w.skip(MOVE_DIM)
                continue
            t = mv.get("type")
            w.f(1.0); w.onehot(TI.get(t), 18); w.onehot(mv.get("category"), 3)
            p, a = mv.get("power") or -1, mv.get("accuracy") or -1
            w.f(max(p, 0) / 150.0); w.f(1.0 if a < 0 else a / 100.0); w.f(1.0 if a < 0 else 0.0)
            pp, ppm = float(mv.get("pp") or 0), float(mv.get("ppMax") or 1)
            w.f(pp / max(ppm, 1.0)); w.f(ppm / 40.0)
            for k in range(2):
                w.f(_eff_feat(effectiveness(t, foe_types[k])) if k < len(foe_types) and mv.get("category") != 2 else 0.0)
            w.f(1.0 if t in types else 0.0)
            w.f(1.0 if pp <= 0 else 0.0)


ENCODER = ObsEncoder()
OBS_DIM = ENCODER.dim
