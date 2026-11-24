# pokerogue-rl

A standalone sandbox for learning PokéRogue **Endless** mode with reinforcement learning. It
does not share any code with the Classic-mode data-science project. The roadmap:

1. **Headless Endless env** with a legal-action decision API (this repo, step 1).
2. Behavior cloning from Gavin's own runs, recorded through the same API.
3. RL fine-tuning (PPO with action masking) on top of the cloned policy.
4. RLHF / preference tuning on the decisions that matter.

No heuristics live here. Policies so far: uniform-random over the legal actions, and a behaviour-cloned net (see Python training side).

## Layout

| Path | What |
|---|---|
| `pokerogue.pin` | Game repo + release tag/commit (`v1.12.2.8` = `915fae1`, the live release) + the locales and assets submodule commits at that tag. |
| `scripts/setup.mjs` | Clones the game at the pin into `vendor/pokerogue` (gitignored), or moves an existing clean checkout to a new pin; updates locales / assets; reruns `pnpm install` whenever the lockfile changed. |
| `scripts/run.mjs` | CLI: runs seeds in N parallel vitest processes and prints a summary. |
| `scripts/stats.mjs` | Summarizes a run folder: outcomes, waves cleared, decision types, legal-action counts. |
| `scripts/serve.mjs` | Starts the long-lived sim server (`npm run play`): HTTP play UI + JSON-lines TCP API. |
| `scripts/api-check.mjs` | End-to-end check of a running server over the TCP API (logs to `runs/apicheck/`). |
| `sim/server.test.ts` | The server: one game process reused across runs; `reset` / `step` / `resume` / ... |
| `ui/` | The human play UI (plain HTML/CSS/JS, no build step), served by the server: `index.html` + `game.js` + `game.css` is the PokéRogue-style screen; `text.html` is the old plain-text debug view. |
| `sim/visual.ts` | Presentation data for the UI (sprite / icon / arena keys, EXP bars, item icons, type-effectiveness hints). Never logged. |
| `scripts/ui-shots.mjs` | Screenshots of the UI via a throwaway headless Edge/Chrome driven by keystrokes (needs a running server). |
| `sim/vitest.config.ts` | Extends the game's own vitest config (mocked Phaser HEADLESS + jsdom) with `root = vendor/pokerogue`. |
| `sim/env.ts` | `EndlessEnv`: boot, `reset()`, `step(index)`, legality, auto-advance of non-decisions. |
| `sim/obs.ts` | `observe(scene)`: JSON observation (party, enemies, field, money, items). |
| `sim/team.ts` | Seeded random starter team under the 15-point Endless cap. |
| `sim/policies.ts` | `randomPolicy(seed)`. A policy is just `(decision) => index`. |
| `sim/log.ts` | Buffered jsonl run log. |
| `sim/endless.test.ts` | The vitest "test" that drives env + policy + log for each seed. |
| `runs/` | Output (gitignored). |

## Setup

Requires Node ≥ 24.9 and git. pnpm comes through the game's bundled corepack.

```powershell
node scripts/setup.mjs        # clones pagefaultgames/pokerogue@v1.12.2.8 (915fae1) + locales@13867fb, pnpm install,
                              # and a sparse ~85 MB checkout of pokerogue-assets@b7ce101 (play-UI art) into
                              # vendor/pokerogue-assets (skip with --no-assets; the sim itself never loads art)
```

After a pin change just rerun `node scripts/setup.mjs`: it moves the existing checkouts to the new pin in place (it
refuses if `vendor/pokerogue` has local edits) and reinstalls dependencies when `pnpm-lock.yaml` changed. The game's
own git hooks (lefthook) are disabled for these git calls.

## Game version

The pin follows the **live release** (`main` branch / release tags of pagefaultgames/pokerogue), not the default
`beta` dev branch, so recorded play matches pokerogue.net. To update: take the new release tag's commit, read the
`assets` and `locales` gitlinks at that commit (`git ls-tree <tag> assets locales`), put all three in
`pokerogue.pin`, rerun setup, the stress test, `api-check` and `ui-shots`. Every log's `start` record carries
`gamePin`, and `resume` refuses runs recorded on another game commit (they stay reviewable; the Runs list shows them
as "old game <sha>"), because replay is only exact on identical game code.

History: `e1a0c20` (beta, Oct 30 2026, Phaser 4) until 2026-11-23, then `v1.12.2.8` (`915fae1`, main, Nov 18 2026).
Notes on that move:

- `e1a0c20` was a beta commit with 4 commits that never reached main, most importantly the Phaser 3 → 4 upgrade.
  The live game is still on **Phaser 3.90** (`phaser3-rex-plugins`), so the move is partly a Phaser downgrade. The
  harness only uses `Phaser.Game({type: HEADLESS})` and `Phaser.Math.RND`, so nothing broke.
