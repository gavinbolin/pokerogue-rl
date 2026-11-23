/**
 * One jsonl file per run. Record types (field "t"):
 *   start  - seed, team, options, game pin
 *   d      - a decision: step, wave, turn, kind, sub, phase, n (legal count), chosen index,
 *            chosen action id/label, rejected (game refused it), and (unless --no-obs)
 *            the observation + full legal action list, enough to train a policy on.
 *   wave   - wave transition: wave, partyHpFrac, alive, ms spent on the previous wave
 *   end    - cause, wave, wavesCleared, counts, timings
 */
import fs from "node:fs";
import path from "node:path";

export class RunLog {
  readonly file: string;
  private buf: string[] = [];

  constructor(dir: string, name: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(this.file, "");
  }

  write(rec: Record<string, unknown>): void {
    this.buf.push(JSON.stringify(rec));
    if (this.buf.length >= 256) {
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
