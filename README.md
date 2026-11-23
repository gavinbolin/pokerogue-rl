# pokerogue-rl

A standalone sandbox for learning PokéRogue **Endless** mode with reinforcement learning. It
does not share any code with the Classic-mode data-science project. The roadmap:

1. **Headless Endless env** with a legal-action decision API (this repo, step 1).
2. Behavior cloning from Gavin's own runs, recorded through the same API.
3. RL fine-tuning (PPO with action masking) on top of the cloned policy.
4. RLHF / preference tuning on the decisions that matter.

No heuristics live here. The only policy so far is uniform-random over the legal actions.

## Layout

| Path | What |
|---|---|
| `pokerogue.pin` | Game repo + commit (`e1a0c20`) + locales commit. The assets submodule is not needed. |
| `scripts/setup.mjs` | Fresh clone of the game at the pin into `vendor/pokerogue` (gitignored), then `pnpm install`. |
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
node scripts/setup.mjs        # clones pagefaultgames/pokerogue@e1a0c20 + locales, pnpm install,
                              # and a sparse ~85 MB checkout of pokerogue-assets@8250b23 (play-UI art) into
                              # vendor/pokerogue-assets (skip with --no-assets; the sim itself never loads art)
```

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
| `command` | battle turn per active mon | `move:i` (usable moves only), `switch:slot`, `ball:type` (wild, one foe, not in End), `run` (wild, not trapped), `struggle` |
| `target` | move needs a target in doubles | `target:BattlerIndex` |
| `reward` | post-wave reward screen | `reward:i`, `shop:i` (affordable), `reroll` (affordable), `skip` |
| `party` (`sub` = PartyUiMode) | faint switch, item/TM/evo target, move PP target, … | `slot:s`, `slot:s/move:m`, `cancel` |
| `learn_move` | level-up / TM with 4 moves known | `forget:i`, `keep` |
| `catch_full` | caught a mon with a full party | `release:slot`, `keep_party` |
| `biome` / `option` | biome choice, other yes/no prompts | `opt:i` (informational options like "check summary" are hidden) |

Typical legal-action counts (200 random runs): command 7.6 on average (2–12), reward 4.3, target 2.8,
faint switch 3.2, catch_full 7, learn_move 5, move-target party 11.7 (up to 23).

Not exposed yet: Tera, the shop's lock-rarity and item-transfer actions, and the run-history and summary
screens.

## Log format (`runs/<out>/endless_seed<N>_<policy>.jsonl`)

One JSON object per line, with the record type in `t`:

- `start`: seed, policy, gamePin, mode, team, maxWaves, turnLimit, battleStyle, withObs
- `d`: step, wave, turn, kind, sub, phase, `n` (legal count), `chosen` index, action id and label.
  With obs (the default) it also has `actions` (the full legal list), `context`, `prompt`, and `obs`. That is
  one complete (state, legal mask, action) training sample, about 5 KB.
- `rej`: the action from the previous `d` that the game refused
- `wave`: a new wave was reached (wave, party HP fraction, alive count, ms spent)
- `end`: cause (`wipe | max_waves | turn_limit:N | decision_limit:N | stalled:… | error:…`), wave,
  wavesCleared, decisions, forced, autoSteps, animSkips, rejected, bootSeconds, playSeconds
- `resume`: (server) a paused run was replayed and continued in a new session

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
- **Reward screen:** item cards with icons and tier colours, the shop row with prices, Reroll / Skip, and each item's
  description in the message box.
- **Learn move, biome choice and other prompts** use the game's option window.
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
reward, battle text and, when they come up, catch-with-full-party, item target, doubles and game-over screens
into `runs/ui-shots/`. It uses a throwaway headless Edge with its own temp profile and debug port 9339 (never 9222).

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
detach, resume by replay landing on the identical decision, review, and an agent run to the end.

## Performance (BOREN-0: 12 threads, Node 24)

- A vitest cold start is about 20–25 s per process. After that, each boot (reset) takes about 0.1 s.
- Play speed on one process: about 210–235 decisions/s and 24–26 waves/s (random policy, obs on or off).
- 200 runs with `--parallel 6` finish in 80 s of wall time, about 185 decisions/s in total (14.8k decisions).
- A random policy wipes on average at wave 9 (median 9, max 19). The 200-seed stress test (seeds 1000–1199) ended in 200/200 wipes,
  with 0 stalls, 0 errors and 0 rejected actions.

## Notes

- **Starting money.** Runs start with ₽1000 like the real game. The game sets it in the starter-select screen's
  `startRun()`, which the harness bypasses by calling `initBattle` directly, so before commit 8669e60 every run
  started at ₽0 (logs from before then have money 0). Wild battles award no money in PokéRogue (only trainer battles
  push `MoneyRewardPhase`, and Endless has no trainers), so money only changes through shop spending, rerolls, and
  money items or moves (Amulet Coin, Pay Day, …). With the fix, random play buys about 10x more shop items.
