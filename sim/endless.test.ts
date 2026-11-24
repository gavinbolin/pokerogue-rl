/**
 * Vitest entry: plays one or more Endless runs in this process. Launched by scripts/run.mjs
 * (env vars below), not meant to be run by hand.
 *   SIM_OUT       absolute output dir          SIM_JOBS      comma-separated seeds
 *   SIM_MAX_WAVES stop after this many waves   SIM_POLICY    random
 *   SIM_OBS       1 = log obs + legal actions  SIM_TEAM      fixed species ids (debug)
 *   SIM_TURN_LIMIT per-wave turn cap           SIM_STYLE     set | switch
 *   SIM_STALL_MS  stall timeout                SIM_VERBOSE   1 = keep game console output
 *   SIM_CAPTURE_AUDIT 1 = write <out>/captures.jsonl: per Poke Ball throw, the game's catch inputs, the
 *                 resulting catch probability (formula below) and the outcome (read-only hooks, no RNG use)
 *   SIM_FEATURES  comma list of live features to enable (default: all); "none" = none
 *   SIM_TEST_DEX_COUNT  verification only: fake dex size (critical-capture checks need > 100)
 */
import { BattleScene } from "#app/battle-scene";
import fs from "node:fs";
import path from "node:path";
import Phaser from "phaser";
import { afterAll, beforeAll, expect, it } from "vitest";
import { EndlessEnv, isDecision } from "./env.ts";
import { decisionRecord, RunLog } from "./log.ts";
import { makePolicy } from "./policies.ts";

const intervals = new Set<ReturnType<typeof setInterval>>();
const realSetInterval = globalThis.setInterval.bind(globalThis);
globalThis.setInterval = ((h: TimerHandler, ms?: number, ...a: unknown[]) => {
  const id = realSetInterval(h, ms, ...a);
  intervals.add(id);
  return id;
}) as typeof setInterval;

let phaserGame: Phaser.Game;
let realRand: BattleScene["randBattleSeedInt"];

beforeAll(async () => {
  realRand = BattleScene.prototype.randBattleSeedInt;
  phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  if (process.env.SIM_TEST_DEX_COUNT) {
    // Verification only (never for logged training data): pretend the save has this many species caught, so
    // critical captures (which need > 100 in the dex) can be exercised. A fresh sim save has none.
    const { GameData } = await import("#system/game-data");
    const n = Number(process.env.SIM_TEST_DEX_COUNT);
    (GameData.prototype as any).getSpeciesCount = () => n;
  }
  if (process.env.SIM_CAPTURE_AUDIT === "1") {
    await installCaptureAudit(path.join(process.env.SIM_OUT || path.resolve("runs"), "captures.jsonl"));
  }
});

/**
 * Wraps AttemptCapturePhase.start / catch / failCatch to record each throw. Mirrors the phase's own math:
 * modifiedCatchRate, shakeProbability s, critical chance c; P(catch) = 1 for a Master Ball or rate >= 255,
 * else c/256 * s/65536 (one shake check) + (1 - c/256) * (s/65536)^3 (three checks).
 */
async function installCaptureAudit(file: string) {
  const { AttemptCapturePhase } = await import("#phases/attempt-capture-phase");
  const { getPokeballCatchMultiplier, getCriticalCaptureChance } = await import("#data/pokeball");
  const { getStatusEffectCatchRateMultiplier } = await import("#data/status-effect");
  const proto = AttemptCapturePhase.prototype as any;
  const { start, catch: doCatch, failCatch } = proto;
  const write = (rec: object) => fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
  proto.start = function (this: any) {
    const p = this.getPokemon();
    if (p?.hp) {
      const m3 = 3 * p.getMaxHp();
      const ballMult = getPokeballCatchMultiplier(this.pokeballType);
      const statusMult = p.status ? getStatusEffectCatchRateMultiplier(p.status.effect) : 1;
      const shiny = p.isShiny();
      const mcr = Math.round((((m3 - 2 * p.hp) * p.species.catchRate * ballMult) / m3) * statusMult);
      const s = Math.round(65536 / Math.pow(255 / mcr, 0.1875));
      const c = getCriticalCaptureChance(mcr);
      const q = Math.min(s / 65536, 1);
      const expected = ballMult === -1 || mcr >= 255 ? 1 : (c / 256) * q + (1 - c / 256) * q ** 3;
      this.__audit = { ball: this.pokeballType, catchRate: p.species.catchRate, hpFrac: p.hp / p.getMaxHp(), status: p.status?.effect ?? 0,
        statusMult, ballMult, shiny, boss: !!p.isBoss?.(), level: p.level, mcr, shakeProb: s, critChance: c, expected };
    }
    return start.call(this);
  };
  proto.catch = function (this: any) {
    if (this.__audit) {
      write({ ...this.__audit, caught: true });
      this.__audit = null;
    }
    return doCatch.call(this);
  };
  proto.failCatch = function (this: any, shakes: number) {
    if (this.__audit) {
      write({ ...this.__audit, caught: false, shakes });
      this.__audit = null;
    }
    return failCatch.call(this, shakes);
  };
}

