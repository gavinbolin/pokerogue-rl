/**
 * Seeded random starter team under the Endless point cap (15 by default).
 * Uniform over affordable, not-yet-picked starters until nothing fits or the party has 6.
 * No preferences or heuristics: this is just a random legal team draw.
 */
import { speciesDataRegistry } from "#app/global-species-data-registry";
import type { SpeciesId } from "#enums/species-id";
import { seeded } from "./rng.ts";

export interface Team {
  speciesIds: number[];
  costs: number[];
  points: number;
  cap: number;
}

export function drawTeam(seed: string, cap = 15, maxSize = 6): Team {
  const rand = seeded(`team:${seed}`);
  const all = (speciesDataRegistry.getAllStarters() as number[]).slice().sort((a, b) => a - b);
  const cost = (id: number) => Number(speciesDataRegistry.getStarterCost(id as SpeciesId)) || 0;
  const picked: number[] = [];
  let left = cap;
  while (picked.length < maxSize) {
    const pool = all.filter(id => !picked.includes(id) && cost(id) > 0 && cost(id) <= left);
    if (pool.length === 0) {
      break;
    }
    const id = pool[Math.floor(rand() * pool.length)];
    picked.push(id);
    left -= cost(id);
  }
  return { speciesIds: picked, costs: picked.map(cost), points: cap - left, cap };
}

export function fixedTeam(ids: number[], cap = 15): Team {
  const costs = ids.map(id => Number(speciesDataRegistry.getStarterCost(id as SpeciesId)) || 0);
  return { speciesIds: ids, costs, points: costs.reduce((a, b) => a + b, 0), cap };
}