- Gameplay changes in the 40 release commits are small: Sketch fails when the user is transformed; Meloetta's
  Relic Song form change is labelled; trainers no longer get wrong-typed mons and Scuba Diver left the Sea biome
  (trainer-only, Endless has none); daily-run forced biomes can't repeat the current biome; the "Clowning Around"
  mystery encounter was adjusted (MEs are off in Endless); event dates moved (the Halloween event now ended Nov 11).
  The rest is UI / i18n / touch controls / Pokédex fixes and the version bump. A "Champions" patch was added and
  reverted on Nov 17, so it is not in the release.
- The 200-seed random stress test produced **identical decision traces** on both pins (200/200 seeds, same
  actions, waves and enemy HP), so logs from before the move are still valid behaviour-cloning data in practice,
  but are tagged with the old `gamePin`.

## Run

```powershell
node scripts/run.mjs --seed 1 --runs 5 --policy random                 # smoke test (npm run smoke)
node scripts/run.mjs --seed 1000 --runs 200 --parallel 6 --out runs/stress
node scripts/run.mjs --seeds 3,9 --max-waves 50 --no-obs
node scripts/stats.mjs runs/stress
```

Options: `--seed N --runs K` or `--seeds a,b,c`, `--policy random`, `--max-waves N` (default: until wipe),
`--parallel P` (processes), `--out DIR` (default `runs/<policy>_<timestamp>`), `--no-obs`
(log only the chosen action), `--team id,id,...` (fixed starters), `--turn-limit 300`,
`--style set|switch`, `--stall-ms 30000`, `--verbose` (show game console).

Each run uses a seeded random team under the 15-point cap and a seeded game, and it plays until
the party wipes or `--max-waves` is reached. Runs are deterministic: the same seed and the same
actions give the same game.

There is no idle sleep anywhere. The loop pumps the game's mocked clock directly and only yields
the event loop (`setImmediate`). Animations, fades, the IV scanner, and level-up move confirmation are off.

## Decision API

```ts
const env = new EndlessEnv(phaserGame, realRand, { seed, maxWaves, withObs: true });
let d = await env.reset();                // Decision | EndInfo
while (isDecision(d)) d = await env.step(policy(d));   // index into d.actions
```

A `Decision` looks like `{step, kind, sub, phase, wave, turn, prompt, context, actions: LegalAction[], obs}`,
where `LegalAction = {id, label, data}`. Only legal actions are listed. A decision with exactly one
legal action is applied automatically and counted as `forced`. If the game ever refuses an action
(`handleCommand` returns false), it is recorded as `rej` and removed from that phase's list.

| kind | when | actions |
|---|---|---|
| `command` | battle turn per active mon | `move:i` (usable moves only), `switch:slot`, `ball:type` (wild, one foe, not in End), `run` (wild, not trapped), `struggle`; with a Tera Orb, while this arena's Tera is unused: `tera:i` / `tera:struggle` (Terastallize + that move; `context.teraType`) |
| `target` | move needs a target in doubles | `target:BattlerIndex` |
| `reward` | post-wave reward screen | `reward:i`, `shop:i` (affordable), `reroll` (affordable), `skip`, `transfer` (the "Manage Items" button, when some member holds a transferable item), `lock_rarities` (with a Lock Capsule: toggles Lock / Unlock Rarities, re-prices `reroll`, stays on the screen; `context.lockRarities`) |
| `party` (`sub` = PartyUiMode) | faint switch, item/TM/evo target, move PP target, … | `slot:s`, `slot:s/move:m`, `cancel` |
| `party` / `MODIFIER_TRANSFER` | after `transfer`, one pick per decision; `context.stage` = `from` → `item` → `qty` (stacks only) → `to` | `xfer_from:s` / `cancel` (Done, back to the rewards) / `xfer_mode` (Switch to Discard); `xfer_item:i`, `xfer_item:all`; `xfer_qty:n`; `xfer_to:t`; `back` undoes the last pick |
| `party` / `DISCARD` | Manage Items toggled to Discard; `context.stage` = `from` → `item` → `qty` (stacks only) → `confirm` ("Are you sure you want to discard these items?") | `discard_from:s` / `cancel` (Done) / `xfer_mode` (Switch to Transfer); `discard_item:i`, `discard_item:all`; `discard_qty:n`; `discard_yes` / `discard_no` (back to the mon list); `back` |
| `learn_move` | level-up / TM with 4 moves known: "Should a move be forgotten?" | `forget:i` (Yes + that move), `keep` (No / back out of the move list) |
| `learn_move` / `stop_teaching` | after `keep`: "Stop trying to teach X?" | `stop` (Yes: not learned), `retry` (No: back to the question above) |
| `catch_full` | caught a mon with a full party | `release:slot`, `keep_party` |
| `biome` / `option` | biome choice, other yes/no prompts | `opt:i` (informational options like "check summary" are hidden) |

