/**
 * Observation snapshot attached to every decision: what a human player could see on screen
 * (own party in full, enemy species / level / HP fraction / status / types, field, money, items).
 * Enemy movesets, IVs and exact enemy HP are deliberately left out.
 * Plain JSON so it can be logged (jsonl) for behaviour cloning and sent over a bridge.
 */
import type { BattleScene } from "#app/battle-scene";
import { BiomeId } from "#enums/biome-id";
import { BattleType } from "#enums/battle-type";
import { PokemonType } from "#enums/pokemon-type";
import { StatusEffect } from "#enums/status-effect";
import { WeatherType } from "#enums/weather-type";
import { TerrainType } from "#data/terrain";
import type { Pokemon } from "#field/pokemon";

export interface MoveObs {
  id: number;
  name: string;
  type: string;
  category: number; // 0 physical, 1 special, 2 status
  power: number;
  accuracy: number;
  pp: number;
  ppMax: number;
}
export interface MonObs {
  slot: number;
  id: number; // stable pokemon id within the run
  species: number;
  name: string;
  level: number;
  hp: number;
  maxHp: number;
  status: string | null;
  types: string[];
  ability: string;
  nature: number;
  stats: number[]; // HP, ATK, DEF, SPATK, SPDEF, SPD
  statStages: number[]; // ATK..EVA, only when on field
  moves: MoveObs[];
  items: { name: string; count: number }[];
  onField: boolean;
  fainted: boolean;
  teraType: string; // shown on the Tera button / summary
  tera: boolean; // terastallized now
}
export interface EnemyObs {
  fieldIndex: number;
  species: number;
  name: string;
  level: number;
  hpFrac: number;
  status: string | null;
  types: string[];
  boss: boolean;
  bossSegments: number;
  bossSegmentIndex: number;
  statStages: number[];
  shiny: boolean;
  tera: boolean; // terastallized (its types are then the tera type)
}
export interface Observation {
  wave: number;
  turn: number;
  biome: string;
  battleType: string;
  double: boolean;
  money: number;
  weather: number | null;
  terrain: number | null;
  weatherName: string | null;
  terrainName: string | null;
  party: MonObs[];
  enemies: EnemyObs[];
  balls: Record<string, number>;
  items: { name: string; count: number }[]; // player-wide (non-held) modifiers
  terasUsed: number; // player Terastallizations used in this arena (max 1)
  lockRarities: boolean; // reward-screen Lock Rarities toggle state
}

/** Name of an enum value; works for TS enums and the game's `as const` object enums alike. */
export function enumName(e: object, v: unknown): string {
  for (const [k, val] of Object.entries(e)) {
    if (val === v && Number.isNaN(Number(k))) {
      return k;
    }
  }
  return String(v);
}
const safe = <T>(f: () => T, d: T): T => {
  try {
    return f();
  } catch {
    return d;
  }
};
const typeNames = (p: Pokemon) => safe(() => p.getTypes().map(t => enumName(PokemonType, t)), [] as string[]);
const statusName = (p: Pokemon) => {
  const e = p.status?.effect;
  return e ? enumName(StatusEffect, e) : null;
};

function moveObs(p: Pokemon): MoveObs[] {
  return p.getMoveset().filter(Boolean).map(m => {
    const mv = m.getMove();
    const ppMax = m.getMovePp();
    return {
      id: m.moveId,
      name: safe(() => m.getName(), String(m.moveId)),
      type: enumName(PokemonType, mv.type),
      category: mv.category,
      power: mv.power,
      accuracy: mv.accuracy,
      pp: ppMax - m.ppUsed,
      ppMax,
    };
  });
}

export function heldItems(scene: BattleScene, p: Pokemon): { name: string; count: number }[] {
  return scene.modifiers
    .filter(m => (m as { pokemonId?: number }).pokemonId === p.id)
    .map(m => ({ name: safe(() => m.type.name, m.constructor.name), count: m.getStackCount() }));
}

export function observe(scene: BattleScene): Observation {
  const battle = scene.currentBattle;
  const party = scene.getPlayerParty().map((p, slot) => ({
    slot,
    id: p.id,
    species: p.species.speciesId,
    name: p.name,
    level: p.level,
    hp: p.hp,
    maxHp: p.getMaxHp(),
    status: statusName(p),
    types: typeNames(p),
    ability: safe(() => p.getAbility().name, ""),
    nature: safe(() => p.getNature(), -1),
    stats: [...(p.stats ?? [])],
    statStages: p.isOnField() ? [...safe(() => p.getStatStages(), [] as number[])] : [],
    moves: moveObs(p),
    items: heldItems(scene, p),
    onField: p.isOnField(),
    fainted: p.isFainted(),
    teraType: safe(() => enumName(PokemonType, p.getTeraType()), ""),
    tera: !!p.isTerastallized,
  }));
  const enemies = (battle ? scene.getEnemyField() : []).map((p, fieldIndex) => ({
    fieldIndex,
    species: p.species.speciesId,
    name: p.name,
    level: p.level,
    hpFrac: Math.round((p.hp / Math.max(1, p.getMaxHp())) * 1000) / 1000,
    status: statusName(p),
    types: typeNames(p),
    boss: safe(() => p.isBoss(), false),
    bossSegments: (p as { bossSegments?: number }).bossSegments ?? 0,
    bossSegmentIndex: (p as { bossSegmentIndex?: number }).bossSegmentIndex ?? 0,
    statStages: [...safe(() => p.getStatStages(), [] as number[])],
    shiny: !!p.shiny,
    tera: !!p.isTerastallized,
  }));
  const balls: Record<string, number> = {};
  for (const [k, v] of Object.entries(scene.pokeballCounts ?? {})) {
    balls[k] = v as number;
  }
  return {
    wave: battle?.waveIndex ?? 0,
    turn: battle?.turn ?? 0,
    biome: enumName(BiomeId, scene.arena?.biomeId),
    battleType: battle ? enumName(BattleType, battle.battleType) : "NONE",
    double: !!battle?.double,
    money: scene.money,
    weather: scene.arena?.weather?.weatherType ?? null,
    terrain: scene.arena?.terrain?.terrainType ?? null,
    weatherName: scene.arena?.weather?.weatherType ? enumName(WeatherType, scene.arena.weather.weatherType) : null,
    terrainName: scene.arena?.terrain?.terrainType ? enumName(TerrainType, scene.arena.terrain.terrainType) : null,
    party,
    enemies,
    balls,
    items: scene.modifiers
      .filter(m => (m as { pokemonId?: number }).pokemonId === undefined)
      .map(m => ({ name: safe(() => m.type.name, m.constructor.name), count: m.getStackCount() })),
    terasUsed: scene.arena?.playerTerasUsed ?? 0,
    lockRarities: !!scene.lockModifierTiers,
  };
}
