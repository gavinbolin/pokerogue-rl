"""Fixed-size masked action space.

Every sim decision lists its legal actions as ids (README "Decision API"). `ActionMapper` maps each id
to one fixed slot so a policy can output a constant-size logit vector; the mask marks the slots that are
legal at this decision. The decision kind is part of the observation, so slots are shared between kinds
where the meaning is "the same button" (e.g. one "party slot s" group for switch / send-out / item target /
release / transfer from+to / discard from).

Slot layout (N_ACTIONS = 213):

  0-3     move:i                       battle command: use move i
  4-7     tera:i                       Terastallize + move i
  8       tera:struggle
  9       struggle
  10-15   party slot s (0..5)          switch:s, slot:s, release:s, xfer_from:s, xfer_to:s, discard_from:s
  16-20   ball:t (t 0..4)              POKE / GREAT / ULTRA / ROGUE / MASTER
  21      run
  22-25   target:b (BattlerIndex 0..3), 26 target:all
  27-34   reward:i (0..7)
  35-44   shop:k (0..9)
  45 reroll, 46 skip, 47 transfer (Manage Items), 48 lock_rarities
  49-72   slot:s/move:m                party move target (Ether etc.), 6 x 4
  73-76   forget:i, 77 keep, 78 stop, 79 retry, 80 keep_party
  81-88   opt:i (0..7)                 biome choice / yes-no prompts
  89-104  item:i (0..15)               xfer_item:i, discard_item:i;  105 item:all (xfer_item:all, discard_item:all)
  106-115 qty:n (n 1..10)              xfer_qty:n, discard_qty:n
  116 xfer_mode, 117 back, 118 cancel (Cancel / Done), 119 discard_yes, 120 discard_no
  121-168 slot:s/relearn:k             6 x 8 (Memory Mushroom)
  169-204 splice:i+j                   6 x 6 (DNA Splicers)
  205-212 overflow                     any id that is unknown, out of range, or collides with an
                                       already-used slot, in list order (counted in `stats`)

Ids that don't fit even the overflow are dropped from the mask (never seen in 200-run stress tests).
"""

from __future__ import annotations

import re
from collections import Counter

N_ACTIONS = 213
OVERFLOW = list(range(205, 213))

_SINGLE = {
    "tera:struggle": 8,
    "struggle": 9,
    "run": 21,
    "target:all": 26,
    "reroll": 45,
    "skip": 46,
    "transfer": 47,
    "lock_rarities": 48,
    "keep": 77,
    "stop": 78,
    "retry": 79,
    "keep_party": 80,
    "xfer_item:all": 105,
    "discard_item:all": 105,
    "xfer_mode": 116,
    "back": 117,
    "cancel": 118,
    "discard_yes": 119,
    "discard_no": 120,
}
# (regex, base, limit, extra) ; slot = base + n for 0 <= n < limit
_INDEXED = [
    (re.compile(r"^move:(\d+)$"), 0, 4),
    (re.compile(r"^tera:(\d+)$"), 4, 4),
    (re.compile(r"^(?:switch|slot|release|xfer_from|xfer_to|discard_from):(\d+)$"), 10, 6),
    (re.compile(r"^ball:(\d+)$"), 16, 5),
    (re.compile(r"^target:(\d+)$"), 22, 4),
    (re.compile(r"^reward:(\d+)$"), 27, 8),
    (re.compile(r"^shop:(\d+)$"), 35, 10),
    (re.compile(r"^forget:(\d+)$"), 73, 4),
    (re.compile(r"^opt:(\d+)$"), 81, 8),
    (re.compile(r"^(?:xfer|discard)_item:(\d+)$"), 89, 16),
]
_QTY = re.compile(r"^(?:xfer|discard)_qty:(\d+)$")
_SLOT_MOVE = re.compile(r"^slot:(\d+)/move:(\d+)$")
_RELEARN = re.compile(r"^slot:(\d+)/relearn:(\d+)$")
_SPLICE = re.compile(r"^splice:(\d+)\+(\d+)$")


def preferred_slot(action_id: str) -> int | None:
    """The fixed slot for an action id, or None if it has no slot of its own."""
    if action_id in _SINGLE:
        return _SINGLE[action_id]
    for rx, base, limit in _INDEXED:
        m = rx.match(action_id)
        if m:
            n = int(m.group(1))
            return base + n if n < limit else None
    m = _QTY.match(action_id)
    if m:
        n = int(m.group(1))
        return 106 + n - 1 if 1 <= n <= 10 else None
    m = _SLOT_MOVE.match(action_id)
    if m:
        s, mi = int(m.group(1)), int(m.group(2))
        return 49 + s * 4 + mi if s < 6 and mi < 4 else None
    m = _RELEARN.match(action_id)
    if m:
        s, k = int(m.group(1)), int(m.group(2))
        return 121 + s * 8 + k if s < 6 and k < 8 else None
    m = _SPLICE.match(action_id)
    if m:
        i, j = int(m.group(1)), int(m.group(2))
        return 169 + i * 6 + j if i < 6 and j < 6 else None
    return None


class ActionMapper:
    """Maps a decision's legal action list <-> fixed slots. Keeps counters of overflow / drops."""

    def __init__(self):
        self.stats: Counter = Counter()

    def map(self, actions: list[dict]):
        """Returns (mask[list of 0/1, N_ACTIONS], slot_to_index dict, index_to_slot list (None = dropped))."""
        mask = [0] * N_ACTIONS
        slot_to_index: dict[int, int] = {}
        index_to_slot: list[int | None] = [None] * len(actions)
        pending = []
        for i, a in enumerate(actions):
            s = preferred_slot(a["id"])
            if s is None or s in slot_to_index:
                pending.append(i)
                self.stats["overflow" if s is None else "collision"] += 1
                continue
            slot_to_index[s] = i
            index_to_slot[i] = s
            mask[s] = 1
        free = iter(OVERFLOW)
        for i in pending:
            s = next(free, None)
            if s is None:
                self.stats["dropped"] += 1
                continue
            slot_to_index[s] = i
            index_to_slot[i] = s
            mask[s] = 1
        return mask, slot_to_index, index_to_slot