Typical legal-action counts (200 random runs): command 7.6 on average (2–12), reward 4.3, target 2.8,
faint switch 3.2, catch_full 7, learn_move 5, move-target party 11.7 (up to 23).

Transfers follow `PartyUiHandler` in `MODIFIER_TRANSFER` mode: items are indexed as the game's transfer
callback indexes them, quantity defaults to the full stack (`xfer_qty:n` lists max…1, as `<`/`>` cycle in
the game), "All" moves every item at full stacks, only mons that can take the item ("Able") are offered, and
after a transfer you stay on the transfer screen until Done, as in the game. Transfers are free and don't
use up the reward.

Tera, Lock Rarities and Discard follow the live handlers: Tera is offered when `CommandUiHandler.canTera()`
would show the button (Tera Orb held, `canTerastallize`, `playerTerasUsed` + a Tera already planned this turn by
the other mon < 1 per arena; it resets at the party heal / new arena as in the game). Lock Rarities calls the
phase's own `toggleRerollLock` path, so the locked cost is the game's `getRerollCost(true)`: the sum of
50/125/300/750/2000 per offered tier × ⌈wave/10⌉ × 2^rerolls (e.g. three commons on wave 1: ₽150 instead of
₽250), and locked rerolls keep the tiers. Discard calls `tryDiscardHeldItemModifier` with the picked quantity
("All" = every item at full stacks), as the game's confirm does. Obs gains `terasUsed`, `lockRarities`, and
`teraType` / `tera` per mon (`tera` for foes).

Not exposed yet: Check Team (form-change items, unpause evolution, unsplice, reorder, release from the reward
screen) and the run-history / summary screens. See "Browser parity" below.

`debug_give` (server only, `{items: [{name, count?, slot?}]}` by `modifierTypes` key) gives items on an
**unlogged** run (`reset` with `log: false`); it is refused on logged runs, so no log contains it. `ui-shots`
uses it to reach the Tera / Lock / Discard screens, since Tera Orbs and Lock Capsules are rare drops.

**Live-UI features and old logs.** Actions added after the first runs were logged are grouped as features
(`ALL_FEATURES` in `sim/env.ts`): `learn_confirm` (the stop-teaching confirm as its own decision),
`item_transfer`, `tera`, `lock_rarities` and `item_discard`. Each feature only appends actions at the end of a
list, so a log keeps its indexes under the features it recorded. New runs use all of them and list them in the `start` record (`features`). A run whose
`start` has no `features` is replayed without them, so its old decision sequence is reproduced exactly; when
such a run is resumed, the server switches it to all features at that point and writes them into the `resume`
record, and later replays switch at the same step. (Before this, the "Stop trying to teach X?" confirm was
shown as a second `learn_move` decision whose `keep` answered No and asked again, so you could not decline a
move. The sim's settings helper never reached the game's settings object, so all runs so far used the game
defaults, which is also what the live game uses.)

## Log format (`runs/<out>/endless_seed<N>_<policy>.jsonl`)

One JSON object per line, with the record type in `t`:

- `start`: seed, policy, gamePin, mode, team, maxWaves, turnLimit, battleStyle, withObs, features
- `d`: step, wave, turn, kind, sub, phase, `n` (legal count), `chosen` index, action id and label.
  With obs (the default) it also has `actions` (the full legal list), `context`, `prompt`, and `obs`. That is
  one complete (state, legal mask, action) training sample, about 5 KB.
- `rej`: the action from the previous `d` that the game refused
- `wave`: a new wave was reached (wave, party HP fraction, alive count, ms spent)
- `end`: cause (`wipe | max_waves | turn_limit:N | decision_limit:N | stalled:… | error:…`), wave,
  wavesCleared, decisions, forced, autoSteps, animSkips, rejected, bootSeconds, playSeconds
- `resume`: (server) a paused run was replayed and continued in a new session; `features` = the feature set
  from here on, `upgraded` = an older run was switched to it here

`summary.jsonl` in the same folder has one line per run with decisions/sec and waves/sec.

The observation includes everything a player can see: your party's full stats, moves, PP, and items, and
the enemy's species, level, HP fraction, status, types, boss segments, and stat stages. It leaves out hidden
info such as enemy moves, IVs, and exact HP.

## Human play (behavior-cloning data)

