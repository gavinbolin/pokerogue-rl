/**
 * End-to-end check of a running sim server over the TCP JSON-lines API (start it with `npm run play`).
 *   node scripts/api-check.mjs [--port 8766] [--steps 25] [--shutdown]
 * Plays a short logged "human" run with random choices, detaches, resumes it by replay, plays on,
 * abandons it, then lists and reviews it. Logs land in runs/apicheck/ (not runs/human/).
 */
import net from "node:net";
import { parseArgs } from "node:util";

const { values: v } = parseArgs({
  options: { port: { type: "string", default: "8766" }, steps: { type: "string", default: "25" }, shutdown: { type: "boolean", default: false } },
});

const sock = net.connect(Number(v.port), "127.0.0.1");
sock.setNoDelay(true);
let buf = "";
const waiting = new Map();
let nextId = 1;
sock.on("data", c => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  }
});
await new Promise((res, rej) => sock.once("connect", res).once("error", rej));

const call = (cmd, args = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, m => (m.ok ? resolve(m) : reject(new Error(`${cmd}: ${m.error}`))));
    sock.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
  });
const check = (cond, what) => {
  if (!cond) {
    throw new Error(`CHECK FAILED: ${what}`);
  }
  console.log(`  ok  ${what}`);
};
let rng = 12345;
const rand = n => {
  rng = (rng * 1103515245 + 12345) % 2147483648;
  return rng % n;
};
const show = r => (r.decision ? `step ${r.decision.step} wave ${r.decision.wave} ${r.decision.kind}${r.decision.sub ? `/${r.decision.sub}` : ""} [${r.decision.actions.map(a => a.label).join(" | ")}]` : `END ${r.end?.cause} wave ${r.end?.wave}`);

const t0 = Date.now();
const ping = await call("ping");
check(ping.session && ping.gamePin, `ping session=${ping.session} pin=${ping.gamePin?.slice(0, 7)}`);
const st = await call("starters");
check(st.starters.length > 100 && st.cap === 15, `starters: ${st.starters.length}, cap ${st.cap}`);
const pv = await call("preview", { seed: "777" });
check(pv.team.points <= 15, `preview seed 777: ${pv.team.names.join(", ")} (${pv.team.points} pts)`);
try {
  await call("reset", { seed: "1", team: st.starters.filter(s => s.cost >= 5).slice(0, 4).map(s => s.id), policy: "human", out: "runs/apicheck" });
  check(false, "over-cap team rejected");
} catch (e) {
  check(/cap/.test(e.message), `over-cap team rejected (${e.message})`);
}

const chosen = st.starters.filter(s => s.cost === 3).slice(0, 5).map(s => s.id);
let r = await call("reset", { seed: "777", team: chosen, policy: "human", out: "runs/apicheck" });
check(r.runId && r.decision?.obs?.party?.length === chosen.length, `reset chosen team -> ${r.runId}: ${r.team.names.join(", ")}`);
console.log(`     ${show(r)}`);
try {
  await call("step", { index: 0, expect: "definitely-not-this" });
  check(false, "stale expect rejected");
} catch (e) {
  check(/stale/.test(e.message), "stale expect rejected");
}
const runId = r.runId;
let steps = 0;
const tPlay = Date.now();
while (r.decision && steps < Number(v.steps)) {
  const i = rand(r.decision.actions.length);
  r = await call("step", { index: i, expect: r.decision.actions[i].id, thinkMs: 0 });
  steps++;
}
const perStep = (Date.now() - tPlay) / Math.max(1, steps);
check(steps > 0, `${steps} steps, ${perStep.toFixed(1)} ms per round trip; messages last step: ${r.messages?.length ?? 0}`);
console.log(`     ${show(r)}`);
if (!r.decision) {
  console.log("  (run ended early; skipping resume test)");
} else {
  const before = r.decision;
  await call("detach");
  const list = await call("runs", { policy: "apicheck" });
  check(list.runs.some(x => x.runId === runId && !x.ended), "run listed as paused");
  r = await call("resume", { runId, policy: "apicheck" });
  check(
    r.decision && r.decision.step === before.step && JSON.stringify(r.decision.actions) === JSON.stringify(before.actions),
    `resume replayed ${r.replayed} decisions in ${r.replayMs} ms and landed on the same decision`,
  );
  for (let k = 0; k < 5 && r.decision; k++) {
    const i = rand(r.decision.actions.length);
    r = await call("step", { index: i, expect: r.decision.actions[i].id });
  }
  await call("abandon");
}
const rv = await call("review", { runId, policy: "apicheck" });
const kinds = rv.records.map(x => x.t);
check(kinds[0] === "start" && kinds.includes("d") && kinds.includes("end"), `review: ${rv.records.length} records (${[...new Set(kinds)].join(",")})`);

// Agent-style use: unlogged run, obs off, as fast as possible.
r = await call("reset", { seed: "42", policy: "agent", obs: false });
check(r.runId === null && r.decision && !r.decision.obs, "unlogged agent reset (no obs)");
const tA = Date.now();
let n = 0;
while (r.decision) {
  r = await call("step", { index: rand(r.decision.actions.length) });
  n++;
}
check(r.end, `agent run to end: ${r.end.cause} at wave ${r.end.wave}, ${n} decisions, ${((n * 1000) / (Date.now() - tA)).toFixed(0)} decisions/s over TCP`);

console.log(`all checks passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (v.shutdown) {
  await call("shutdown");
}
sock.end();