afterAll(() => {
  for (const id of intervals) {
    clearInterval(id);
  }
  phaserGame?.destroy(true);
});

const say = (s: string) => process.stdout.write(`[endless] ${s}\n`);

it("plays endless", async () => {
  const out = process.env.SIM_OUT || path.resolve("runs");
  const seeds = (process.env.SIM_JOBS || "1").split(",").filter(Boolean);
  const maxWaves = process.env.SIM_MAX_WAVES ? Number(process.env.SIM_MAX_WAVES) : null;
  const policyName = process.env.SIM_POLICY || "random";
  const withObs = process.env.SIM_OBS !== "0";
  const team = process.env.SIM_TEAM ? process.env.SIM_TEAM.split(",").map(Number) : null;
  const pin = (() => {
    try {
      return fs.readFileSync(path.join(process.env.SIM_ROOT || "", "pokerogue.pin"), "utf8").match(/^commit=(.+)$/m)?.[1]?.trim();
    } catch {
      return undefined;
    }
  })();

  const quiet = process.env.SIM_VERBOSE !== "1";
  const saved = { log: console.log, info: console.info, debug: console.debug, warn: console.warn };
  const mute = () => {
    if (quiet) {
      console.log = console.info = console.debug = console.warn = () => {};
    }
  };
  const unmute = () => Object.assign(console, saved);

  for (const seed of seeds) {
    const log = new RunLog(out, `endless_seed${seed}_${policyName}`);
    const opts = {
      seed,
      maxWaves,
      team,
      pointCap: 15,
      withObs,
      turnLimit: Number(process.env.SIM_TURN_LIMIT || 300),
      battleStyle: (process.env.SIM_STYLE === "switch" ? "switch" : "set") as "set" | "switch",
      stallMs: Number(process.env.SIM_STALL_MS || 30000),
      maxDecisionsPerWave: Number(process.env.SIM_MAX_DECISIONS_PER_WAVE || 1500),
      onWave: (w: Record<string, unknown>) => log.write({ t: "wave", ...w }),
    };
    const featEnv = process.env.SIM_FEATURES;
    const features = featEnv ? (featEnv === "none" ? [] : featEnv.split(",")) : undefined;
    const env = new EndlessEnv(phaserGame, realRand, { ...opts, features });
    const policy = makePolicy(policyName, seed);
    log.write({ t: "start", seed, policy: policyName, gamePin: pin, mode: "ENDLESS", team: env.team, maxWaves, turnLimit: opts.turnLimit, battleStyle: opts.battleStyle, withObs, features: env.features });
    say(`seed=${seed} team=${env.team.speciesIds.join(",")} (${env.team.points}/${env.team.cap} pts)`);

    mute();
    let result;
    try {
      let d = await env.reset();
      while (isDecision(d)) {
        const i = await policy(d);
        const a = d.actions[i];
        const rec = decisionRecord(d, i, withObs);
        log.write(rec);
        const next = await env.step(i);
        if (env.lastDecisionRejected) {
          log.write({ t: "rej", step: d.step, action: a.id });
        }
        d = next;
      }
      result = d;
    } catch (error) {
      unmute();
      say(`seed=${seed} CRASH ${error instanceof Error ? error.stack : error}`);
      log.write({ t: "end", cause: `crash: ${error instanceof Error ? error.message : error}` });
      log.flush();
      fs.appendFileSync(path.join(out, "summary.jsonl"), `${JSON.stringify({ seed, policy: policyName, cause: "crash", error: String(error) })}\n`);
      continue;
    }
    unmute();
    log.write({ t: "end", ...result });
    log.flush();
    const dps = result.decisions / Math.max(1e-9, result.playSeconds);
    const wps = result.wavesCleared / Math.max(1e-9, result.playSeconds);
    const summary = { seed, policy: policyName, team: env.team.speciesIds, ...result, decisionsPerSec: dps, wavesPerSec: wps, log: path.basename(log.file) };
    fs.appendFileSync(path.join(out, "summary.jsonl"), `${JSON.stringify(summary)}\n`);
    say(
      `seed=${seed} cause=${result.cause} wave=${result.wave} cleared=${result.wavesCleared} decisions=${result.decisions} ` +
        `forced=${result.forced} auto=${result.autoSteps} rejected=${result.rejected} boot=${result.bootSeconds.toFixed(1)}s ` +
        `play=${result.playSeconds.toFixed(1)}s dec/s=${dps.toFixed(1)} waves/s=${wps.toFixed(2)}`,
    );
    expect(result.cause.length).toBeGreaterThan(0);
  }
});
