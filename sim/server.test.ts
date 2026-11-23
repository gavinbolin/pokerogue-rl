/**
 * Long-lived sim server: ONE vitest process that keeps the headless game loaded and plays any number
 * of Endless runs on request, so the ~20 s vitest/game cold start is paid once.
 * Launched by scripts/serve.mjs / scripts/play.mjs (SIM_ENTRY=server), not by hand.
 *
 * Two transports, both bound to 127.0.0.1 only, same commands:
 *   - TCP JSON-lines (SIM_TCP_PORT): one JSON request per line -> one JSON response per line.
 *     Meant for the Python Gym env (RL) and scripts. Optional "id" is echoed back.
 *   - HTTP (SIM_HTTP_PORT): POST /api with a JSON body; GET / serves the human play UI from ui/.
 *
 * Commands ({"cmd": ...}):
 *   ping                                   -> session, game pin, current run id
 *   starters                               -> [{id, name, cost}] every starter, for team building
 *   preview {seed}                         -> the seeded random team that seed would draw
 *   reset {seed?, team?, policy?, log?, obs?, maxWaves?, out?}
 *                                          -> start a run; returns the first decision (or end)
 *   step {index, expect?}                  -> apply legal action #index (expect = its id, checked)
 *   state                                  -> the current decision / end again (no side effects)
 *   runs {policy?}                         -> list logged runs under runs/<policy> (default human)
 *   review {runId, policy?}                -> a logged run's records without obs, for review
 *   resume {runId, policy?}                -> replay a logged unfinished run to where it stopped, keep logging
 *   detach                                 -> stop the current run without an end record (resumable)
 *   abandon                                -> end the current run with cause "abandoned"
 *   shutdown                               -> stop the server
 *   reset/resume also take visual: true|false (default true for policy human) to attach a `visual` block
 *   (sprite paths, icons, EXP bars, effectiveness hints) for the play UI. It is never logged.
 * Responses: {ok: true, ...} or {ok: false, error}. A decision response carries
 *   {runId, seed, team, decision: {step, kind, sub, phase, wave, turn, prompt, context, actions, obs},
 *    messages: [battle text since the previous response]} and an ended run carries {end: EndInfo}.
 */
import { BattleScene } from "#app/battle-scene";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import type { SpeciesId } from "#enums/species-id";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import Phaser from "phaser";
import { afterAll, beforeAll, it } from "vitest";
import { type Decision, type EndInfo, EndlessEnv, isDecision } from "./env.ts";
import { decisionRecord, RunLog } from "./log.ts";
import { drawTeam } from "./team.ts";
import { visualize } from "./visual.ts";

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

const ROOT = process.env.SIM_ROOT || path.resolve("..", "..");
const RUNS = path.join(ROOT, "runs");
const UI_DIR = path.join(ROOT, "ui");
const ASSETS_DIR = path.join(ROOT, "vendor", "pokerogue-assets");
const POINT_CAP = 15;
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const SESSION = `s${stamp()}-${process.pid}`;
const PIN = (() => {
  try {
    return fs.readFileSync(path.join(ROOT, "pokerogue.pin"), "utf8").match(/^commit=(.+)$/m)?.[1]?.trim();
  } catch {
    return undefined;
  }
})();
const say = (s: string) => process.stdout.write(`[server] ${s}\n`);

const quiet = process.env.SIM_VERBOSE !== "1";
const savedConsole = { log: console.log, info: console.info, debug: console.debug, warn: console.warn };
async function muted<T>(fn: () => Promise<T> | T): Promise<T> {
  if (quiet) {
    console.log = console.info = console.debug = console.warn = () => {};
  }
  try {
    return await fn();
  } finally {
    Object.assign(console, savedConsole);
  }
}

class ApiError extends Error {}
const fail = (msg: string): never => {
  throw new ApiError(msg);
};
const safeName = (s: string) => /^[\w.+-]{1,120}$/.test(s);

// ------------------------------------------------------------------ starters / teams

