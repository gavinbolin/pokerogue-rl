/**
 * One jsonl file per run. Record types (field "t"):
 *   start  - seed, team, options, game pin, features (live-UI features on; absent = none, older run)
 *   d      - a decision: step, wave, turn, kind, sub, phase, n (legal count), chosen index,
 *            chosen action id/label, rejected (game refused it), and (unless --no-obs)
 *            the observation + full legal action list, enough to train a policy on.
 *   wave   - wave transition: wave, partyHpFrac, alive, ms spent on the previous wave
 *   rej    - the game refused the previous decision's action
 *   resume - a run was resumed (replayed to this step) in a later session; `features` = the set used from
 *            here on (replays switch to it at this point)
 *   end    - cause, wave, wavesCleared, counts, timings
 */
import fs from "node:fs";
import path from "node:path";

export class RunLog {
  readonly file: string;
  private buf: string[] = [];

  /**
   * @param append   keep existing lines (resuming a run) instead of truncating
   * @param autoFlush write every record straight away (human play: nothing lost on a crash)
   */
  constructor(dir: string, name: string, opts: { append?: boolean; autoFlush?: boolean } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${name}.jsonl`);
    this.autoFlush = !!opts.autoFlush;
    if (!opts.append || !fs.existsSync(this.file)) {
      fs.writeFileSync(this.file, "");
    }
  }

  private readonly autoFlush: boolean;

  write(rec: Record<string, unknown>): void {
    this.buf.push(JSON.stringify(rec));
    if (this.autoFlush || this.buf.length >= 256) {
      this.flush();
    }
  }

  flush(): void {
    if (this.buf.length) {
      fs.appendFileSync(this.file, `${this.buf.join("\n")}\n`);
      this.buf = [];
    }
  }
}

/** The `d` record for decision `d` answered with index `i` (shared by batch runs and the server). */
export function decisionRecord(
  d: { step: number; wave: number; turn: number; kind: string; sub?: string; phase: string; prompt?: string; context?: unknown; actions: { id: string; label: string }[]; obs?: unknown },
  i: number,
  withObs: boolean,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const a = d.actions[i];
  const rec: Record<string, unknown> = {
    t: "d",
    step: d.step,
    wave: d.wave,
    turn: d.turn,
    kind: d.kind,
    sub: d.sub,
    phase: d.phase,
    n: d.actions.length,
    chosen: i,
    action: a.id,
    label: a.label,
    ...extra,
  };
  if (withObs) {
    rec.actions = d.actions;
    rec.context = d.context;
    rec.prompt = d.prompt;
    rec.obs = d.obs;
  }
  return rec;
}