```powershell
npm run play          # = node scripts/serve.mjs   (add -- --open to open the browser)
```

It takes about 25 s to boot the game once, then prints:

```
[play] Play UI:  http://127.0.0.1:8765/
[play] JSON-lines API:  tcp 127.0.0.1:8766
```

Open the URL. Both ports are bound to 127.0.0.1 only. Press Ctrl+C to stop.

The play screen is a simplified copy of the real game, drawn with the game's own art (sprites, arenas, item
icons, UI windows and font from the pinned `pokerogue-assets` commit, served locally by the sim server; the
page makes no outside requests):

- **Battle scene:** the biome background and platforms, the enemy's animated front sprite at the top right and
  yours from the back at the bottom left (two of each in doubles). Info boxes show name, level, HP bar, status,
  types, stat changes, shiny ★, and boss bars. Yours also shows HP numbers and an EXP bar. Wave, biome and
  money are at the top right.
- **Battle text** plays one line at a time in the message box. Press Z/Enter or click to advance, or turn on
  **Auto text** (`A`) with Normal/Fast/Fastest speed. HP bars drain after the attack line, attackers lunge,
  and fainted mons drop out.
- **Command menu** like the game: Fight / Ball / Pokémon / Run. **Fight** shows your 4 moves with the type, category,
  PP, power and accuracy of the highlighted one. Move names are tinted by effectiveness against the visible foe, with
  an `x2` / `x0.5` hint, as the game's type hints do. Moves you can't use are greyed out. **Ball** lists your balls
  with counts. **Pokémon** opens the party screen. Doubles get a target picker that makes the chosen sprite blink.
- **Party screen** (switches, faint switches, item / TM / move targets, release when catching with a full party):
  party slots with icons, HP bars, held items and fainted styling, plus the highlighted mon's types, ability, moves
  and stats. Slots that aren't a legal choice are greyed out. If a slot has several choices (e.g. which move gets the
  Ether), a sub-menu lists them.
- **Reward screen:** item cards with icons and tier colours, the shop row with prices, Reroll / Skip / Manage Items,
  and each item's description in the message box.
