/**
 * Run headless Endless games.
 *   node scripts/run.mjs --seed 1 --runs 5 --policy random [--max-waves N] [--parallel P]
 *                        [--out runs/smoke] [--no-obs] [--team 1,4,7] [--turn-limit 300] [--style set|switch]
 * Seeds: integer --seed S with --runs K plays seeds S..S+K-1 (or pass --seeds a,b,c).
 * --out is resolved against the repo root (not the cwd). Logs: <out>/endless_seed<S>_<policy>.jsonl,
 * one line per run in <out>/summary.jsonl, printed as a table at the end.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendor = path.join(root, "vendor", "pokerogue");
const { values: v } = parseArgs({
  options: {
    seed: { type: "string", default: "1" },
    runs: { type: "string", default: "1" },
    seeds: { type: "string" },
    policy: { type: "string", default: "random" },
    "max-waves": { type: "string" },
    parallel: { type: "string", default: "1" },
    out: { type: "string" },
    "no-obs": { type: "boolean", default: false },
    team: { type: "string" },
    "turn-limit": { type: "string", default: "300" },
    style: { type: "string", default: "set" },
    "stall-ms": { type: "string", default: "30000" },
    verbose: { type: "boolean", default: false },
  },
  strict: true,
});

if (!fs.existsSync(path.join(vendor, "node_modules", "vitest"))) {
  console.error("Game not installed. Run: node scripts/setup.mjs");
  process.exit(1);
}
const seeds = v.seeds
  ? v.seeds.split(",").map(s => s.trim()).filter(Boolean)
  : Array.from({ length: Number(v.runs) }, (_, i) => (/^-?\d+$/.test(v.seed) ? String(Number(v.seed) + i) : `${v.seed}+${i}`));
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = path.resolve(root, v.out ?? path.join("runs", `${v.policy}_${stamp}`));
fs.mkdirSync(out, { recursive: true });
const parallel = Math.max(1, Math.min(seeds.length, Number(v.parallel) || 1));
const buckets = Array.from({ length: parallel }, () => []);
seeds.forEach((s, i) => buckets[i % parallel].push(s));

const vitest = path.join(vendor, "node_modules", "vitest", "vitest.mjs");
const config = path.join(root, "sim", "vitest.config.ts");
const t0 = Date.now();
console.log(`[run] ${seeds.length} run(s), ${parallel} process(es), out=${path.relative(root, out)}`);

const exits = await Promise.all(
  buckets.map(
    bucket =>
      new Promise(resolve => {
        const child = spawn(process.execPath, [vitest, "run", "--config", config], {
          cwd: vendor,
          stdio: "inherit",
          env: {
            ...process.env,
            SIM_ROOT: root,
            SIM_OUT: out,
            SIM_JOBS: bucket.join(","),
            SIM_POLICY: v.policy,
            SIM_MAX_WAVES: v["max-waves"] ?? "",
            SIM_OBS: v["no-obs"] ? "0" : "1",
            SIM_TEAM: v.team ?? "",
            SIM_TURN_LIMIT: v["turn-limit"],
            SIM_STYLE: v.style,
            SIM_STALL_MS: v["stall-ms"],
            SIM_VERBOSE: v.verbose ? "1" : "0",
            VITE_BYPASS_LOGIN: "1",
          },
        });
        child.on("exit", code => resolve(code ?? 1));
      }),
  ),
);

const wall = (Date.now() - t0) / 1000;
const rows = fs.existsSync(path.join(out, "summary.jsonl"))
  ? fs.readFileSync(path.join(out, "summary.jsonl"), "utf8").trim().split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l))
  : [];
if (rows.length) {
  console.log("\nseed  cause                     wave  cleared  decisions  play_s  dec/s  waves/s");
  for (const r of rows) {
    console.log(
      `${String(r.seed).padEnd(5)} ${String(r.cause).slice(0, 25).padEnd(25)} ${String(r.wave ?? "").padStart(4)}  ${String(r.wavesCleared ?? "").padStart(7)}  ${String(r.decisions ?? "").padStart(9)}  ${(r.playSeconds ?? 0).toFixed(1).padStart(6)}  ${(r.decisionsPerSec ?? 0).toFixed(1).padStart(5)}  ${(r.wavesPerSec ?? 0).toFixed(2).padStart(7)}`,
    );
  }
  const ok = rows.filter(r => r.playSeconds);
  const sum = k => ok.reduce((a, r) => a + (r[k] ?? 0), 0);
  if (ok.length) {
    console.log(
      `\nmean cleared=${(sum("wavesCleared") / ok.length).toFixed(1)}  total decisions=${sum("decisions")}  ` +
        `play dec/s=${(sum("decisions") / sum("playSeconds")).toFixed(1)}  play waves/s=${(sum("wavesCleared") / sum("playSeconds")).toFixed(2)}  ` +
        `mean boot=${(sum("bootSeconds") / ok.length).toFixed(1)}s  wall=${wall.toFixed(1)}s`,
    );
  }
}
process.exit(exits.find(c => c !== 0) ?? 0);
