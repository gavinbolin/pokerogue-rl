/**
 * Fetch the pinned PokeRogue checkout into vendor/pokerogue and install its dependencies.
 *   node scripts/setup.mjs
 * Idempotent. Talks to github.com and the npm registry only (never pokerogue.net).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendor = path.join(root, "vendor", "pokerogue");
const pin = Object.fromEntries(
  fs
    .readFileSync(path.join(root, "pokerogue.pin"), "utf8")
    .split(/\r?\n/)
    .filter(l => l && !l.startsWith("#") && l.includes("="))
    .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);

const [maj, min] = process.versions.node.split(".").map(Number);
if (maj < 24 || (maj === 24 && min < 9)) {
  console.error(`Node >= 24.9 required (PokeRogue engines); this is ${process.version}`);
  process.exit(1);
}

function sh(cmd, args, cwd = root) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: false });
  if (r.error || r.status !== 0) {
    console.error(`failed: ${cmd} ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}
function out(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, encoding: "utf8" }).stdout?.trim() ?? "";
}

if (!fs.existsSync(path.join(vendor, "package.json"))) {
  fs.mkdirSync(path.dirname(vendor), { recursive: true });
  sh("git", ["clone", "--filter=blob:none", "--no-checkout", pin.repo, vendor]);
  sh("git", ["fetch", "--depth", "1", "origin", pin.commit], vendor);
  sh("git", ["checkout", "--detach", pin.commit], vendor);
} else {
  const head = out("git", ["rev-parse", "HEAD"], vendor);
  if (head !== pin.commit) {
    console.error(`vendor/pokerogue is at ${head}, pin is ${pin.commit}. Remove vendor/pokerogue and rerun.`);
    process.exit(1);
  }
  console.log(`vendor/pokerogue at pin ${pin.commit}`);
}
if (!fs.existsSync(path.join(vendor, "locales", "en"))) {
  sh("git", ["submodule", "update", "--init", "--depth", "1", "locales"], vendor);
}

// pnpm via corepack's JS entry (avoids the Windows .cmd spawn restriction).
const corepack = [
  path.join(path.dirname(process.execPath), "node_modules", "corepack", "dist", "corepack.js"),
  path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "corepack", "dist", "corepack.js"),
].find(f => fs.existsSync(f));
if (!fs.existsSync(path.join(vendor, "node_modules", "vitest"))) {
  if (!corepack) {
    console.error("corepack not found next to node; run `corepack pnpm install --frozen-lockfile` in vendor/pokerogue");
    process.exit(1);
  }
  sh(process.execPath, [corepack, "pnpm", "install", "--frozen-lockfile"], vendor);
}

// Repo-level node_modules -> the game's, so sim/*.ts can import vitest / phaser.
const link = path.join(root, "node_modules");
if (!fs.existsSync(link)) {
  fs.symlinkSync(path.join(vendor, "node_modules"), link, process.platform === "win32" ? "junction" : "dir");
  console.log("linked node_modules -> vendor/pokerogue/node_modules");
}
console.log("setup done");
