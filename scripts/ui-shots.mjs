/**
 * Screenshots of the play UI with a throwaway headless Edge/Chrome (own temp profile, own debug port),
 * driving it with keystrokes like a player would. Needs a running server (`npm run play`).
 *   node scripts/ui-shots.mjs [--url http://127.0.0.1:8765/] [--out runs/ui-shots] [--port 9339] [--seed 2024]
 * Drives the API to set up states (reset, steps), reloads the page, and presses keys for menus.
 * Leaves no browser running and deletes its temp profile.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values: v } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:8765/" },
    out: { type: "string", default: "runs/ui-shots" },
    port: { type: "string", default: "9339" },
    seed: { type: "string", default: "2024" },
    browser: { type: "string" },
  },
});
if (v.port === "9222") {
  throw new Error("port 9222 is reserved; pick another");
}
const out = path.resolve(root, v.out);
fs.mkdirSync(out, { recursive: true });
const browsers = [v.browser, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe", "/usr/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean);
const exe = browsers.find(b => fs.existsSync(b));
if (!exe) {
  throw new Error("no headless browser found");
}
const profile = path.join(out, `.profile-${process.pid}`);
const proc = spawn(exe, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${v.port}`, `--user-data-dir=${profile}`, "--window-size=1600,1000", "about:blank"], { stdio: "ignore" });

const api = async (cmd, a = {}) => {
  const r = await (await fetch(`${v.url}api`, { method: "POST", body: JSON.stringify({ cmd, ...a }) })).json();
  if (!r.ok) {
    throw new Error(`${cmd}: ${r.error}`);
  }
  return r;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

let ws;
let id = 0;
const pending = new Map();
const cdp = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
  });

try {
  let targets;
  for (let k = 0; k < 50; k++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${v.port}/json/list`)).json();
      if (targets.some(t => t.type === "page")) {
        break;
      }
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  const page = targets.find(t => t.type === "page");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener("open", r));
  ws.addEventListener("message", ev => {
    const m = JSON.parse(ev.data);
    if (m.method === "Runtime.exceptionThrown") {
      console.log("[page error]", m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
    } else if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type)) {
      console.log(`[page ${m.params.type}]`, m.params.args.map(a => a.value ?? a.description).join(" "));
    }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  });
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  const load = async () => {
    await cdp("Page.navigate", { url: v.url });
    await sleep(2500);
  };
  const shot = async name => {
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    const file = path.join(out, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    console.log(file);
  };
  const KEYS = { ArrowRight: 39, ArrowLeft: 37, ArrowUp: 38, ArrowDown: 40, Enter: 13, Escape: 27, z: 90, x: 88 };
  const key = async k => {
    const code = KEYS[k] ?? k.toUpperCase().charCodeAt(0);
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: k, windowsVirtualKeyCode: code });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k, windowsVirtualKeyCode: code });
    await sleep(250);
  };
  const stepUntil = async (r, pred, choose, max = 400) => {
    for (let n = 0; n < max && r.decision && !pred(r.decision); n++) {
      r = await api("step", { index: choose(r.decision) });
    }
    return r;
  };
  const pickCmd = d => (d.kind === "command" ? Math.max(0, d.actions.findIndex(a => a.id.startsWith("move:"))) : d.kind === "reward" ? d.actions.findIndex(a => a.id === "skip") : d.kind === "catch_full" ? d.actions.length - 1 : 0);

  // 1. battle + fight menu
  let r = await api("reset", { seed: v.seed, policy: "human", out: "runs/ui-shots/log" });
  r = await stepUntil(r, d => d.kind === "command" && d.wave >= 2, pickCmd);
  await load();
  await shot("1-battle-command");
  await key("z"); // Fight
  await shot("2-fight-menu");
  await key("Escape");
  await key("ArrowDown"); // Pokémon
  await key("z");
  await shot("3-party-switch");
  await key("x");
  // 2. reward screen
  r = await stepUntil(r, d => d.kind === "reward" && d.actions.length >= 3, pickCmd);
  await load();
  await shot("4-reward");
  // 3. battle text playback: take a fight action through the UI and capture mid-text
  r = await stepUntil(r, d => d.kind === "command", pickCmd);
  await load();
  await key("z");
  await key("z");
  await sleep(150);
  await shot("5-battle-text");
  // 4. other screens if they come up (best effort): doubles, catch with a full party, learn move, item target
  const wanted = new Map([
    ["double-battle", d => d.kind === "command" && d.obs?.double],
    ["catch-full", d => d.kind === "catch_full"],
    ["learn-move", d => d.kind === "learn_move"],
    ["party-item", d => d.kind === "party" && /MODIFIER/.test(d.sub ?? "")],
  ]);
  r = await api("state");
  for (let n = 0; n < 1500 && r.decision && wanted.size; n++) {
    const hit = [...wanted].find(([, f]) => f(r.decision));
    if (hit) {
      wanted.delete(hit[0]);
      await load();
      await shot(`6-${hit[0]}`);
    }
    // random-ish play from here (catching when possible) to reach more screens
    const d = r.decision;
    const ball = d.actions.findIndex(a => a.id.startsWith("ball:"));
    const i = d.kind === "command" && ball >= 0 && n % 3 === 0 ? ball : d.kind === "learn_move" ? 0 : (n * 7919) % d.actions.length;
    r = await api("step", { index: i });
  }
  if (r.end) {
    await load();
    await shot("7-game-over");
  }
  await api("abandon");

  // 5. live-UI features: declining a new move ("Stop trying to teach?") and Manage Items (transfer).
  // Plays throwaway runs (random-ish, moves preferred) until both have come up.
  const todo = new Set(["learn", "transfer"]);
  const find = id => r.decision.actions.findIndex(a => a.id === id || a.id.startsWith(id));
  // reward screen: Down from the cards into the bottom-right list, then Down to the wanted button
  const toBottom = async id => {
    const acts = r.decision.actions;
    const bottom = acts.filter(a => !/^(reward|shop):/.test(a.id));
    const n = (acts.some(a => a.id.startsWith("reward:")) ? 1 : 0) + (acts.some(a => a.id.startsWith("shop:")) ? 1 : 0) + Math.max(0, bottom.findIndex(a => a.id === id));
    for (let k = 0; k < n; k++) {
      await key("ArrowDown");
    }
  };
  const refresh = async () => {
    await sleep(600);
    r = await api("state");
  };
  for (let run = 0; run < 25 && todo.size; run++) {
    r = await api("reset", { seed: `${v.seed}-f${run}`, policy: "human", out: "runs/ui-shots/log" });
    for (let n = 0; n < 2500 && r.decision && todo.size; n++) {
      const d = r.decision;
      if (todo.has("learn") && d.kind === "learn_move" && !d.sub && find("keep") >= 0) {
        todo.delete("learn");
        await load();
        await shot("8-learn-move-confirm"); // "Should a move be forgotten?" Yes / No
        await key("z"); // Yes
        await shot("8-learn-move-forget-list"); // move list + Don't learn
        await key("x"); // back out = don't learn
        await refresh();
        if (r.decision?.sub === "stop_teaching") {
          await load();
          await shot("8-learn-stop-teaching"); // "Stop trying to teach X?"
        }
        continue;
      }
      if (todo.has("transfer") && d.kind === "reward" && find("transfer") >= 0) {
        todo.delete("transfer");
        await load();
        await toBottom("transfer"); // to Manage Items in the bottom-right window
        await shot("9-reward-manage-items");
        r = await api("step", { index: find("transfer") });
        await load();
        await shot("9-transfer-from");
        for (const [stage, pre] of [["from", "xfer_from:"], ["item", "xfer_item:"], ["qty", "xfer_qty:"]]) {
          if (r.decision?.context?.stage === stage && find(pre) >= 0) {
            r = await api("step", { index: find(pre) });
            if (r.decision?.context?.stage !== "from") {
              await load();
              await shot(`9-transfer-${r.decision.context.stage}`);
            }
          }
        }
        if (r.decision?.context?.stage === "to" && find("xfer_to:") >= 0) {
          r = await api("step", { index: find("xfer_to:") });
          await load();
          await shot("9-transfer-done"); // back on the transfer screen, item moved
        }
        continue;
      }
      const moves = d.actions.map((a, i) => (a.id.startsWith("move:") ? i : -1)).filter(i => i >= 0);
      const i = d.kind === "command" && moves.length && n % 4 ? moves[n % moves.length] : d.kind === "learn_move" && !d.sub ? find("keep") : (n * 7919) % d.actions.length;
      r = await api("step", { index: Math.max(0, i) });
    }
    if (r.decision) {
      await api("abandon");
    }
  }
  if (todo.size) {
    console.log(`(not reached: ${[...todo].join(", ")})`);
  }

  // 6. Tera, Lock Rarities and Discard. Tera Orb / Lock Capsule are rare drops, so this uses an
  // unlogged run (log: false) and the debug_give test helper, which the server refuses on logged runs.
  r = await api("reset", { seed: `${v.seed}-p2`, policy: "human", log: false });
  r = await stepUntil(r, d => d.kind === "command", pickCmd);
  r = await api("debug_give", {
    items: [
      { name: "TERA_ORB" },
      { name: "LOCK_CAPSULE" },
      { name: "QUICK_CLAW", slot: 0, count: 2 },
      { name: "LEFTOVERS", slot: 0 },
    ],
  });
  if (find("tera:") >= 0) {
    await load();
    await key("ArrowLeft"); // Fight -> Tera button
    await shot("10-command-tera");
    await key("z");
    await shot("10-tera-fight"); // moves, "Terastallize -> <type>"
    await key("z");
    await sleep(400);
    await shot("10-tera-text");
    await refresh();
    console.log(`tera: terasUsed=${r.decision?.obs?.terasUsed}`);
  } else {
    console.log("(no tera action offered)");
  }
  r = await stepUntil(r, d => d.kind === "reward", pickCmd);
  if (r.decision && find("lock_rarities") >= 0) {
    const before = r.decision.actions[find("reroll")]?.data?.cost;
    await load();
    await toBottom("lock_rarities");
    await shot("11-reward-lock-rarities");
    r = await api("step", { index: find("lock_rarities") });
    await load();
    await toBottom("lock_rarities");
    await shot("11-reward-locked"); // Unlock Rarities, reroll re-priced by the locked tiers
    console.log(`lock: reroll cost ${before} -> ${r.decision.actions[find("reroll")]?.data?.cost}`);
    r = await api("step", { index: find("transfer") });
    await load();
    await shot("12-transfer-from-discard-button");
    r = await api("step", { index: find("xfer_mode") });
    await load();
    await shot("12-discard-from");
    const withClaw = r.decision.actions.findIndex(a => a.id.startsWith("discard_from:") && a.data?.items?.some(it => it.typeId === "QUICK_CLAW"));
    r = await api("step", { index: withClaw >= 0 ? withClaw : find("discard_from:") });
    await load();
    await shot("12-discard-item");
    const qc = r.decision.actions.findIndex(a => a.id.startsWith("discard_item:") && a.data?.typeId === "QUICK_CLAW");
    r = await api("step", { index: qc >= 0 ? qc : find("discard_item:") });
    if (r.decision.context?.stage === "qty") {
      await load();
      await shot("12-discard-qty");
      r = await api("step", { index: find("discard_qty:1") });
    }
    await load();
    await shot("12-discard-confirm"); // "Are you sure you want to discard these items?"
    r = await api("step", { index: find("discard_yes") });
    await load();
    await shot("12-discard-done");
  } else {
    console.log("(lock rarities not offered)");
  }
  if (r.decision) {
    await api("abandon");
  }
} finally {
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  proc.kill();
  await sleep(1500);
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
