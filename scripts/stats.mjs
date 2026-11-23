/**
 * Summarize a run folder: outcomes, waves cleared, and per decision type the count and
 * legal-action-count distribution, plus which action families were chosen.
 *   node scripts/stats.mjs runs/<folder>
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.resolve(root, process.argv[2] ?? "runs");
const files = fs.readdirSync(dir).filter(f => /^endless_seed.*\.jsonl$/.test(f));
const kinds = new Map();
const families = new Map();
const causes = new Map();
const cleared = [];
let rejected = 0;
for (const f of files) {
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, f)), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) {
      continue;
    }
    const o = JSON.parse(line);
    if (o.t === "d") {
      const k = o.sub ? `${o.kind}/${o.sub}` : o.kind;
      if (!kinds.has(k)) {
        kinds.set(k, []);
      }
      kinds.get(k).push(o.n);
      const fam = `${o.kind}:${String(o.action).split(/[:/]/)[0]}`;
      families.set(fam, (families.get(fam) ?? 0) + 1);
    } else if (o.t === "rej") {
      rejected++;
    } else if (o.t === "end") {
      const c = String(o.cause).split(":")[0];
      causes.set(c, (causes.get(c) ?? 0) + 1);
      if (typeof o.wavesCleared === "number") {
        cleared.push(o.wavesCleared);
      }
    }
  }
}
const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
const mean = a => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
console.log(`${files.length} runs  causes=${JSON.stringify(Object.fromEntries(causes))}  rejected actions=${rejected}`);
if (cleared.length) {
  console.log(`waves cleared: mean=${mean(cleared).toFixed(2)} median=${q(cleared, 0.5)} p90=${q(cleared, 0.9)} max=${Math.max(...cleared)}`);
}
console.log("\ndecision type                         count   legal: mean  median  min  max");
for (const [k, v] of [...kinds].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${k.padEnd(36)} ${String(v.length).padStart(6)}   ${mean(v).toFixed(1).padStart(10)}  ${String(q(v, 0.5)).padStart(6)}  ${String(Math.min(...v)).padStart(3)}  ${String(Math.max(...v)).padStart(3)}`);
}
console.log("\nchosen action families:");
for (const [k, v] of [...families].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(28)} ${v}`);
}
