/**
 * EndlessEnv: one headless PokeRogue ENDLESS run with a legal-action decision API.
 *
 *   const env = new EndlessEnv(phaserGame, realRand, opts);
 *   let d = await env.reset();                       // Decision | EndInfo
 *   while (isDecision(d)) d = await env.step(policy(d)); // pass an index into d.actions
 *
 * The game is stepped phase by phase (the game test harness's PhaseInterceptor stops the phase
 * manager from auto-starting phases; we start each one ourselves). Between phases we pump the
 * mocked Phaser clock directly and yield with setImmediate, so there is no fixed sleep anywhere.
 *
 * A Decision is any point where the real game would wait for a player choice that matters:
 *   command  - fight (move i) / switch (slot) / ball (type) / run, per active mon
 *   target   - target choice for a single-target move in a double battle
 *   reward   - post-wave reward screen: take reward i, buy shop item k, reroll, skip
 *   party    - pick a party member (faint switch, item / TM / berry target, move for PP items,
 *              held-item transfer from the reward screen (sub MODIFIER_TRANSFER, context.stage),
 *              memory mushroom move, splice pair, release on full party, revival blessing)
 *   learn_move - mon with 4 moves wants a new one: forget move i, or don't learn; then (sub
 *              "stop_teaching", live default) "Stop trying to teach X?": stop, or go back and pick again
 *   biome    - choose next biome (only when a Map lets you)
 *   catch_full - caught a mon with 6 in party: release slot s to keep it, or don't keep it
 *   option   - any other in-game option / confirm menu
 * Purely cosmetic prompts (text boxes, single-option menus) are auto-advanced and counted as
 * "auto" steps. Decisions with exactly one legal action are applied automatically ("forced").
 * No hand-written play heuristics live here: only the game's own legality rules.
 */
