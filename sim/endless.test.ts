/**
 * Vitest entry: plays one or more Endless runs in this process. Launched by scripts/run.mjs
 * (env vars below), not meant to be run by hand.
 *   SIM_OUT       absolute output dir          SIM_JOBS      comma-separated seeds
 *   SIM_MAX_WAVES stop after this many waves   SIM_POLICY    random
 *   SIM_OBS       1 = log obs + legal actions  SIM_TEAM      fixed species ids (debug)
 *   SIM_TURN_LIMIT per-wave turn cap           SIM_STYLE     set | switch
 *   SIM_STALL_MS  stall timeout                SIM_VERBOSE   1 = keep game console output
 */
import { BattleScene } from "#app/battle-scene";
import fs from "node:fs";
import path from "node:path";
import Phaser from "phaser";
import { afterAll, beforeAll, expect, it } from "vitest";
import { EndlessEnv, isDecision } from "./env.ts";
import { RunLog } from "./log.ts";
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

beforeAll(() => {
  realRand = BattleScene.prototype.randBattleSeedInt;
  phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
});

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
      onWave: (w: Record<string, unknown>) => log.write({ t: "wave", ...w }),
    };
    const env = new EndlessEnv(phaserGame, realRand, opts);
    const policy = makePolicy(policyName, seed);
    log.write({ t: "start", seed, policy: policyName, gamePin: pin, mode: "ENDLESS", team: env.team, maxWaves, turnLimit: opts.turnLimit, battleStyle: opts.battleStyle, withObs });
    say(`seed=${seed} team=${env.team.speciesIds.join(",")} (${env.team.points}/${env.team.cap} pts)`);

    mute();
    let result;
    try {
      let d = await env.reset();
      while (isDecision(d)) {
        const i = await policy(d);
        const a = d.actions[i];
        const rec: Record<string, unknown> = {
          t: "d",
          step: d.step,
          wave: d.wave,
          turn: d.turn,
          kind: d.kind,
          sub: d.sub,
          phase: d.phase,
          n: d.actions.length,
          chosen: i,
          action: a.id,
          label: a.label,
        };
        if (withObs) {
          rec.actions = d.actions;
          rec.context = d.context;
          rec.prompt = d.prompt;
          rec.obs = d.obs;
        }
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