- **Manage Items (transfer):** the party screen in transfer mode, like the game: pick the mon holding the item,
  then the item (or All) in a window over the party, then how many if it is a stack, then the mon to give it to
  (mons that can't take it are greyed). `X` goes back one step; **Done** returns to the rewards.
- **Learn move:** "Should a move be forgotten and replaced with X?" Yes / No. Yes opens the move list (with the new
  move's type, power and accuracy); `X` or "Don't learn" there, or No, leads to "Stop trying to teach X?" Yes / No,
  where No asks again, as in the game.
- **Biome choice and other prompts** use the game's option window.
- **Keys:** arrows move, `Z`/`Enter`/`Space` confirm, `X`/`Esc`/right-click go back, and `1`–`9` pick the nth option in the
  current menu. `Tab` lists *all* legal actions (a fallback that always reaches every action), `N` starts a new run
  and `R` opens Runs. The mouse works everywhere.
- Every selectable thing on screen is exactly one legal action from the server, sent as `step {index, expect}`. The
  UI never invents actions, so logged runs look the same as before. Sprites, icons and effectiveness hints come in a
  separate `visual` block that is never written to the log. It is computed with the game RNG saved and restored, and
  the API check confirms a run played with visuals replays identically without them.
- `text.html` (link in the header) is the old plain-text view of the same run, handy for debugging.

Runs, resume and review work as before:

- **New run** (`N`): enter a seed (leave it blank for a random one), then either keep the seeded random team
  (**Preview** shows it) or pick up to 6 starters yourself under the 15-point cap.
- **Runs** (`R`) lists `runs/human/`. **Resume** replays a paused run's logged choices with the same seed and team
  (deterministic, over 100 decisions/s) and keeps appending to the same file. **Review** shows every decision with
  its options.
- Each human run is logged to `runs/human/<runId>.jsonl` (for example `human-20261123-224744-seed777`), one record
  per decision, written immediately. The format is the same as the bot runs (obs + full legal list +
  chosen index), plus `thinkMs` (time from showing the decision to the click). `start`
  records the `runId`, the server `session`, and whether the team was chosen by hand. A later `resume` record marks
  where a new session picked up.
- Closing the page doesn't end the run: reload and it picks up again. Starting a new run leaves the old one
  paused and resumable.

`node scripts/ui-shots.mjs` (with the server running) renders screenshots of the battle, fight menu, party,
reward, battle text and, when they come up, catch-with-full-party, item target, doubles and game-over screens,
then plays throwaway runs until it can show the learn-move flow (`8-*`) and Manage Items / transfer (`9-*`),
and on an unlogged run with `debug_give` the Tera button and Tera fight menu (`10-*`), Lock / Unlock Rarities
(`11-*`) and the Discard stages (`12-*`), into `runs/ui-shots/`. It uses a throwaway headless Edge with its own temp profile and debug port 9339 (never 9222).

## Server API (for scripts and the future Python Gym env)

One process holds one game and runs any number of games one after another, so the vitest cold start is paid
once. For parallel RL, start N servers on different ports (`node scripts/serve.mjs --no-http --tcp-port 87xx`).

TCP JSON-lines: send one JSON object per line and get one back per line. An optional `id` is echoed back. The same
commands work as `POST /api` on the HTTP port.

| cmd | args | returns |
|---|---|---|
| `ping` | | session, gamePin, current runId |
| `starters` | | `[{id, name, cost}]`, cap |
| `preview` | `seed` | the seeded random team |
| `reset` | `seed?`, `team?` (species ids, ≤ 15 pts), `policy?` (default `agent`), `log?` (default on for `human`), `obs?` (default true), `maxWaves?`, `out?` (inside runs/) | first decision |
| `step` | `index`, `expect?` (action id, rejects stale clicks), `thinkMs?` | next decision or `end` |
| `state` | | the current decision again |
| `runs` / `review` / `resume` | `runId`, `policy?` | list, records without obs, replay-and-continue |
| `detach` / `abandon` / `shutdown` | | pause (resumable) / end with cause `abandoned` / stop |

A decision response looks like `{ok, runId, logFile, seed, team, decision: {step, kind, sub, phase, wave, turn,
prompt, context, actions, obs}, messages: [battle text since the last response], simMs}`. When the run is over,
`end` replaces `decision`. Over TCP an unlogged agent run with obs off goes at about 210 decisions/s (about
10 ms per round trip with obs).

`node scripts/api-check.mjs` checks a running server end to end: team validation, a logged run, stale-click rejection,
detach, resume by replay landing on the identical decision, review, an old-game-version run listed as such and
refused on resume, and an agent run to the end.

## Performance (BOREN-0: 12 threads, Node 24)

- A vitest cold start is about 20–25 s per process. After that, each boot (reset) takes about 0.1 s.
- Play speed on one process: about 210–235 decisions/s and 24–26 waves/s (random policy, obs on or off).
- 200 runs with `--parallel 6` finish in 80 s of wall time, about 185 decisions/s in total (14.8k decisions).
- A random policy wipes on average at wave 9 (mean 9.21 cleared, median 9, max 19). The 200-seed stress test (seeds
  1000–1199) ended in 200/200 wipes, with 0 stalls, 0 errors and 0 rejected actions, on both `e1a0c20` and `v1.12.2.8`.

## Notes

- **Starting money.** Runs start with ₽1000 like the real game. The game sets it in the starter-select screen's
  `startRun()`, which the harness bypasses by calling `initBattle` directly, so before commit 8669e60 every run
  started at ₽0 (logs from before then have money 0). Wild battles award no money in PokéRogue (only trainer battles
  push `MoneyRewardPhase`, and Endless has no trainers), so money only changes through shop spending, rerolls, and
  money items or moves (Amulet Coin, Pay Day, …). With the fix, random play buys about 10x more shop items.

## Python training side (BC / RL)

Everything Python lives in `rl/` and runs from the project venv `.venv` (gitignored). Setup, once:

```powershell
Setup-Python.bat                     # or: powershell -ExecutionPolicy Bypass -File scripts\setup_py.ps1
```

It makes `.venv` with Python 3.12 (py launcher), installs `torch==2.11.0+cu128` from the PyTorch CUDA 12.8
index plus `requirements.txt` (numpy, gymnasium), and checks the GPU (RTX 2070 SUPER: CUDA available, ~6.7 TFLOP/s
fp32 matmul). System Pythons are untouched.

Commands (from the repo root; `py` = `.venv\Scripts\python`):

```powershell
.venv\Scripts\python -m rl.bc                          # BC on runs/human, then eval 20 seeds: BC greedy / BC sampled / random
.venv\Scripts\python -m rl.bc --epochs 60 --eval-episodes 0   # train only
.venv\Scripts\python -m rl.evaluate --model runs\models\bc-<ts>.pt --sample --episodes 50
.venv\Scripts\python -m rl.evaluate --random --episodes 50
.venv\Scripts\python -m rl.throughput --servers 6 --seconds 60
.venv\Scripts\python -m rl.servers --n 6               # keep 6 servers up (8800-8805) until Ctrl+C; pass --ports 8800,...,8805 to the others
.venv\Scripts\python -m rl.trace_check 60               # determinism check: same seeds give the same decisions fresh and after 60 runs
```

Each command that needs the sim starts its own headless servers, one per env (`node scripts/serve.mjs --no-http
--tcp-port P`; env k uses ports 8800+50k…; 8765/8766 are always refused, so Play.bat keeps working alongside) and
stops them on exit (`shutdown`, then `taskkill /T` as a fallback). Server consoles go to `runs/_servers/serve-<port>.log`.
A cold start is ~25 s for one server and ~50 s for 6 at once. `--servers N` sets how many.

**Long-lived servers.** The game's test mocks leak: `MockSprite.destroy()` leaves the wrapper in its container
(`scene.field`, which `Pokemon.isOnField()` scans with `indexOf`) and every Phaser sprite's `anims` 'remove'
listener piles up (eventemitter3 rebuilds that array on every destroy), so a server used to fall from ~120 to
~13 decisions/s after ~130 runs. `housekeep(scene)` in `sim/env.ts` (run before each reset and at each new wave)
drops only provably dead objects, the never-fired listeners, destroyed infinite timers and the write-only
`MockTextureManager.list`; one server now holds ~120 decisions/s over 150 runs with identical decisions
(`rl.trace_check 150`, and old logs replay identically). Recycling stays on as a safety net (memory still creeps
slowly): each env replaces its server every `--recycle-every` episodes (default 40): it starts a spare in the background
and switches at the next reset once the spare is ready (`servers.RecyclingServer`). `--recycle-every 0` turns this
off; servers started with `python -m rl.servers` and used via `--ports` are not recycled.

| Module | What |
|---|---|
| `rl/client.py` | `SimClient(port)`: TCP JSON-lines client (`reset`, `step(index, expect)`, `call(cmd, ...)`). |
| `rl/servers.py` | `SimServer`, `RecyclingServer` (per-env, recycled), `ServerPool(n)` / `python -m rl.servers`. |
| `rl/actions.py` | Fixed masked action space (`N_ACTIONS = 213`) and `ActionMapper`; the slot table is in the module docstring. |
| `rl/encode.py` | `ENCODER.encode(decision) -> float32[2071]`, identical for live server decisions and logged `d` records. |
| `rl/env.py` | `PokeRogueEnv` (Gymnasium), `RewardConfig`, `make_vec_env(ports)` (AsyncVectorEnv, one worker per server). |
| `rl/data.py` | BC loader: run logs -> (obs, mask, chosen slot). |
| `rl/policy.py` | `MaskedPolicy` (MLP 2x256 + LayerNorm, masked logits, spare value head for PPO), save / load. |
| `rl/bc.py`, `rl/evaluate.py`, `rl/throughput.py` | CLIs above. Models go to `runs/models/` with an `.eval.json` next to them. |

**Agent runs are unlogged.** The env resets with `policy: "agent", log: false, visual: false`, so training and
evaluation write nothing under `runs/` (in particular nothing in `runs/human/`).

**Action space.** `Discrete(213)` with a mask. Every legal action id maps to one fixed slot; slots are shared
between decision kinds where it is the same kind of button (the decision kind is in the observation):
moves 0–3, Tera + move 4–7 (8 Tera Struggle, 9 Struggle), party slot 0–5 → 10–15 (switch / send out / item or TM
target / release / transfer from+to / discard from), balls 16–20, run 21, targets 22–26, reward cards 27–34, shop
35–44, reroll / skip / Manage Items / Lock Rarities 45–48, party move targets 49–72, forget / keep / stop / retry /
keep party 73–80, options 81–88, item picks 89–105, quantities 106–115, transfer-mode / back / cancel-done /
discard yes / no 116–120, Memory Mushroom relearn 121–168, splices 169–204, overflow 205–212 (unknown, out of range
or colliding ids, in list order; counted in `ActionMapper.stats`, never hit so far). A slot outside the mask raises
(`invalid_action="random"` picks a random legal slot instead).

**Observation.** `Dict(obs=float32[2071], action_mask=int8[213])`, built only from the sim's observation, which
is limited to what the live UI shows. Global block: wave (and boss / x50 flags), turn, double, money, battle type,
biome, weather, terrain, ball counts, global items (hashed bag), Tera used, Lock Rarities, decision kind / sub /
transfer stage, acting mon, the move being learned or targeted (type, category, power, accuracy, effectiveness vs
each foe), legal-action count. Party: 6 × (level, HP %, max HP, status, types, stats, stat stages, on field,
fainted, Tera, Tera type, held items (hashed), worst incoming multiplier from each foe's visible types, 4 moves ×
(type, category, power, accuracy, PP, effectiveness vs each foe, STAB, out of PP)). Foes: 2 × (level, HP fraction,
status, types, boss, segments, stat stages, shiny, Tera). Reward / shop cards: 18 × (tier, item type (hashed),
price vs money). Effectiveness uses the standard type chart on visible types, like the game's move tint hints.

**Rewards** are computed in Python (`RewardConfig`, pass `reward={...}` to the env): `per_wave` (1.0 per wave
cleared), `boss_bonus` (extra per boss wave), `wipe_penalty`, `hp_delta` (× change in total party HP fraction),
`step_cost`, `truncation_value`, `limit_penalty` (subtracted when a run is cut by a limit other than `max_waves`); the env's `max_wave_decisions` cuts a run after that many decisions in one wave. A wipe is `terminated`; sim limits (turn limit, per-wave decision cap,
`max_waves`) and the env's own `max_decisions` / `max_episode_seconds` are `truncated` (`info["end"]` has the cause).

**Seeds.** In a vector env of n, `reset(seed=S)` makes env k play sim seeds S+k, S+k+n, …, so evaluation over
seeds S…S+N-1 is the same set for every policy.

### Throughput (BOREN-0, random policy, obs on, AsyncVectorEnv)

| setup | decisions/s |
|---|---|
| 1 fresh server, sync, first 30 s | 115 |
| 3 / 6 / 10 fresh servers, first 25–60 s | 181 / 251 / 278 |
| 6 servers, 6 min sustained, recycling every 40 episodes | 167 (83–241 per minute) |
| 6 servers, 6 min sustained, no recycling | 116 (256 in the first minute, 66 in the sixth) |

Scaling is limited by the sim processes (each ~1 GB RAM and CPU-heavy; `run.mjs --parallel 6` is likewise ~185/s
total), and a vector step waits for the slowest env, so long auto-advance steps and spare-server warm-ups stall the
batch. 6–8 servers is the sweet spot on 12 threads. (The sustained rows were measured before the
housekeeping fix above.)

### First BC smoke (2026-11-24, 1 human run = 125 decisions)

40 epochs in 0.5 s on the GPU: train accuracy 0.93, held-out accuracy 0.72 on 18 decisions (chance 0.17). Played on
seeds 9000-9019 (waves cleared): BC argmax mean 4.5 (8 of 20 runs stuck in a reward-screen loop until the sim
per-wave decision cap), BC sampled 6.0, random 8.0 on this run (9.15 on an earlier run with the same seeds; ~9.2
over 200 seeds). One run is far too little data; this only shows the pipeline works end to end.

### Self-play PPO (`rl/ppo.py`)

```powershell
Train.bat                                              # = .venv\Scripts\python -m rl.ppo (new run, 6 envs, runs until stopped)
Train.bat --resume runs\models\ppo-<ts>\latest.pt       # continue (model, optimizer, counters)
Stop-Train.bat                                         # ask every running trainer to stop (saves latest.pt, closes its servers)
.venv\Scripts\python -m rl.ppo --init-bc runs\models\bc-<ts>.pt --bc-coef 0.05   # start from BC, keep a BC aux loss on runs/human
.venv\Scripts\python -m rl.evaluate --model runs\models\ppo-<ts>\best.pt --sample --episodes 50   # checkpoints load like BC models
```

- **Model:** `MaskedPolicy` (2×256 MLP + LayerNorm, dropout 0) with its policy head over the 213 slots and its value
  head; orthogonal init with a 0.01-gain policy head, so the untrained policy is ~uniform over legal actions (= random).
- **Algorithm:** clipped PPO with invalid-action masking (log-probs and entropy over legal slots only), GAE,
  per-minibatch advantage normalisation, clipped value loss, grad-norm clip, early stop on approx-KL. Gymnasium's
  next-step autoreset makes the step after an episode end a dummy (its action is ignored); those are dropped from the
  loss and GAE. A wipe does not bootstrap; a run cut by a limit bootstraps with its last state's value.
- **Defaults:** 6 envs × 256 steps = 1536 decisions per update, 4 epochs, minibatch 512, Adam lr 2.5e-4, γ 0.997,
  λ 0.95, clip 0.2, entropy 0.01, value 0.5, max grad norm 0.5, target KL 0.03.
- **Reward (defaults here, all flags):** `--per-wave 1` per wave cleared; `--boss-bonus 3` per boss wave (every 10th)
  and `--major-boss-bonus 10` more per multiple of 50; `--exp-per-level 0.5` per party level gained (capped at
  `--exp-step-cap 1.5` per step); `--win-bonus 0.5` per foe for a battle won by KO; `--hp-keep 0.5` × party HP kept
  over that battle (end / start, ≤ 1); `--faint-penalty 0.3` per own faint; `--catch-bonus 0`; `--step-cost 0.001`;
  `--limit-penalty 2` for a run cut by a limit (sim turn / decision / stall limits, the env's time cap, or
  `--max-wave-decisions 300`, i.e. a menu loop). A battle counts as fled when the last battle command was Run, caught
  when it was a ball, else won; fled and caught battles get only the +1 per wave, so fleeing is never the cheap way
  to bank the HP / KO terms.
  The first version (waves only) learned to flee ~67% of battle commands and throw balls ~30% (bosses get caught),
  fighting 2%: mean 32 waves on 9000-9049 but a hard wall at wave 50. This shaping is the fix being tried.
- **EXP:** the sim's observation has each mon's level but not its EXP bar (the live party summary shows it), so the
  EXP term uses level-ups of mons already in the party as a proxy. Exposing EXP progress would need a sim change.
- **Logs per episode:** `episodes.csv` has every reward component (`r_wave`, `r_boss`, `r_exp`, `r_win`, `r_hp_keep`,
  `r_faint`, `r_step`, `r_limit`, ...) and counters (`n_cmd`, `n_run`, `n_fight`, `n_ball`, `n_switch`, `n_won`,
  `n_fled`, `n_caught`, `n_levels`); `metrics.csv` / `train.log` show run% and fight% of battle commands per update;
  `eval.csv` has `pass50` (held-out runs that cleared wave 50).
- **After a reward change:** `--init <ckpt> --reset-value --value-warmup 5` starts from a model, resets its value head
  and fits it for 5 updates with the policy frozen.
- `python -m rl.action_stats <ckpt> 10` plays 10 held-out seeds on its own server (ports 9300+) and prints the picks
  per decision kind and Run% / Fight% / Ball% / Switch% of battle commands.
- **Seeds:** training plays seeds 110000+ (a new block of 10000 after every eval reset); evaluation uses the fixed
  held-out seeds 9000–9049, which training never sees.
- **Eval:** at the start, random and the untrained policy on 9000–9049; then every `--eval-every 30` updates the
  current policy, sampled (`--eval-modes sample,greedy` adds argmax). The best sampled mean is saved as `best.pt`.
- **Outputs:** `runs/train/<ts>/` has `train.log` (one line per update), `metrics.csv` (losses, entropy, KL,
  explained variance, decisions/s, training episodes' waves), `eval.csv`, `episodes.csv` (every training episode),
  `config.json`, `pid.txt`; `finished` appears when it exits. Checkpoints: `runs/models/ppo-<ts>/ckpt-<update>.pt`
  every 10 updates, `latest.pt` every update, `best.pt`.
- **Stopping:** `Stop-Train.bat` writes `runs/train/<ts>/STOP`; the trainer stops after the current update. Hard stop
  if it hangs: `taskkill /T /F /PID <pid from pid.txt>` (the `/T` also ends its env workers and sim servers).
  A sim crash restarts the envs (up to `--max-restarts 20`) and carries on from the in-memory model.

## Browser parity (for a future pokerogue.net adapter)

The goal is that a policy trained here can later drive the real browser game through an adapter. The action set
should therefore become exactly the live UI's. Gaps on `v1.12.2.8`, with rough effort to add each to the env, the
log format and the play UI (not implemented yet; Tera, Lock Rarities and item Discard are done):

| Gap | What the live game has | Effort |
|---|---|---|
| Check Team (reward screen) | Party in CHECK mode: Switch (reorder party), Unpause Evolution (species with evolutions), Unsplice (fused), Release, and one toggle per form-change item (Mega / G-Max / other; toggles `modifier.active` and triggers the form change), plus Summary / Pokédex / Rename (info only) | ~1 day (`check_*` actions, option sub-menu per mon, UI) |
| Able / Not able labels | Transfer target list shows every member with Able / Not able; the env only offers the able ones | UI only |
| Check team / summary / Pokédex | Informational screens from battle and reward | ~0.5 day UI only; no game effect, so no actions |
| Starter select | Real starter screen with the account's unlocks: ability, nature, form, gender, shiny/variant, passive, egg moves, candy cost reductions | ~1–2 days to model starter config; the live account decides what is legal |
| Settings parity | Battle style, EXP display, skip-seen-dialogue etc. affect which prompts appear | ~0.5 day (match a fixed settings profile) |
| Browser adapter itself | Read on-screen state and press keys with animation timing | separate project, ~3–5 days |

Everything already exposed (moves, switches, balls, run, targets, rewards, shop, reroll, skip, party targets,
learn/forget and stop-teaching, held-item transfer and discard, Tera, Lock Rarities, release, biome / yes-no
options) maps to live UI input.