import type { BattleScene } from "#app/battle-scene";
import { getGameMode } from "#app/game-mode";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { BattleScene as BattleSceneClass } from "#app/battle-scene";
import * as BattleAnims from "#data/battle-anims";
import { allMoves } from "#data/data-lists";
import { Gender } from "#data/gender";
import { BattleStyle } from "#enums/battle-style";
import { BattleType } from "#enums/battle-type";
import { BiomeId } from "#enums/biome-id";
import { Button } from "#enums/buttons";
import { Command } from "#enums/command";
import { GameModes } from "#enums/game-modes";
import { PartyUiMode } from "#enums/party-ui-mode";
import { PokeballType } from "#enums/pokeball";
import type { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { PlayerPokemon } from "#field/pokemon";
import { HealShopCostModifier, PokemonHeldItemModifier } from "#modifiers/modifier";
import {
  FusePokemonModifierType,
  getPlayerShopModifierTypeOptionsForWave,
  PokemonModifierType,
  PokemonMoveModifierType,
} from "#modifiers/modifier-type";
import { LearnMovePhase } from "#phases/learn-move-phase";
import { SelectStarterPhase } from "#phases/select-starter-phase";
import { GameManager } from "#test/framework/game-manager";
import { PromptHandler } from "#test/helpers/prompt-handler";
import type { StarterSpeciesId } from "#types/starter-species-id";
import { BattleInfo } from "#ui/battle-info";
import { SHOP_OPTIONS_ROW_LIMIT } from "#ui/modifier-select-ui-handler";
import { PartyOption } from "#ui/party-ui-handler";
import { getStarterMoves } from "#ui/starter-select-ui-utils";
import { NumberHolder } from "#utils/common";
import Phaser from "phaser";
import { vi } from "vitest";
import { enumName, type Observation, observe } from "./obs.ts";
import { seeded } from "./rng.ts";
import { drawTeam, fixedTeam, type Team } from "./team.ts";

export type DecisionKind = "command" | "target" | "reward" | "party" | "learn_move" | "forget_move" | "catch_full" | "biome" | "option";

export interface LegalAction {
  id: string; // stable machine id, e.g. "move:2", "switch:4", "reward:1", "shop:3", "skip"
  label: string; // human-readable
  data?: Record<string, unknown>;
}

export interface Decision {
  step: number;
  kind: DecisionKind;
  sub?: string; // e.g. party mode, option phase
  phase: string;
  wave: number;
  turn: number;
  prompt?: string;
  context?: Record<string, unknown>;
  actions: LegalAction[];
  obs?: Observation;
}

export interface EndInfo {
  done: true;
  cause: string; // wipe | max_waves | turn_limit | stalled:... | error:...
  wave: number; // wave the run ended on
  wavesCleared: number;
  decisions: number;
  forced: number;
  autoSteps: number;
  animSkips: number;
  rejected: number;
  bootSeconds: number;
  playSeconds: number;
}

export const isDecision = (x: Decision | EndInfo): x is Decision => !(x as EndInfo).done;

/**
 * Live-UI features added after the first runs were logged. A run's start record lists the ones it
 * was played with (`features`); a record without the field is an older run, replayed with none so
 * its decision sequence is reproduced exactly.
 *   learn_confirm - the live "Stop trying to teach X?" confirm after declining a move (game setting
 *                   levelMoveConfirmation, on by default in the live game)
 *   item_transfer - the reward screen's Transfer button (move held items between party members)
 */
export const ALL_FEATURES = ["learn_confirm", "item_transfer"] as const;
export type Feature = (typeof ALL_FEATURES)[number];

export interface EnvOptions {
  /** live-UI features to enable (default: all of ALL_FEATURES); pass [] to replay a pre-feature run */
  features?: readonly string[];
  seed: string;
  maxWaves: number | null;
  team: number[] | null; // fixed species list (debug); null = seeded random team under the cap
  pointCap: number;
  withObs: boolean;
  turnLimit: number; // per-wave turn cap (stops random play from looping forever)
  battleStyle: "set" | "switch";
  stallMs: number;
  maxDecisionsPerWave: number; // safety cap against decision loops
  onWave?: (info: { wave: number; prev: number; partyHpFrac: number; alive: number; ms: number }) => void;
}

interface Pending {
  decision: Decision;
  apply: (() => boolean)[];
  phase: object;
}

type AnyHandler = Record<string, any>;

const MESSAGE_LIKE = new Set<UiMode>([
  UiMode.MESSAGE,
  UiMode.EVOLUTION_SCENE,
  UiMode.EGG_HATCH_SCENE,
  UiMode.EGG_HATCH_SUMMARY,
]);
const CLOSE_IF_STUCK = new Set<UiMode>([UiMode.SUMMARY, UiMode.MENU, UiMode.BALL, UiMode.POKEDEX, UiMode.POKEDEX_PAGE, UiMode.PARTY]);
/** Purely informational menu entries (open a viewer and come back); never offered as actions. */
const INFO_LABELS = /^(summary|pok[eé]dex|check team)$/i;

const originalStatsContainer = BattleInfo.prototype.getStatsValueContainer;

export class EndlessEnv {
  readonly team: Team;
  private game!: GameManager;
  private scene!: BattleScene;
  private started = new WeakSet<object>();
  private animSkips = 0;
  /** Battle messages shown since the last drainMessages() (not part of the decision log). */
  readonly messages: string[] = [];
  private rejected = new WeakMap<object, Set<string>>();
  private pending: Pending | null = null;
  private pendingSkip = false;
  private pendingForget: number | null = null;
  /** Held-item transfer in progress (party screen in MODIFIER_TRANSFER mode): what's picked so far. */
  private xfer: { from?: number; item?: number | "all"; qty?: number } = {};
  private features_: Feature[];
  private pendingRelease: number | null = null;
  private step_ = 0;
  private forced = 0;
  private autoSteps = 0;
  private rejectedCount = 0;
  private lastWave = 0;
  private waveStartedAt = 0;
  private bootSeconds = 0;
  private playStartedAt = 0;
  private finished: EndInfo | null = null;
  /** UI mode changes still in flight (fade transitions resolve on later clock ticks). */
  private modeChanges = 0;
  private waveDecisions = 0;

  constructor(
    private readonly phaserGame: Phaser.Game,
    private readonly realRand: BattleScene["randBattleSeedInt"],
    readonly opts: EnvOptions,
  ) {
    this.team = opts.team?.length ? fixedTeam(opts.team, opts.pointCap) : drawTeam(opts.seed, opts.pointCap);
    this.features_ = ALL_FEATURES.filter(f => (opts.features ?? ALL_FEATURES).includes(f));
  }

  get features(): readonly Feature[] {
    return this.features_;
  }

  has(f: Feature): boolean {
    return this.features_.includes(f);
  }

  /**
   * Switch live-UI features mid-run (e.g. an older run resumed in a newer session) and re-read the
   * pending decision under the new set. Game state is untouched; the step number stays the same.
   */
  async setFeatures(list: readonly string[]): Promise<Decision | EndInfo> {
    this.features_ = ALL_FEATURES.filter(f => list.includes(f));
    if (this.finished) {
      return this.finished;
    }
    if (!this.pending) {
      throw new Error("setFeatures() called with no pending decision");
    }
    this.pending = null;
    this.step_--;
    this.waveDecisions--;
    return this.advance();
  }

  // ---------------------------------------------------------------- boot

  /** The live game scene (read-only use: visuals for the play UI). Undefined before reset(). */
  get sceneRef(): BattleScene | undefined {
    return this.scene;
  }

  /** Messages the game displayed since the previous call. */
  drainMessages(): string[] {
    return this.messages.splice(0, this.messages.length);
  }

  async reset(): Promise<Decision | EndInfo> {
    const t0 = Date.now();
    const seed = this.opts.seed;
    vi.restoreAllMocks();
    if (PromptHandler.runInterval) {
      clearInterval(PromptHandler.runInterval);
      PromptHandler.runInterval = undefined;
    }
    this.reseed(seed);
    stubHeadlessAssets();
    // Earlier versions "set" hideIvScanner / levelMoveConfirmation / enableMoveAnimations here through a
    // helper that never reached settings.general, so every run logged so far used the game's defaults.
    // Keep the defaults (replays stay exact). levelMoveConfirmation=true is also the live default, i.e. the
    // "Stop trying to teach X?" confirm always appeared; feature learn_confirm just exposes it correctly.
    trackStopTeaching();

    this.game = new GameManager(this.phaserGame, true);
    // GameManager forces max rolls on battle RNG and sows Phaser with "test"; undo both.
    BattleSceneClass.prototype.randBattleSeedInt = this.realRand;
    this.reseed(seed);
    this.game.settings.battleStyle(this.opts.battleStyle === "switch" ? BattleStyle.SWITCH : BattleStyle.SET);
    const scene = (this.scene = this.game.scene);
    vi.spyOn(scene.ui, "shouldSkipDialogue").mockReturnValue(true);
    patchUi(scene, this.messages);
    this.trackModeChanges(scene);
    blockNetwork();

    await this.game.runToTitle();
    this.started.add(scene.phaseManager.getCurrentPhase());

    scene.gameMode = getGameMode(GameModes.ENDLESS);
    if (!scene.gameMode.isEndless) {
      throw new Error("could not select Endless");
    }
    scene.setSeed(seed);
    scene.resetSeed(0);
    // The real game sets the starting money in the starter-select screen's startRun() (which this
    // harness bypasses by calling initBattle directly), so do the same here: 1000 in Endless.
    scene.money = scene.gameMode.getStartingMoney();
    const starters = buildStarters(scene, this.team.speciesIds);
    scene.phaseManager.pushNew("EncounterPhase", false);
    new SelectStarterPhase().initBattle(starters);

    // The game-harness prompt poller is not needed once the title screen is passed.
    if (PromptHandler.runInterval) {
      clearInterval(PromptHandler.runInterval);
      PromptHandler.runInterval = undefined;
    }
    this.bootSeconds = (Date.now() - t0) / 1000;
    this.playStartedAt = Date.now();
    this.waveStartedAt = Date.now();
    return this.advance();
  }

  /** Count in-flight UI mode changes so decisions are only read once the screen has settled. */
  private trackModeChanges(scene: BattleScene): void {
    const ui = scene.ui as any;
    const inner = ui.setModeInternal;
    ui.setModeInternal = (...args: unknown[]) => {
      this.modeChanges++;
      const done = () => {
        this.modeChanges--;
      };
      const p: Promise<void> = inner.apply(ui, args);
      p.then(done, done);
      return p;
    };
  }

  private reseed(seed: string): void {
    Phaser.Math.RND.sow([seed]);
    const r = seeded(`math.random:${seed}`);
    Math.random = () => r();
  }

  // ---------------------------------------------------------------- stepping

  async step(index: number): Promise<Decision | EndInfo> {
    if (this.finished) {
      return this.finished;
    }
    const p = this.pending;
    if (!p) {
      throw new Error("step() called with no pending decision");
    }
    if (!Number.isInteger(index) || index < 0 || index >= p.apply.length) {
      throw new Error(`illegal action index ${index} (legal 0..${p.apply.length - 1})`);
    }
    this.pending = null;
    this.applyChoice(p, index);
    return this.advance();
  }

  get lastDecisionRejected(): boolean {
    return this.lastRejected;
  }
  private lastRejected = false;

  private applyChoice(p: Pending, index: number): void {
    let ok = false;
    try {
      ok = p.apply[index]() !== false;
    } catch (error) {
      this.end(`error: applying ${p.decision.actions[index]?.id}: ${errText(error)}`);
      return;
    }
    this.lastRejected = !ok;
    if (!ok) {
      this.rejectedCount++;
      const set = this.rejected.get(p.phase) ?? new Set<string>();
      set.add(p.decision.actions[index].id);
      this.rejected.set(p.phase, set);
    }
  }

  private end(cause: string): EndInfo {
    if (this.finished) {
      return this.finished;
    }
    const wave = this.scene?.currentBattle?.waveIndex ?? 0;
    this.finished = {
      done: true,
      cause,
      wave,
      wavesCleared: Math.max(0, cause === "max_waves" ? (this.opts.maxWaves ?? wave) : wave - 1),
      decisions: this.step_,
      forced: this.forced,
      autoSteps: this.autoSteps,
      animSkips: this.animSkips,
      rejected: this.rejectedCount,
      bootSeconds: this.bootSeconds,
      playSeconds: (Date.now() - this.playStartedAt) / 1000,
    };
    return this.finished;
  }

  /** Run the game until the next real decision or the end of the run. */
  private async advance(): Promise<Decision | EndInfo> {
    const scene = this.scene;
    let lastKey = "";
    let keySince = Date.now();
    let idle = 0;
    await tick();
    for (;;) {
      if (this.finished) {
        return this.finished;
      }
      const pm = scene.phaseManager;
      const phase = pm.getCurrentPhase();
      if (!phase) {
        return this.end("error: no current phase");
      }
      const name = phase.phaseName;
      const battle = scene.currentBattle;

      if (name === "GameOverPhase") {
        const wiped = scene.getPlayerParty().every(p => p.isFainted());
        return this.end(wiped ? "wipe" : "game_over");
      }
      if (battle) {
        if (battle.waveIndex !== this.lastWave) {
          const prev = this.lastWave;
          this.lastWave = battle.waveIndex;
          if (this.opts.maxWaves != null && battle.waveIndex > this.opts.maxWaves) {
            return this.end("max_waves");
          }
          const party = scene.getPlayerParty();
          const hp = party.reduce((a, p) => a + p.hp, 0) / Math.max(1, party.reduce((a, p) => a + p.getMaxHp(), 0));
          this.opts.onWave?.({
            wave: battle.waveIndex,
            prev,
            partyHpFrac: Math.round(hp * 1000) / 1000,
            alive: party.filter(p => !p.isFainted()).length,
            ms: Date.now() - this.waveStartedAt,
          });
          this.waveStartedAt = Date.now();
          this.waveDecisions = 0;
        }
        if (battle.turn > this.opts.turnLimit) {
          return this.end(`turn_limit:${this.opts.turnLimit}`);
        }
      }

      if (!this.started.has(phase)) {
        this.started.add(phase);
        try {
          phase.start();
        } catch (error) {
          // A purely cosmetic animation phase can throw headless when its target sprite is
          // already gone (seen: CommonAnimPhase after a faint). Skipping it changes no game state.
          if (name === "CommonAnimPhase" || name === "MoveAnimPhase") {
            this.animSkips++;
            phase.end();
            continue;
          }
          return this.end(`error: ${name}.start: ${errText(error)}`);
        }
        idle = 0;
        continue;
      }

      const mode = scene.ui.mode;
      const key = `${name}|${enumName(UiMode, mode)}`;
      if (key !== lastKey) {
        lastKey = key;
        keySince = Date.now();
      }

      let found: Pending | null = null;
      try {
        found = this.modeChanges > 0 ? null : this.detect(phase, name, mode);
      } catch (error) {
        return this.end(`error: detect ${key}: ${errText(error)}`);
      }
      if (found) {
        if (found.apply.length === 0) {
          return this.end(`error: no legal actions at ${key}`);
        }
        if (found.apply.length === 1) {
          this.forced++;
          this.applyChoice(found, 0);
          idle = 0;
          await tick();
          continue;
        }
        if (++this.waveDecisions > this.opts.maxDecisionsPerWave) {
          return this.end(`decision_limit:${this.opts.maxDecisionsPerWave}`);
        }
        this.step_++;
        found.decision.step = this.step_;
        if (this.opts.withObs) {
          found.decision.obs = observe(scene);
        }
        this.pending = found;
        return found.decision;
      }

      if (this.autoAdvance(name, mode, idle)) {
        this.autoSteps++;
        idle = 0;
        await tick();
        continue;
      }

      // Nothing to do: let timers / promises run.
      idle++;
      pumpClock(scene);
      await tick();
      if ((idle & 1023) === 0 && Date.now() - keySince > this.opts.stallMs) {
        return this.end(`stalled:${key}`);
      }
    }
  }

  private autoAdvance(name: string, mode: UiMode, idle: number): boolean {
    const h = this.scene.ui.getHandler() as AnyHandler;
    if (!h) {
      return false;
    }
    if (MESSAGE_LIKE.has(mode) && h.awaitingActionInput) {
      if (typeof h.unblockInput === "function") {
        h.unblockInput();
      }
      h.blockInput = false;
      h.processInput?.(Button.ACTION);
      return true;
    }
    // Pending forget-move choice made at the learn_move decision.
    if (mode === UiMode.SUMMARY && name === "LearnMovePhase" && typeof h.moveSelectFunction === "function" && this.pendingForget != null) {
      const idx = this.pendingForget;
      this.pendingForget = null;
      const fn = h.moveSelectFunction;
      h.moveSelectFunction = null;
      fn(idx);
      return true;
    }
    // Full-party catch: the slot to release was already chosen at the catch_full decision.
    if (mode === UiMode.PARTY && this.pendingRelease != null && h.partyUiMode === PartyUiMode.RELEASE && typeof h.selectCallback === "function") {
      const s = this.pendingRelease;
      this.pendingRelease = null;
      return releaseSlot(this.scene, h, s);
    }
    // Skip-reward confirmation: the skip was already the decision.
    if (mode === UiMode.CONFIRM && this.pendingSkip && name === "SelectModifierPhase" && h.options?.length) {
      this.pendingSkip = false;
      return pickOption(h, 0);
    }
    if (CLOSE_IF_STUCK.has(mode) && idle > 5000 && h.active) {
      h.processInput?.(Button.CANCEL);
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- decision detection

  private detect(phase: any, name: string, mode: UiMode): Pending | null {
    const ui = this.scene.ui;
    const h = ui.getHandler() as AnyHandler;
    if (!h) {
      return null;
    }
    if (name === "CommandPhase" && (mode === UiMode.COMMAND || mode === UiMode.FIGHT) && h.active) {
      return this.commandDecision(phase);
    }
    if (name === "SelectTargetPhase" && mode === UiMode.TARGET_SELECT && typeof h.targetSelectCallback === "function" && h.active) {
      return this.targetDecision(phase, h);
    }
    if (name === "SelectModifierPhase" && mode === UiMode.MODIFIER_SELECT && h.awaitingActionInput && h.onActionInput) {
      return this.rewardDecision(phase, h);
    }
    if (mode === UiMode.PARTY && typeof h.selectCallback === "function") {
      if (this.pendingRelease != null && h.partyUiMode === PartyUiMode.RELEASE) {
        return null; // handled by autoAdvance
      }
      if (h.partyUiMode === PartyUiMode.MODIFIER_TRANSFER && this.has("item_transfer")) {
        return this.transferDecision(phase, h);
      }
      return this.partyDecision(phase, h);
    }
    if (mode === UiMode.SUMMARY && name === "LearnMovePhase" && typeof h.moveSelectFunction === "function" && this.pendingForget == null) {
      return this.forgetDecision(phase, h);
    }
    if ((mode === UiMode.CONFIRM || mode === UiMode.OPTION_SELECT) && h.active && Array.isArray(h.options) && h.options.length) {
      if (this.pendingSkip && name === "SelectModifierPhase" && mode === UiMode.CONFIRM) {
        return null; // handled by autoAdvance
      }
      if (name === "LearnMovePhase" && mode === UiMode.CONFIRM && this.pendingForget == null) {
        return this.learnDecision(phase, h);
      }
      return this.optionDecision(phase, name, h);
    }
    return null;
  }

  private base(phase: any, kind: DecisionKind, extra: Partial<Decision> = {}): Pending {
    const battle = this.scene.currentBattle;
    return {
      phase,
      apply: [],
      decision: {
        step: 0,
        kind,
        phase: phase.phaseName,
        wave: battle?.waveIndex ?? 0,
        turn: battle?.turn ?? 0,
        actions: [],
        ...extra,
      },
    };
  }

  private add(p: Pending, action: LegalAction, fn: () => boolean): void {
    if (this.rejected.get(p.phase)?.has(action.id)) {
      return;
    }
    p.decision.actions.push(action);
    p.apply.push(fn);
  }

  private commandDecision(phase: any): Pending | null {
    const scene = this.scene;
    const battle = scene.currentBattle;
    const fieldIndex: number = phase.getFieldIndex();
    const mon = phase.getPokemon() as PlayerPokemon | undefined;
    if (!mon) {
      return null;
    }
    const p = this.base(phase, "command", { context: { fieldIndex, mon: mon.name, slot: fieldIndex } });

    // FIGHT
    const moveset = mon.getMoveset();
    let usable = 0;
    moveset.forEach((m, i) => {
      if (!m) {
        return;
      }
      const [ok] = mon.trySelectMove(i, false);
      if (!ok) {
        return;
      }
      usable++;
      this.add(
        p,
        { id: `move:${i}`, label: m.getName(), data: { moveId: m.moveId, pp: m.getMovePp() - m.ppUsed } },
        () => phase.handleCommand(Command.FIGHT, i),
      );
    });
    if (usable === 0 && moveset.length > 0) {
      this.add(p, { id: "struggle", label: "Struggle" }, () => phase.handleCommand(Command.FIGHT, 0));
    }

    // POKEMON (switch)
    const party = scene.getPlayerParty();
    const bc = battle.getBattlerCount();
    const allyCmd = fieldIndex > 0 ? battle.turnCommands[fieldIndex - 1] : null;
    if (!mon.isTrapped([], true)) {
      for (let s = bc; s < party.length; s++) {
        const q = party[s];
        if (q.isFainted() || !q.isAllowedInBattle() || q.isOnField()) {
          continue;
        }
        if (allyCmd?.command === Command.POKEMON && allyCmd.cursor === s) {
          continue;
        }
        this.add(
          p,
          { id: `switch:${s}`, label: `Switch to ${q.name}`, data: { slot: s, species: q.species.speciesId } },
          () => phase.handleCommand(Command.POKEMON, s, false),
        );
      }
    }

    // BALL / RUN (wild battles outside the End biome; End-biome mons are uncatchable in Endless)
    if (battle.battleType === BattleType.WILD && scene.arena.biomeId !== BiomeId.END) {
      const foes = scene.getEnemyField().filter(e => e.isActive(true));
      if (foes.length === 1) {
        const foe = foes[0];
        const shielded = foe.isBoss() && foe.bossSegmentIndex >= 1;
        for (const t of [PokeballType.POKEBALL, PokeballType.GREAT_BALL, PokeballType.ULTRA_BALL, PokeballType.ROGUE_BALL, PokeballType.MASTER_BALL]) {
          const count = (scene.pokeballCounts as Record<number, number>)[t] ?? 0;
          if (count <= 0 || (shielded && t !== PokeballType.MASTER_BALL)) {
            continue;
          }
          this.add(p, { id: `ball:${t}`, label: `Throw ${enumName(PokeballType, t)}`, data: { ball: t, count } }, () =>
            phase.handleCommand(Command.BALL, t),
          );
        }
      }
      if (!mon.isTrapped([], true)) {
        this.add(p, { id: "run", label: "Run" }, () => phase.handleCommand(Command.RUN, 0));
      }
    }
    return p;
  }

  private targetDecision(phase: any, h: AnyHandler): Pending | null {
    const targets: number[] = h.targets ?? [];
    const field = this.scene.getField();
    const p = this.base(phase, "target", { context: { moveId: h.move, move: allMoves[h.move]?.name } });
    if (h.isMultipleTargets) {
      this.add(p, { id: "target:all", label: "All targets" }, () => h.processInput(Button.ACTION));
      return p;
    }
    for (const t of targets) {
      this.add(p, { id: `target:${t}`, label: field[t]?.name ?? `battler ${t}`, data: { battlerIndex: t } }, () => {
        h.setCursor(t);
        return h.processInput(Button.ACTION);
      });
    }
    return p;
  }

  private rewardDecision(phase: any, h: AnyHandler): Pending {
    const scene = this.scene;
    const party = scene.getPlayerParty();
    const p = this.base(phase, "reward", { context: { money: scene.money } });
    const press = (row: number, col: number) => () => {
      h.rowCursor = row;
      h.cursor = col;
      h.processInput(Button.ACTION);
      return true;
    };
    const hasTarget = (type: any): boolean => {
      if (!(type instanceof PokemonModifierType)) {
        return true;
      }
      const f = (type as any).selectFilter as ((q: PlayerPokemon) => string | null) | undefined;
      const passes = party.filter(q => !f || f(q) == null);
      if (type instanceof FusePokemonModifierType) {
        return passes.length >= 2;
      }
      if (type instanceof PokemonMoveModifierType) {
        const mf = (type as any).moveSelectFilter as ((m: any) => string | null) | undefined;
        return passes.some(q => q.getMoveset().some(m => m && (!mf || mf(m) == null)));
      }
      return passes.length > 0;
    };
    const options = (phase.typeOptions ?? []) as any[];
    options.forEach((o, i) => {
      if (!hasTarget(o.type)) {
        return;
      }
      this.add(p, { id: `reward:${i}`, label: o.type.name, data: { typeId: o.type.id, tier: o.type.tier, desc: describe(o.type) } }, press(1, i));
    });
    if (scene.gameMode.getShopStatus()) {
      const shop = getPlayerShopModifierTypeOptionsForWave(scene.currentBattle.waveIndex, scene.getWaveMoneyAmount(1));
      shop.forEach((o, k) => {
        const cost = new NumberHolder(o.cost);
        scene.applyModifier(HealShopCostModifier, true, cost);
        if (scene.money < cost.value || !hasTarget(o.type)) {
          return;
        }
        // Shop rows sit below the rewards: one row -> rowCursor 2; two rows -> 3 is the first, 2 the second.
        const [row, col] = shop.length <= SHOP_OPTIONS_ROW_LIMIT ? [2, k] : k < SHOP_OPTIONS_ROW_LIMIT ? [3, k] : [2, k - SHOP_OPTIONS_ROW_LIMIT];
        this.add(p, { id: `shop:${k}`, label: `Buy ${o.type.name}`, data: { typeId: o.type.id, cost: cost.value, desc: describe(o.type) } }, press(row, col));
      });
    }
    const reroll = phase.getRerollCost(scene.lockModifierTiers);
    if (reroll >= 0 && scene.money >= reroll) {
      this.add(p, { id: "reroll", label: `Reroll (${reroll})`, data: { cost: reroll } }, press(0, 0));
    }
    this.add(p, { id: "skip", label: "Skip reward" }, () => {
      this.pendingSkip = true;
      h.processInput(Button.CANCEL);
      return true;
    });
    // Appended last so older runs' action indices are unchanged.
    if (this.has("item_transfer") && this.transferSources().length) {
      this.add(p, { id: "transfer", label: "Manage Items", data: { desc: "Manage Pokémon held items (Transfer)." } }, () => {
        this.xfer = {};
        return press(0, 1)();
      });
    }
    return p;
  }

  // ---------------------------------------------------------------- held-item transfer

  /** Transferable held items of party member s, in the order the transfer screen / phase callback index them. */
  private heldTransferable(s: number): PokemonHeldItemModifier[] {
    const q = this.scene.getPlayerParty()[s];
    if (!q) {
      return [];
    }
    return this.scene.findModifiers(m => m instanceof PokemonHeldItemModifier && m.isTransferable && m.pokemonId === q.id) as PokemonHeldItemModifier[];
  }

  /** Can target slot t take at least one of `item` (the transfer screen's "Able" / "Not able")? */
  private canTake(item: PokemonHeldItemModifier, t: number): boolean {
    const q = this.scene.getPlayerParty()[t];
    if (!q || q.id === item.pokemonId) {
      return false;
    }
    const match = this.scene.findModifier(m => m instanceof PokemonHeldItemModifier && m.pokemonId === q.id && m.matchType(item)) as PokemonHeldItemModifier | undefined;
    return !match || match.getCountUnderMax() > 0;
  }

  private targetsFor(from: number, item: number | "all"): number[] {
    const items = this.heldTransferable(from);
    const list = item === "all" ? items : [items[item]].filter(Boolean);
    return this.scene
      .getPlayerParty()
      .map((_, t) => t)
      .filter(t => t !== from && list.some(it => this.canTake(it, t)));
  }

  /** Party slots holding at least one item that some other member can take. */
  private transferSources(): number[] {
    const party = this.scene.getPlayerParty();
    if (party.length < 2) {
      return [];
    }
    return party.map((_, s) => s).filter(s => this.heldTransferable(s).some((_, i) => this.targetsFor(s, i).length > 0));
  }

  /**
   * The live transfer screen, one pick per decision: source mon -> item (or All) -> quantity (stacks)
   * -> target mon. "back" undoes the last pick (the B button); "cancel" (Done) returns to the rewards.
   * A finished transfer stays on the transfer screen, as in the game, so several can be made.
   */
  private transferDecision(phase: any, h: AnyHandler): Pending {
    const party = this.scene.getPlayerParty();
    if (this.xfer.from != null && !this.transferSources().includes(this.xfer.from)) {
      this.xfer = {};
    }
    const x = this.xfer;
    const stage = x.from == null ? "from" : x.item == null ? "item" : x.item !== "all" && x.qty == null && (this.heldTransferable(x.from)[x.item]?.getStackCount() ?? 1) > 1 ? "qty" : "to";
    const items = x.from == null ? [] : this.heldTransferable(x.from);
    const itemInfo = (it: PokemonHeldItemModifier) => ({ name: safeName(it), count: it.getStackCount(), typeId: (it.type as any)?.id });
    const p = this.base(phase, "party", {
      sub: "MODIFIER_TRANSFER",
      prompt: stage === "from" ? "Choose a Pokémon. (Transfer)" : stage === "item" ? "Select a held item to transfer." : stage === "qty" ? "How many to transfer?" : "Transfer to which Pokémon?",
      context: { stage, from: x.from, item: x.item, qty: x.qty, items: items.map(itemInfo) },
    });
    const back = (to: typeof x) => this.add(p, { id: "back", label: "Back" }, () => ((this.xfer = to), true));
    if (stage === "from") {
      for (const s of this.transferSources()) {
        this.add(p, { id: `xfer_from:${s}`, label: party[s].name, data: { slot: s, species: party[s].species.speciesId, items: this.heldTransferable(s).map(itemInfo) } }, () => ((this.xfer = { from: s }), true));
      }
      this.add(p, { id: "cancel", label: "Done" }, () => {
        this.xfer = {};
        return callOnce(h, "selectCallback", 6, PartyOption.CANCEL);
      });
      return p;
    }
    const from = x.from!;
    if (stage === "item") {
      items.forEach((it, i) => {
        if (this.targetsFor(from, i).length) {
          this.add(p, { id: `xfer_item:${i}`, label: `${safeName(it)} x${it.getStackCount()}`, data: itemInfo(it) }, () => ((this.xfer = { from, item: i }), true));
        }
      });
      if (items.length > 1) {
        this.add(p, { id: "xfer_item:all", label: "All" }, () => ((this.xfer = { from, item: "all" }), true));
      }
      back({});
      return p;
    }
    if (stage === "qty") {
      const max = items[x.item as number].getStackCount();
      for (let n = max; n >= 1; n--) {
        this.add(p, { id: `xfer_qty:${n}`, label: `x${n}`, data: { qty: n } }, () => ((this.xfer = { ...x, qty: n }), true));
      }
      back({ from });
      return p;
    }
    // stage "to"
    for (const t of this.targetsFor(from, x.item!)) {
      this.add(p, { id: `xfer_to:${t}`, label: `Give to ${party[t].name}`, data: { slot: t, species: party[t].species.speciesId } }, () => {
        const cb = h.selectCallback;
        if (typeof cb !== "function") {
          return false;
        }
        if (x.item === "all") {
          // PartyUiHandler.processTransferOption: every item, full stacks, last index first.
          const maxes = items.map(it => it.getStackCount());
          for (let i = items.length - 1; i >= 0; i--) {
            cb(from, i, maxes[i], t);
          }
        } else {
          cb(from, x.item, x.qty ?? items[x.item as number].getStackCount(), t);
        }
        this.xfer = {};
        return true;
      });
    }
    back(x.item !== "all" && x.qty != null && items[x.item as number]?.getStackCount() > 1 ? { from, item: x.item } : { from });
    return p;
  }

  private partyDecision(phase: any, h: AnyHandler): Pending {
    const scene = this.scene;
    const party = scene.getPlayerParty();
    const mode: PartyUiMode = h.partyUiMode;
    const filter = h.selectFilter as (q: PlayerPokemon) => string | null;
    const ok = (q: PlayerPokemon) => {
      try {
        return !filter || filter(q) == null;
      } catch {
        return false;
      }
    };
    const call =
      (...args: unknown[]) =>
      () => {
        const cb = h.selectCallback;
        h.selectCallback = null;
        cb(...args);
        return true;
      };
    const p = this.base(phase, "party", { sub: enumName(PartyUiMode, mode) });
    const cancel = (label = "Cancel") => this.add(p, { id: "cancel", label }, call(6, PartyOption.CANCEL));
    const slots = (option: PartyOption, from = 0) => {
      for (let s = from; s < party.length; s++) {
        if (ok(party[s])) {
          this.add(p, { id: `slot:${s}`, label: party[s].name, data: { slot: s, species: party[s].species.speciesId } }, call(s, option));
        }
      }
    };
    switch (mode) {
      case PartyUiMode.FAINT_SWITCH:
      case PartyUiMode.POST_BATTLE_SWITCH: {
        const bc = scene.currentBattle.getBattlerCount();
        let baton = false;
        try {
          baton = !!h.isBatonPassMove?.();
        } catch {
          /* not a baton pass */
        }
        for (let s = bc; s < party.length; s++) {
          const q = party[s];
          if (ok(q) && !q.isFainted() && q.isAllowedInBattle()) {
            this.add(p, { id: `slot:${s}`, label: `Send out ${q.name}`, data: { slot: s, species: q.species.speciesId } }, call(s, baton ? PartyOption.PASS_BATON : PartyOption.SEND_OUT));
          }
        }
        if (mode === PartyUiMode.POST_BATTLE_SWITCH || p.apply.length === 0) {
          cancel("Keep current");
        }
        return p;
      }
      case PartyUiMode.MODIFIER:
      case PartyUiMode.EVOLUTION_ITEM_MODIFIER:
      case PartyUiMode.FORM_CHANGE_ITEM_MODIFIER:
        slots(PartyOption.APPLY);
        break;
      case PartyUiMode.TM_MODIFIER:
        slots(PartyOption.TEACH);
        break;
      case PartyUiMode.REVIVAL_BLESSING:
        slots(PartyOption.REVIVE);
        break;
      case PartyUiMode.SELECT:
        slots(PartyOption.SELECT);
        break;
      case PartyUiMode.RELEASE:
        party.forEach((q, s) => {
          this.add(p, { id: `slot:${s}`, label: `Release ${q.name}`, data: { slot: s, species: q.species.speciesId } }, () => releaseSlot(scene, h, s));
        });
        cancel("Don't release");
        return p;
      case PartyUiMode.MOVE_MODIFIER: {
        const mf = h.moveSelectFilter as (m: any) => string | null;
        party.forEach((q, s) => {
          if (!ok(q)) {
            return;
          }
          q.getMoveset().forEach((m, mi) => {
            if (m && (!mf || mf(m) == null)) {
              this.add(p, { id: `slot:${s}/move:${mi}`, label: `${q.name}: ${m.getName()}`, data: { slot: s, move: mi } }, call(s, PartyOption.MOVE_1 + mi));
            }
          });
        });
        break;
      }
      case PartyUiMode.REMEMBER_MOVE_MODIFIER:
        party.forEach((q, s) => {
          if (!ok(q)) {
            return;
          }
          const learnable = (q.getLearnableLevelMoves?.() ?? []) as unknown[];
          learnable.forEach((entry, k) => {
            const moveId = Array.isArray(entry) ? (entry[1] as number) : (entry as number);
            this.add(p, { id: `slot:${s}/relearn:${k}`, label: `${q.name}: ${allMoves[moveId]?.name ?? moveId}`, data: { slot: s, moveId } }, call(s, k));
          });
        });
        break;
      case PartyUiMode.SPLICE:
        party.forEach((a, i) => {
          party.forEach((b, j) => {
            if (i !== j && ok(a) && ok(b)) {
              this.add(p, { id: `splice:${i}+${j}`, label: `Splice ${a.name} + ${b.name}`, data: { from: i, into: j } }, call(i, j));
            }
          });
        });
        break;
      default:
        // CHECK / MODIFIER_TRANSFER / DISCARD etc. are never opened by this driver; back out.
        cancel();
        return p;
    }
    if (p.apply.length === 0) {
      cancel();
    }
    return p;
  }

  private learnDecision(phase: any, h: AnyHandler): Pending {
    const mon = phase.getPokemon() as PlayerPokemon;
    const move = allMoves[phase.moveId];
    // Without learn_confirm (runs logged before it) this confirm was shown as another learn_move decision
    // whose "keep" answered No and re-asked; kept as-is so those runs replay exactly.
    if (phase[STOP_TEACHING] && this.has("learn_confirm")) {
      // LearnMovePhase.rejectMoveAndEnd: "Stop trying to teach X?" Yes = give up, No = back to the replace question.
      const p = this.base(phase, "learn_move", {
        sub: "stop_teaching",
        prompt: `Stop trying to teach ${move?.name}?`,
        context: { slot: phase.partyMemberIndex, moveId: phase.moveId, move: move?.name, type: move?.type, power: move?.power, accuracy: move?.accuracy, category: move?.category },
      });
      this.add(p, { id: "stop", label: `Yes: ${mon.name} doesn't learn ${move?.name}` }, () => pickOption(h, 0));
      this.add(p, { id: "retry", label: "No: choose a move to forget" }, () => pickOption(h, 1));
      return p;
    }
    const p = this.base(phase, "learn_move", {
      prompt: `${mon.name} wants to learn ${move?.name}`,
      context: { slot: phase.partyMemberIndex, moveId: phase.moveId, move: move?.name, type: move?.type, power: move?.power, accuracy: move?.accuracy, category: move?.category },
    });
    mon.getMoveset().forEach((m, i) => {
      if (!m) {
        return;
      }
      this.add(p, { id: `forget:${i}`, label: `Forget ${m.getName()}`, data: { moveId: m.moveId } }, () => {
        this.pendingForget = i;
        return pickOption(h, 0);
      });
    });
    this.add(p, { id: "keep", label: `Don't learn ${move?.name}` }, () => pickOption(h, 1));
    return p;
  }

  private forgetDecision(phase: any, h: AnyHandler): Pending {
    const mon = phase.getPokemon() as PlayerPokemon;
    const p = this.base(phase, "forget_move", { context: { moveId: phase.moveId } });
    mon.getMoveset().forEach((m, i) => {
      if (m) {
        this.add(p, { id: `forget:${i}`, label: `Forget ${m.getName()}` }, () => callOnce(h, "moveSelectFunction", i));
      }
    });
    this.add(p, { id: "keep", label: "Don't learn" }, () => callOnce(h, "moveSelectFunction", 4));
    return p;
  }

  private optionDecision(phase: any, name: string, h: AnyHandler): Pending {
    const opts = h.options as any[];
    // Caught a mon with a full party: menu is [Summary, Pokedex, Yes (pick one to release), No].
    if (name === "AttemptCapturePhase" && opts.length === 4) {
      const party = this.scene.getPlayerParty();
      const caught = this.scene.getEnemyField().find(e => e.isActive(true)) ?? this.scene.getEnemyPokemon(false);
      const p = this.base(phase, "catch_full", { context: { caught: caught?.name, species: caught?.species?.speciesId, level: caught?.level } });
      party.forEach((q, s) => {
        this.add(p, { id: `release:${s}`, label: `Release ${q.name} to keep ${caught?.name ?? "new mon"}`, data: { slot: s } }, () => {
          this.pendingRelease = s;
          return pickOption(h, 2);
        });
      });
      this.add(p, { id: "keep_party", label: `Don't keep ${caught?.name ?? "new mon"}` }, () => pickOption(h, 3));
      return p;
    }
    const kind: DecisionKind = name === "SelectBiomePhase" ? "biome" : "option";
    const p = this.base(phase, kind, { sub: name, prompt: lastText(this.scene) });
    opts.forEach((o, i) => {
      if (o.selectable === false || INFO_LABELS.test(String(o.label ?? "").trim())) {
        return;
      }
      this.add(p, { id: `opt:${i}`, label: String(o.label ?? i) }, () => pickOption(h, i));
    });
    return p;
  }
}

// -------------------------------------------------------------------- helpers

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Advance the mocked Phaser clock by one tick (the harness's MockClock fires every timer at 1ms). */
function pumpClock(scene: BattleScene): void {
  const clock = scene.time as unknown as { preUpdate: () => void; update: (t: number, d: number) => void; systems?: any };
  try {
    clock.preUpdate();
    clock.update(clock.systems?.game?.loop?.time ?? 0, 1);
  } catch {
    /* clock not ready yet */
  }
}

/**
 * Release party slot s in PartyUiMode.RELEASE the way PartyUiHandler.doRelease does
 * (remove its items, drop it from the party, then hand the cursor to the phase callback),
 * minus the goodbye text box.
 */
function releaseSlot(scene: BattleScene, h: AnyHandler, s: number): boolean {
  const party = scene.getPlayerParty();
  if (s < 0 || s >= party.length) {
    return false;
  }
  scene.removePartyMemberModifiers(s);
  const released = party.splice(s, 1)[0];
  released.destroy();
  const cursor = s >= party.length ? s - 1 : s;
  const cb = h.selectCallback;
  h.selectCallback = null;
  cb?.(cursor, PartyOption.RELEASE);
  return true;
}

/** Call a one-shot UI callback field, clearing it first as the UI handler itself does. */
function callOnce(h: AnyHandler, field: string, ...args: unknown[]): boolean {
  const fn = h[field];
  if (typeof fn !== "function") {
    return false;
  }
  h[field] = null;
  fn(...args);
  return true;
}

/** Select option i of an option/confirm menu the way the UI handler does on ACTION. */
function pickOption(h: AnyHandler, i: number): boolean {
  const o = h.options?.[i];
  if (!o) {
    return false;
  }
  if (o.handler()) {
    if (!o.keepOpen) {
      h.clear?.();
    }
    return true;
  }
  return false;
}

function describe(type: any): string | undefined {
  try {
    return cleanText(type?.getDescription?.()) || undefined;
  } catch {
    return undefined;
  }
}

function cleanText(text: unknown): string {
  return String(text ?? "")
    .replace(/@\w\{[^}]*\}/g, "")
    .replace(/\[[A-Z_]+\]|\{[A-Z_]+\}/g, "")
    .replace(/\$/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function lastText(scene: BattleScene): string | undefined {
  try {
    const h = scene.ui.getMessageHandler() as AnyHandler;
    return h?.message?.text || undefined;
  } catch {
    return undefined;
  }
}

/** Animation JSON and sprite atlases are not checked out: resolve their loaders immediately. */
function stubHeadlessAssets(): void {
  BattleSceneClass.prototype.preload = async () => {};
  for (const fn of ["initMoveAnim", "loadMoveAnimAssets", "initMoveChargeAnim", "initEncounterAnims", "loadEncounterAnimAssets", "initCommonAnims", "loadCommonAnimAssets"]) {
    if (typeof (BattleAnims as any)[fn] === "function") {
      vi.spyOn(BattleAnims as any, fn).mockResolvedValue(undefined);
    }
  }
  // IV-scanner stat icons are sprites; keep only well-formed children so ScanIvsPhase can't throw.
  BattleInfo.prototype.getStatsValueContainer = function (this: BattleInfo) {
    try {
      const c = originalStatsContainer.call(this);
      return { list: ((c?.list ?? []) as any[]).filter(x => x && typeof x.name === "string") } as any;
    } catch {
      return { list: [] } as any;
    }
  };
}

function patchUi(scene: BattleScene, sink: string[]): void {
  const ui = scene.ui as any;
  // Keep a copy of every battle message so a human (or a log reader) can see what just happened.
  for (const fn of ["showText", "showDialogue"]) {
    const orig = ui[fn]?.bind(ui);
    if (orig) {
      ui[fn] = (text: unknown, ...rest: unknown[]) => {
        const clean = cleanText(text);
        if (clean && sink[sink.length - 1] !== clean) {
          sink.push(clean);
          if (sink.length > 200) {
            sink.splice(0, sink.length - 200);
          }
        }
        return orig(text, ...rest);
      };
    }
  }
  ui.fadeOut = async () => {
    ui.overlayActive = false;
  };
  ui.fadeIn = async () => {
    ui.overlayActive = false;
  };
  const tweens = scene.tweens as any;
  const addCounter = tweens.addCounter?.bind(tweens);
  if (addCounter) {
    tweens.addCounter = (data: any) => {
      try {
        data?.onUpdate?.({ getValue: () => 1 });
      } catch {
        /* visual only */
      }
      return addCounter(data);
    };
  }
}

/** Marks a LearnMovePhase while its "Stop trying to teach?" confirm (not the replace question) is up. */
const STOP_TEACHING = Symbol("stopTeaching");
let stopTeachingTracked = false;
function trackStopTeaching(): void {
  if (stopTeachingTracked) {
    return;
  }
  stopTeachingTracked = true;
  const proto = LearnMovePhase.prototype as any;
  for (const [fn, flag] of [["replaceMoveCheck", false], ["rejectMoveAndEnd", true]] as const) {
    const orig = proto[fn];
    if (typeof orig !== "function") {
      throw new Error(`LearnMovePhase.${fn} not found (game code changed?)`);
    }
    proto[fn] = function (this: any, ...args: unknown[]) {
      this[STOP_TEACHING] = flag;
      return orig.apply(this, args);
    };
  }
}

function safeName(m: { type: { name: string } }): string {
  try {
    return m.type.name;
  } catch {
    return "item";
  }
}

function blockNetwork(): void {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (/pokerogue\.net/i.test(url)) {
      throw new Error(`offline sim: blocked ${url}`);
    }
    return orig(input, init);
  }) as typeof fetch;
}

/** Starters built the way the in-game starter select does by default (level-up moves <= starting level). */
function buildStarters(scene: BattleScene, ids: number[]) {
  const level = scene.gameMode.getStartingLevel();
  return ids.map(speciesId => {
    const species = speciesDataRegistry.getSpecies(speciesId as SpeciesId);
    const mon = new PlayerPokemon(species, level, undefined, 0);
    const moves = getStarterMoves(speciesId as StarterSpeciesId, mon.formIndex).slice(0, 4);
    return {
      speciesId,
      shiny: mon.shiny,
      variant: mon.variant,
      formIndex: mon.formIndex,
      ivs: mon.ivs,
      abilityIndex: mon.abilityIndex,
      passive: false,
      nature: mon.getNature(),
      pokerus: false,
      female: mon.gender === Gender.FEMALE,
      moveset: moves.length ? (moves as any) : undefined,
    };
  });
}
