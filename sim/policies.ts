/**
 * Policies map a Decision to an index into decision.actions. They may be async, so the same
 * interface serves a learned model behind a bridge, or a human picking from a list.
 */
import type { Decision } from "./env.ts";
import { seeded } from "./rng.ts";

export type Policy = (d: Decision) => number | Promise<number>;

/** Uniform over the legal actions. Seeded per run so runs are reproducible. */
export function randomPolicy(seed: string): Policy {
  const r = seeded(`policy:${seed}`);
  return d => Math.floor(r() * d.actions.length);
}

export function makePolicy(name: string, seed: string): Policy {
  switch (name) {
    case "random":
      return randomPolicy(seed);
    default:
      throw new Error(`unknown policy ${name} (available: random)`);
  }
}
