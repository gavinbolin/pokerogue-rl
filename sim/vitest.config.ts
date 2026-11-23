/**
 * Vitest config that runs sim/endless.test.ts against the pinned game in vendor/pokerogue,
 * reusing the game's own test environment (jsdom, headless Phaser, i18n mocks).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";
import gameConfig from "../vendor/pokerogue/vitest.config.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(here, "../vendor/pokerogue");
const slash = (p: string) => p.replace(/\\/g, "/");
// Vitest treats backslashes in `include` as escapes.
const testFile = slash(path.join(here, "endless.test.ts"));

/**
 * The game resolves `#foo/...` imports through its tsconfig `paths`. Files in sim/ sit outside the
 * game tree, so resolve those imports here using the same table (read from the game's tsconfig).
 */
function gamePathAliases(): Plugin {
  const text = fs.readFileSync(path.join(gameRoot, "tsconfig.json"), "utf8");
  const block = text.slice(text.indexOf('"paths"'));
  const table: { key: string; star: boolean; prefix: string; targets: string[] }[] = [];
  for (const m of block.matchAll(/"(#[^"]+)"\s*:\s*\[([\s\S]*?)\]/g)) {
    const key = m[1];
    const targets = [...m[2].matchAll(/"([^"]+)"/g)].map(t => t[1]);
    table.push({ key, star: key.endsWith("/*"), prefix: key.endsWith("/*") ? key.slice(0, -1) : key, targets });
  }
  const rootSlash = slash(gameRoot);
  return {
    name: "pokerogue-rl-game-aliases",
    enforce: "pre",
    resolveId(source, importer) {
      const from = importer ? slash(importer.split("?")[0]) : "";
      if (!source.startsWith("#") || !from || from.startsWith(rootSlash)) {
        return null;
      }
      for (const e of table) {
        if (e.star ? !source.startsWith(e.prefix) : source !== e.key) {
          continue;
        }
        const rest = e.star ? source.slice(e.prefix.length) : "";
        for (const t of e.targets) {
          const abs = path.resolve(gameRoot, e.star ? t.replace("*", rest) : t);
          if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
            return abs;
          }
        }
        if (e.star) {
          return null;
        }
      }
      return null;
    },
  };
}

export default defineConfig(async env => {
  const base = await gameConfig(env);
  return {
    ...base,
    root: gameRoot,
    plugins: [...(base.plugins ?? []), gamePathAliases()],
    test: {
      ...base.test,
      name: "endless-sim",
      include: [testFile],
      exclude: [],
      reporters: ["default"],
      setupFiles: [
        "./test/setup/font-face.setup.ts",
        "./test/setup/vitest.setup.ts",
        "./test/setup/matchers.setup.ts",
      ],
      testTimeout: 24 * 60 * 60 * 1000,
      hookTimeout: 300 * 1000,
      fileParallelism: false,
      maxWorkers: 1,
      coverage: { enabled: false, provider: "v8", reporter: [] },
      passWithNoTests: false,
    },
  };
});
