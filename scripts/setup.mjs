/**
 * Fetch the pinned PokeRogue checkout into vendor/pokerogue and install its dependencies.
 *   node scripts/setup.mjs
 * Also fetches the play UI's art (sparse pokerogue-assets checkout; skip with --no-assets).
 * Idempotent; after a pin change it moves existing checkouts to the new pin and reinstalls if the lockfile changed.
 * Talks to github.com and the npm registry only (never pokerogue.net).
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
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
  // LEFTHOOK=0: the game repo's git hooks (post-checkout pnpm install) assume pnpm on PATH; setup installs itself.
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: false, env: { ...process.env, LEFTHOOK: "0" } });
  if (r.error || r.status !== 0) {
    console.error(`failed: ${cmd} ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}
function out(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, encoding: "utf8" }).stdout?.trim() ?? "";
}

function clean(cwd) {
  return out("git", ["status", "--porcelain", "--untracked-files=no", "--ignore-submodules"], cwd) === "";
}

if (!fs.existsSync(path.join(vendor, "package.json"))) {
  fs.mkdirSync(path.dirname(vendor), { recursive: true });
  sh("git", ["clone", "--filter=blob:none", "--no-checkout", pin.repo, vendor]);
  sh("git", ["fetch", "--depth", "1", "origin", pin.commit], vendor);
  sh("git", ["-c", "advice.detachedHead=false", "checkout", "--detach", pin.commit], vendor);
} else {
  const head = out("git", ["rev-parse", "HEAD"], vendor);
  if (head !== pin.commit) {
    // Move the existing checkout to the new pin in place (node_modules is reinstalled below if the lockfile changed).
    if (!clean(vendor)) {
      console.error(`vendor/pokerogue has local changes; cannot move ${head.slice(0, 7)} -> ${pin.commit.slice(0, 7)}.`);
      process.exit(1);
    }
    console.log(`moving vendor/pokerogue ${head.slice(0, 7)} -> ${pin.commit.slice(0, 7)}${pin.tag ? ` (${pin.tag})` : ""}`);
    sh("git", ["fetch", "--depth", "1", "--filter=blob:none", "origin", pin.commit], vendor);
    sh("git", ["-c", "advice.detachedHead=false", "checkout", "--detach", pin.commit], vendor);
  }
  console.log(`vendor/pokerogue at pin ${pin.commit}`);
}
const localesDir = path.join(vendor, "locales");
if (!fs.existsSync(path.join(localesDir, "en")) || (pin.locales && out("git", ["rev-parse", "HEAD"], localesDir) !== pin.locales)) {
  sh("git", ["submodule", "update", "--init", "--depth", "1", "locales"], vendor);
}
if (pin.locales && out("git", ["rev-parse", "HEAD"], localesDir) !== pin.locales) {
  console.error(`locales submodule is not at the pinned ${pin.locales}; check pokerogue.pin against the game commit.`);
  process.exit(1);
}

// Game art for the play UI (sparse: battle/back sprites, party icons, arenas, items, UI windows, fonts).
const assets = path.join(root, "vendor", "pokerogue-assets");
const ASSET_PATTERNS = [
  "/images/pokemon/*.png",
  "/images/pokemon/*.json",
  "/images/pokemon/back/*.png",
  "/images/pokemon/back/*.json",
  "/images/pokemon_icons_[0-9].png",
  "/images/pokemon_icons_[0-9].json",
  "/images/arenas/",
  "/images/items/",
  "/images/types.png",
  "/images/types.json",
  "/images/statuses.png",
  "/images/statuses.json",
  "/images/categories.png",
  "/images/categories.json",
  "/images/ui/*.png",
  "/images/ui/*.json",
  "/images/ui/windows/",
  "/fonts/",
  "/LICENSES/",
  "/README.md",
  "/REUSE.toml",
  "/images/REUSE.toml",
];
if (pin.assets && process.argv.includes("--no-assets")) {
  console.log("skipping play-UI assets (--no-assets)");
} else if (pin.assets && !fs.existsSync(path.join(assets, "images", "arenas"))) {
  fs.rmSync(assets, { recursive: true, force: true });
  sh("git", ["clone", "--filter=blob:none", "--no-checkout", "--depth", "1", pin.assets_repo, assets]);
  sh("git", ["fetch", "--depth", "1", "--filter=blob:none", "origin", pin.assets], assets);
  sh("git", ["sparse-checkout", "init", "--no-cone"], assets);
  fs.writeFileSync(path.join(assets, ".git", "info", "sparse-checkout"), `${ASSET_PATTERNS.join("\n")}\n`);
  sh("git", ["-c", "advice.detachedHead=false", "checkout", pin.assets], assets);
} else if (pin.assets && out("git", ["rev-parse", "HEAD"], assets) !== pin.assets) {
  console.log(`moving vendor/pokerogue-assets -> ${pin.assets.slice(0, 7)}`);
  sh("git", ["fetch", "--depth", "1", "--filter=blob:none", "origin", pin.assets], assets);
  fs.writeFileSync(path.join(assets, ".git", "info", "sparse-checkout"), `${ASSET_PATTERNS.join("\n")}\n`);
  sh("git", ["-c", "advice.detachedHead=false", "checkout", "--detach", pin.assets], assets);
} else if (pin.assets) {
  console.log(`vendor/pokerogue-assets present (${out("git", ["rev-parse", "--short", "HEAD"], assets)})`);
}

// pnpm via corepack's JS entry (avoids the Windows .cmd spawn restriction).
const corepack = [
  path.join(path.dirname(process.execPath), "node_modules", "corepack", "dist", "corepack.js"),
  path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "corepack", "dist", "corepack.js"),
].find(f => fs.existsSync(f));
// Reinstall whenever the game's lockfile differs from the one node_modules was installed from.
const lockStamp = path.join(vendor, "node_modules", ".pokerogue-rl-lock");
const lockNow = crypto.createHash("sha256").update(fs.readFileSync(path.join(vendor, "pnpm-lock.yaml"))).digest("hex");
const lockOld = fs.existsSync(lockStamp) ? fs.readFileSync(lockStamp, "utf8").trim() : null;
if (!fs.existsSync(path.join(vendor, "node_modules", "vitest")) || lockOld !== lockNow) {
  if (!corepack) {
    console.error("corepack not found next to node; run `corepack pnpm install --frozen-lockfile` in vendor/pokerogue");
    process.exit(1);
  }
  sh(process.execPath, [corepack, "pnpm", "install", "--frozen-lockfile"], vendor);
  fs.writeFileSync(lockStamp, `${lockNow}\n`);
}

// Repo-level node_modules -> the game's, so sim/*.ts can import vitest / phaser.
const link = path.join(root, "node_modules");
if (!fs.existsSync(link)) {
  fs.symlinkSync(path.join(vendor, "node_modules"), link, process.platform === "win32" ? "junction" : "dir");
  console.log("linked node_modules -> vendor/pokerogue/node_modules");
}
console.log("setup done");
