/**
 * Start the long-lived sim server (one game process, reused across runs).
 *   node scripts/serve.mjs                 # HTTP UI + API on 127.0.0.1:8765, TCP JSON-lines on 127.0.0.1:8766
 *   node scripts/serve.mjs --open          # also open the play UI in the default browser
 *   options: --http-port N  --tcp-port N  --no-http  --no-tcp  --verbose
 * `npm run play` runs this. Ctrl+C (or {"cmd":"shutdown"}) stops it.
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
    "http-port": { type: "string", default: "8765" },
    "tcp-port": { type: "string", default: "8766" },
    "no-http": { type: "boolean", default: false },
    "no-tcp": { type: "boolean", default: false },
    open: { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
  },
  strict: true,
});

if (!fs.existsSync(path.join(vendor, "node_modules", "vitest"))) {
  console.error("Game not installed. Run: node scripts/setup.mjs");
  process.exit(1);
}

const t0 = Date.now();
console.log("[play] starting headless game server (first start takes ~20-30 s)...");
const child = spawn(process.execPath, [path.join(vendor, "node_modules", "vitest", "vitest.mjs"), "run", "--config", path.join(root, "sim", "vitest.config.ts")], {
  cwd: vendor,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    SIM_ENTRY: "server",
    SIM_ROOT: root,
    SIM_HTTP_PORT: v["no-http"] ? "" : v["http-port"],
    SIM_TCP_PORT: v["no-tcp"] ? "" : v["tcp-port"],
    SIM_VERBOSE: v.verbose ? "1" : "0",
    VITE_BYPASS_LOGIN: "1",
  },
});

let url = null;
const onLine = line => {
  if (v.verbose) {
    console.log(line);
  }
  const m = line.match(/\[server\] (.*)/);
  if (!m) {
    if (/error|failed/i.test(line) && !v.verbose) {
      console.error(line);
    }
    return;
  }
  const msg = m[1];
  const http = msg.match(/^http (\S+)/);
  if (http) {
    url = http[1];
  }
  if (msg.startsWith("ready")) {
    console.log(`[play] ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (url) {
      console.log(`[play] Play UI:  ${url}`);
    }
    if (!v["no-tcp"]) {
      console.log(`[play] JSON-lines API:  tcp 127.0.0.1:${v["tcp-port"]}`);
    }
    console.log("[play] Ctrl+C to stop.");
    if (v.open && url) {
      const opener = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
      spawn(opener[0], opener[1], { stdio: "ignore", detached: true }).unref();
    }
  } else if (!msg.startsWith("http") && !msg.startsWith("tcp")) {
    console.log(`[play] ${msg}`);
  }
};
for (const stream of [child.stdout, child.stderr]) {
  let buf = "";
  stream.on("data", c => {
    buf += c.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      onLine(buf.slice(0, i).replace(/\r$/, ""));
      buf = buf.slice(i + 1);
    }
  });
}

let stopping = false;
async function stop() {
  if (stopping) {
    return;
  }
  stopping = true;
  console.log("[play] stopping...");
  if (url) {
    try {
      await fetch(`${url}api`, { method: "POST", body: JSON.stringify({ cmd: "shutdown" }), signal: AbortSignal.timeout(3000) });
    } catch {
      /* fall through to kill */
    }
  }
  setTimeout(() => child.kill(), 5000).unref();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", code => {
  console.log(`[play] server exited (${code ?? "signal"})`);
  process.exit(stopping ? 0 : (code ?? 1));
});
