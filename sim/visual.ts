/**
 * Presentation-only data for the play UI: which sprite / icon / arena image to draw, EXP bars,
 * item icons and the type-effectiveness hint the real game shows in its fight menu.
 * Sent with server responses next to the decision; never written to the run logs, and computed
 * with the game RNG state saved and restored so it cannot change how a run plays out.
 */
import type { BattleScene } from "#app/battle-scene";
import { getLevelRelExp } from "#data/exp";
import { getBiomeKey } from "#field/arena";
import type { Pokemon } from "#field/pokemon";
import { getPlayerShopModifierTypeOptionsForWave } from "#modifiers/modifier-type";
import Phaser from "phaser";
import type { Decision } from "./env.ts";

export interface MonVisual {
  sprite: string; // path under images/pokemon/ without extension, e.g. "25" or "back/6-mega-x"
  fallback: string; // plain species sprite if the form sprite is missing
  icon: { atlas: string; frame: string };
  shiny: boolean;
  female: boolean;
  boss?: boolean;
  expFrac?: number;
  items?: { icon: string; name: string; count: number }[];
  fieldIndex?: number;
  onField?: boolean;
}

export interface Visual {
  arena: string;
  party: MonVisual[];
  enemies: MonVisual[];
  playerItems: { icon: string; name: string; count: number }[];
  /** action id -> item icon (rewards, shop, balls) */
  actionIcons: Record<string, string>;
  /** command move action id -> effectiveness multiplier against each enemy on the field (null = status move) */
  effectiveness: Record<string, (number | null)[]>;
}

const BALL_ICONS = ["pb", "gb", "ub", "rb", "mb", "pb"];

const safe = <T>(fn: () => T, fallback: T): T => {
  try {
    const v = fn();
    return v ?? fallback;
  } catch {
    return fallback;
  }
};

function monVisual(scene: BattleScene, p: Pokemon, back: boolean): MonVisual {
  const form = safe(() => (p as any).getSpeciesForm(false, true), null as any);
  const formIndex = (p as any).formIndex ?? 0;
  const female = safe(() => (p as any).getGender?.() === 1, false);
  const id = (b: boolean) => safe(() => String(form.getSpriteId(false, formIndex, false, 0, b)), String(p.species.speciesId));
  const sprite = id(back).replace(/__/g, "/");
  const base = String(p.species.speciesId);
  return {
    sprite,
    fallback: back ? `back/${base}` : base,
    icon: {
      atlas: safe(() => String(form.getIconAtlasKey(formIndex, false, 0)), "pokemon_icons_0"),
      frame: safe(() => String(form.getIconId(false, formIndex, false, 0)), base),
    },
    shiny: !!(p as any).shiny,
    female,
    items: scene.modifiers
      .filter(m => (m as { pokemonId?: number }).pokemonId === p.id)
      .map(m => ({ icon: safe(() => String((m.type as any).iconImage), ""), name: safe(() => m.type.name, ""), count: safe(() => m.getStackCount(), 1) })),
  };
}

export function visualize(scene: BattleScene | undefined, d: Decision | null): Visual | null {
  if (!scene?.currentBattle) {
    return null;
  }
  // Nothing below should touch the RNG, but make sure of it.
  const rnd = Phaser.Math.RND.state();
  const counter = (scene as any).rngCounter;
  const seedOverride = (scene as any).rngSeedOverride;
  const mathRandom = Math.random;
  Math.random = () => 0.5;
  try {
    const party = scene.getPlayerParty().map(p => {
      const v = monVisual(scene, p, true);
      v.onField = p.isOnField();
      v.expFrac = safe(() => {
        const rel = getLevelRelExp(p.level + 1, p.species.growthRate);
        return rel ? Math.max(0, Math.min(1, p.levelExp / rel)) : 0;
      }, 0);
      return v;
    });
    const enemies = scene.getEnemyField().map(e => {
      const v = monVisual(scene, e, false);
      v.boss = safe(() => (e as any).isBoss(), false);
      v.fieldIndex = e.getFieldIndex();
      v.onField = e.isOnField();
      return v;
    });
    const playerItems = scene.modifiers
      .filter(m => (m as { pokemonId?: number }).pokemonId === undefined)
      .map(m => ({ icon: safe(() => String((m.type as any).iconImage), ""), name: safe(() => m.type.name, ""), count: safe(() => m.getStackCount(), 1) }));

    const actionIcons: Record<string, string> = {};
    const effectiveness: Record<string, (number | null)[]> = {};
    if (d) {
      const phase = scene.phaseManager.getCurrentPhase() as any;
      for (const a of d.actions) {
        const [kind, arg] = a.id.split(":");
        if (kind === "ball") {
          actionIcons[a.id] = BALL_ICONS[Number(arg)] ?? "pb";
        } else if (kind === "reward") {
          actionIcons[a.id] = safe(() => String(phase.typeOptions[Number(arg)].type.iconImage), "");
        }
      }
      if (d.kind === "reward" && d.actions.some(a => a.id.startsWith("shop:"))) {
        const shop = safe(() => getPlayerShopModifierTypeOptionsForWave(scene.currentBattle.waveIndex, scene.getWaveMoneyAmount(1)), [] as any[]);
        for (const a of d.actions) {
          if (a.id.startsWith("shop:")) {
            actionIcons[a.id] = safe(() => String(shop[Number(a.id.slice(5))].type.iconImage), "");
          }
        }
      }
      if (d.kind === "command") {
        const fieldIndex = Number((d.context as any)?.fieldIndex ?? 0);
        const mon = scene.getPlayerField()[fieldIndex];
        const foes = scene.getEnemyField();
        if (mon) {
          for (const a of d.actions) {
            if (!a.id.startsWith("move:")) {
              continue;
            }
            const pm = mon.getMoveset()[Number(a.id.slice(5))];
            if (!pm) {
              continue;
            }
            const move = pm.getMove();
            effectiveness[a.id] = foes.map(foe =>
              safe(() => {
                if (!foe.isActive(true)) {
                  return null;
                }
                const eff = foe.getMoveEffectiveness(mon, move, !foe.waveData.abilityRevealed, undefined, undefined, true);
                return move.category === 2 && eff !== 0 ? null : Number(eff);
              }, null),
            );
          }
        }
      }
    }
    return {
      arena: safe(() => getBiomeKey(scene.arena.biomeId), "plains"),
      party,
      enemies,
      playerItems,
      actionIcons,
      effectiveness,
    };
  } finally {
    Math.random = mathRandom;
    Phaser.Math.RND.state(rnd);
    (scene as any).rngCounter = counter;
    (scene as any).rngSeedOverride = seedOverride;
  }
}