interface Starter {
  id: number;
  name: string;
  cost: number;
}
let starterCache: Starter[] | null = null;
function starters(): Starter[] {
  if (!starterCache) {
    starterCache = (speciesDataRegistry.getAllStarters() as number[])
      .map(id => ({
        id,
        name: String(speciesDataRegistry.getSpecies(id as SpeciesId)?.name ?? id),
        cost: Number(speciesDataRegistry.getStarterCost(id as SpeciesId)) || 0,
      }))
      .filter(s => s.cost > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  return starterCache;
}
const starterName = (id: number) => starters().find(s => s.id === id)?.name ?? String(id);

function validateTeam(ids: unknown): number[] {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 6) {
    fail("team must be 1-6 starter species ids");
  }
  const list = (ids as unknown[]).map(Number);
  const byId = new Map(starters().map(s => [s.id, s]));
  if (new Set(list).size !== list.length) {
    fail("team has duplicate species");
  }
  let pts = 0;
  for (const id of list) {
    const s = byId.get(id);
    if (!s) {
      fail(`${id} is not a starter`);
    }
    pts += s!.cost;
  }
  if (pts > POINT_CAP) {
    fail(`team costs ${pts} points; the Endless cap is ${POINT_CAP}`);
  }
  return list;
}

// ------------------------------------------------------------------ the one active run

interface RunOptions {
  seed: string;
  team: number[] | null;
  policy: string;
  maxWaves: number | null;
  withObs: boolean;
  battleStyle: "set" | "switch";
  turnLimit: number;
  /** attach presentation data (sprites, icons, effectiveness) to responses; default on for human play */
  visual: boolean;
}

class Run {
  readonly env: EndlessEnv;
  current: Decision | EndInfo | null = null;
  log: RunLog | null = null;
  readonly runId: string | null;
  readonly startedAt = Date.now();

  constructor(
    readonly o: RunOptions,
    runId: string | null,
    readonly dir: string | null,
  ) {
    this.runId = runId;
    this.env = new EndlessEnv(phaserGame, realRand, {
      seed: o.seed,
      maxWaves: o.maxWaves,
      team: o.team,
      pointCap: POINT_CAP,
      withObs: o.withObs,
      turnLimit: o.turnLimit,
      battleStyle: o.battleStyle,
      stallMs: 30000,
      maxDecisionsPerWave: 1500,
      onWave: w => this.log?.write({ t: "wave", ...w }),
    });
  }

  get teamInfo() {
    const t = this.env.team;
    return { speciesIds: t.speciesIds, names: t.speciesIds.map(starterName), costs: t.costs, points: t.points, cap: t.cap };
  }

  view(extra: Record<string, unknown> = {}) {
    const withVisual = this.o.visual;
    const base = { runId: this.runId, logFile: this.log ? path.relative(ROOT, this.log.file).replace(/\\/g, "/") : null, seed: this.o.seed, policy: this.o.policy, team: this.teamInfo, messages: this.env.drainMessages(), ...extra };
    const c = this.current;
    if (!c) {
      return { ...base, decision: null };
    }
    const visual = withVisual ? visualize(this.env.sceneRef, isDecision(c) ? c : null) : undefined;
    return isDecision(c) ? { ...base, decision: c, visual } : { ...base, end: c, visual };
  }

  finish(end: EndInfo): void {
    if (!this.log) {
      return;
    }
    this.log.write({ t: "end", ...end, session: SESSION });
    this.log.flush();
    const summary = {
      runId: this.runId,
      seed: this.o.seed,
      policy: this.o.policy,
      team: this.env.team.speciesIds,
      ...end,
      log: path.basename(this.log.file),
    };
    fs.appendFileSync(path.join(this.dir!, "summary.jsonl"), `${JSON.stringify(summary)}\n`);
  }
}

let run: Run | null = null;

function runDir(policy: unknown, out?: unknown): string {
  const p = String(policy ?? "human");
  if (!safeName(p)) {
    fail("bad policy name");
  }
  if (out != null) {
    const dir = path.resolve(ROOT, String(out));
    if (!dir.startsWith(RUNS + path.sep) && dir !== RUNS) {
      fail("out must be inside runs/");
    }
    return dir;
  }
  return path.join(RUNS, p);
}

function readRecords(file: string): Record<string, any>[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(l => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Record<string, any>[];
}

function runFile(req: Record<string, any>): string {
  const id = String(req.runId ?? "");
  if (!safeName(id)) {
    fail("bad runId");
  }
  const file = path.join(runDir(req.policy ?? "human"), `${id}.jsonl`);
  if (!fs.existsSync(file)) {
    fail(`no such run: ${id}`);
  }
  return file;
}

// ------------------------------------------------------------------ commands

async function handle(req: Record<string, any>): Promise<Record<string, unknown>> {
  switch (req.cmd) {
    case "ping":
      return { session: SESSION, gamePin: PIN, runId: run?.runId ?? null, active: !!run && !!run.current && isDecision(run.current) };

    case "starters":
      return { cap: POINT_CAP, starters: starters() };

    case "preview": {
      const seed = String(req.seed ?? "1");
      const t = drawTeam(seed, POINT_CAP);
      return { seed, team: { speciesIds: t.speciesIds, names: t.speciesIds.map(starterName), costs: t.costs, points: t.points, cap: t.cap } };
    }

    case "reset": {
      if (run?.current && isDecision(run.current) && run.log) {
        run.log.flush(); // previous run stays resumable
      }
      const seed = String(req.seed ?? Math.floor(Math.random() * 1e9));
      if (!/^[\w.+-]{1,40}$/.test(seed)) {
        fail("bad seed");
      }
      const team = req.team == null || (Array.isArray(req.team) && req.team.length === 0) ? null : validateTeam(req.team);
      const policy = String(req.policy ?? "agent");
      const doLog = req.log ?? policy === "human";
      const opts: RunOptions = {
        seed,
        team,
        policy,
        maxWaves: req.maxWaves == null ? null : Number(req.maxWaves),
        withObs: req.obs !== false,
        battleStyle: req.style === "switch" ? "switch" : "set",
        turnLimit: Number(req.turnLimit ?? 300),
        visual: req.visual ?? policy === "human",
      };
      const dir = doLog ? runDir(policy, req.out) : null;
      const runId = doLog ? `${policy}-${stamp()}-seed${seed}` : null;
      run = new Run(opts, runId, dir);
      if (doLog) {
        run.log = new RunLog(dir!, runId!, { autoFlush: policy === "human" });
        run.log.write({
          t: "start",
          runId,
          session: SESSION,
          seed,
          policy,
          gamePin: PIN,
          mode: "ENDLESS",
          team: run.env.team,
          teamChosen: team != null,
          maxWaves: opts.maxWaves,
          turnLimit: opts.turnLimit,
          battleStyle: opts.battleStyle,
          withObs: opts.withObs,
          time: new Date().toISOString(),
        });
      }
      const r = run;
      r.current = await muted(() => r.env.reset());
      if (!isDecision(r.current)) {
        r.finish(r.current);
      }
      return r.view();
    }

    case "step": {
      const r = run;
      if (!r?.current || !isDecision(r.current)) {
        fail("no decision pending (reset or resume first)");
      }
      const d = r!.current as Decision;
      const i = Number(req.index);
      if (!Number.isInteger(i) || i < 0 || i >= d.actions.length) {
        fail(`index must be 0..${d.actions.length - 1}`);
      }
      if (req.expect != null && d.actions[i].id !== req.expect) {
        fail(`stale action: #${i} is ${d.actions[i].id}, not ${req.expect}`);
      }
      const t0 = Date.now();
      r!.log?.write(decisionRecord(d, i, r!.o.withObs, req.thinkMs != null ? { thinkMs: Number(req.thinkMs) } : {}));
      r!.current = await muted(() => r!.env.step(i));
      if (r!.env.lastDecisionRejected) {
        r!.log?.write({ t: "rej", step: d.step, action: d.actions[i].id });
      }
      if (!isDecision(r!.current)) {
        r!.finish(r!.current);
      }
      return r!.view({ simMs: Date.now() - t0, rejected: r!.env.lastDecisionRejected });
    }

    case "state":
      return run ? run.view() : { decision: null };

    case "runs": {
      const dir = runDir(req.policy ?? "human");
      if (!fs.existsSync(dir)) {
        return { runs: [] };
      }
      const runs = fs
        .readdirSync(dir)
        .filter(f => f.endsWith(".jsonl") && f !== "summary.jsonl")
        .map(f => {
          const recs = readRecords(path.join(dir, f));
          const start = recs.find(r => r.t === "start") ?? {};
          const end = [...recs].reverse().find(r => r.t === "end");
          const ds = recs.filter(r => r.t === "d");
          const last = ds[ds.length - 1];
          return {
            runId: start.runId ?? f.replace(/\.jsonl$/, ""),
            seed: start.seed,
            team: (start.team?.speciesIds ?? []).map(starterName),
            time: start.time ?? fs.statSync(path.join(dir, f)).mtime.toISOString(),
            decisions: ds.length,
            wave: end?.wave ?? last?.wave ?? 0,
            ended: end ? end.cause : null,
            active: run?.runId === start.runId,
          };
        })
        .sort((a, b) => String(b.time).localeCompare(String(a.time)));
      return { runs };
    }

    case "review": {
      const recs = readRecords(runFile(req));
      return {
        records: recs.map(r => {
          const { obs, actions, ...rest } = r;
          return actions ? { ...rest, options: actions.map((a: any) => a.label) } : rest;
        }),
      };
    }

    case "resume": {
      const file = runFile(req);
      const recs = readRecords(file);
      const start = recs.find(r => r.t === "start");
      if (!start) {
        fail("run has no start record");
      }
      if (recs.some(r => r.t === "end")) {
        fail("run already ended; use review");
      }
      if (start.gamePin && PIN && start.gamePin !== PIN) {
        fail(`run was recorded on game ${start.gamePin}, server is on ${PIN}`);
      }
      const opts: RunOptions = {
        seed: String(start.seed),
        team: start.teamChosen ? start.team.speciesIds : null,
        policy: String(start.policy ?? "human"),
        maxWaves: start.maxWaves ?? null,
        withObs: start.withObs !== false,
        battleStyle: start.battleStyle === "switch" ? "switch" : "set",
        turnLimit: start.turnLimit ?? 300,
        visual: req.visual ?? true,
      };
      const r = new Run(opts, start.runId, path.dirname(file));
      run = r;
      const replay = recs.filter(x => x.t === "d");
      const t0 = Date.now();
      r.current = await muted(async () => {
        let cur = await r.env.reset();
        for (const rec of replay) {
          if (!isDecision(cur)) {
            fail(`replay ended early at step ${rec.step}`);
          }
          const d = cur as Decision;
          if (d.step !== rec.step || d.actions[rec.chosen]?.id !== rec.action) {
            fail(`replay diverged at step ${rec.step} (expected ${rec.action}, got ${d.actions[rec.chosen]?.id ?? "nothing"})`);
          }
          cur = await r.env.step(rec.chosen);
        }
        return cur;
      });
      r.env.drainMessages();
      r.log = new RunLog(path.dirname(file), start.runId, { append: true, autoFlush: true });
      r.log.write({ t: "resume", session: SESSION, replayed: replay.length, time: new Date().toISOString() });
      if (!isDecision(r.current)) {
        r.finish(r.current);
      }
      return r.view({ replayed: replay.length, replayMs: Date.now() - t0 });
    }

    case "detach": {
      run?.log?.flush();
      const id = run?.runId ?? null;
      run = null;
      return { detached: id };
    }

    case "abandon": {
      const r = run;
      if (r?.current && isDecision(r.current) && r.log) {
        const wave = r.current.wave;
        r.finish({
          done: true,
          cause: "abandoned",
          wave,
          wavesCleared: Math.max(0, wave - 1),
          decisions: r.current.step,
          forced: 0,
          autoSteps: 0,
          animSkips: 0,
          rejected: 0,
          bootSeconds: 0,
          playSeconds: (Date.now() - r.startedAt) / 1000,
        });
      }
      run = null;
      return { abandoned: r?.runId ?? null };
    }

    case "shutdown":
      setTimeout(() => stop?.(), 10);
      return { bye: true };

    default:
      return fail(`unknown cmd ${req.cmd}`);
  }
}

// One game per process: serialize every command.
let chain: Promise<unknown> = Promise.resolve();
function dispatch(req: Record<string, any>): Promise<Record<string, unknown>> {
  const p = chain.then(async () => {
    try {
      return { ok: true, ...(await handle(req)) };
    } catch (error) {
      if (!(error instanceof ApiError)) {
        say(`error in ${req?.cmd}: ${error instanceof Error ? error.stack : error}`);
      }
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  chain = p.catch(() => {});
  return p;
}

// ------------------------------------------------------------------ transports

let stop: (() => void) | null = null;

const MIME: Record<string, string> = { ".png": "image/png", ".json": "application/json", ".ttf": "font/ttf", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

function httpServer(): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/api") {
      let body = "";
      req.on("data", c => {
        body += c;
        if (body.length > 1e6) {
          req.destroy();
        }
      });
      req.on("end", async () => {
        let msg: Record<string, any>;
        try {
          msg = JSON.parse(body || "{}");
        } catch {
          res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: "bad json" }));
          return;
        }
        const out = await dispatch(msg);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(out));
      });
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
      // Game art from the pinned pokerogue-assets checkout (vendor/pokerogue-assets), read-only.
      const rel = decodeURIComponent(url.pathname.slice("/assets/".length));
      const file = path.resolve(ASSETS_DIR, rel);
      if (/^(images|fonts)\//.test(rel) && file.startsWith(ASSETS_DIR + path.sep) && /\.(png|json|ttf)$/.test(file) && fs.existsSync(file)) {
        res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "public, max-age=86400" }).end(fs.readFileSync(file));
      } else {
        res.writeHead(404).end("not found");
      }
      return;
    }
    if (req.method === "GET") {
      const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (/^[\w-]+\.(html|js|css|svg)$/.test(name) && fs.existsSync(path.join(UI_DIR, name))) {
        res.writeHead(200, { "content-type": MIME[path.extname(name)], "cache-control": "no-store" }).end(fs.readFileSync(path.join(UI_DIR, name)));
        return;
      }
    }
    res.writeHead(404).end("not found");
  });
}

