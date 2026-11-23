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
