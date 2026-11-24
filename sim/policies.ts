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

/** Test policy for capture checks: when a ball is available, throws a random one with probability throwProb (catch: 1,
 * catch_late: 0.25, so foes are often damaged / statused first), else acts at random. */
export function catchPolicy(seed: string, throwProb = 1): Policy {
  const r = seeded(`policy:${seed}`);
  return d => {
    const balls = d.actions.map((a, i) => (a.id.startsWith("ball:") ? i : -1)).filter(i => i >= 0);
    return balls.length && r() < throwProb ? balls[Math.floor(r() * balls.length)] : Math.floor(r() * d.actions.length);
  };
}

export function makePolicy(name: string, seed: string): Policy {
  switch (name) {
    case "random":
      return randomPolicy(seed);
    case "catch":
      return catchPolicy(seed);
    case "catch_late":
      return catchPolicy(seed, 0.25);
    default:
      throw new Error(`unknown policy ${name} (available: random, catch, catch_late)`);
  }
}