function tcpServer(): net.Server {
  return net.createServer(sock => {
    sock.setNoDelay(true);
    let buf = "";
    sock.on("data", async chunk => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) {
          continue;
        }
        let msg: Record<string, any>;
        try {
          msg = JSON.parse(line);
        } catch {
          sock.write(`${JSON.stringify({ ok: false, error: "bad json" })}\n`);
          continue;
        }
        const out = await dispatch(msg);
        if (msg.id !== undefined) {
          out.id = msg.id;
        }
        if (!sock.destroyed) {
          sock.write(`${JSON.stringify(out)}\n`);
        }
      }
    });
    sock.on("error", () => {});
  });
}

const listen = (srv: net.Server, port: number) =>
  new Promise<number>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => resolve((srv.address() as net.AddressInfo).port));
  });

it("serves", async () => {
  const servers: net.Server[] = [];
  const httpPort = process.env.SIM_HTTP_PORT;
  const tcpPort = process.env.SIM_TCP_PORT;
  // Warm the game up once (first boot is the slow one) so the first real reset is fast.
  await muted(() => starters());
  if (httpPort) {
    const srv = httpServer();
    const p = await listen(srv, Number(httpPort));
    servers.push(srv);
    say(`http http://127.0.0.1:${p}/`);
  }
  if (tcpPort) {
    const srv = tcpServer();
    const p = await listen(srv, Number(tcpPort));
    servers.push(srv);
    say(`tcp 127.0.0.1:${p}`);
  }
  say(`ready session=${SESSION}`);
  await new Promise<void>(resolve => {
    stop = resolve;
  });
  run?.log?.flush();
  for (const s of servers) {
    s.close();
    (s as any).closeAllConnections?.();
  }
  say("stopped");
});
