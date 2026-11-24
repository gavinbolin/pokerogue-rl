import json, sys, math
from collections import defaultdict
recs = [json.loads(l) for l in open(sys.argv[1], encoding="utf-8") if l.strip()]
print(f"{len(recs)} throws, caught {sum(r['caught'] for r in recs)} ({100*sum(r['caught'] for r in recs)/max(len(recs),1):.1f}%)")
BALL = {0: "Poke", 1: "Great", 2: "Ultra", 3: "Rogue", 4: "Master"}
def table(name, key):
    g = defaultdict(list)
    for r in recs:
        g[key(r)].append(r)
    print(f"\n{name:<22}{'n':>6}{'caught%':>9}{'expected%':>11}{'z':>7}")
    for k in sorted(g, key=str):
        rs = g[k]; n = len(rs); c = sum(r["caught"] for r in rs); e = sum(r["expected"] for r in rs)
        v = sum(r["expected"] * (1 - r["expected"]) for r in rs)
        z = (c - e) / math.sqrt(v) if v > 0 else 0.0
        print(f"{str(k):<22}{n:>6}{100*c/n:>9.1f}{100*e/n:>11.1f}{z:>7.2f}")
table("ball", lambda r: BALL.get(r["ball"], r["ball"]))
table("hp", lambda r: "hp=100%" if r["hpFrac"] >= 0.999 else ("hp 50-99%" if r["hpFrac"] >= 0.5 else ("hp 20-49%" if r["hpFrac"] >= 0.2 else "hp <20%")))
table("status", lambda r: "none" if not r["status"] else f"status {r['status']} x{r['statusMult']}")
table("boss", lambda r: "boss" if r["boss"] else "wild")
table("crit chance", lambda r: "crit>0" if r["critChance"] > 0 else "crit=0")
table("expected decile", lambda r: f"p {int(min(r['expected'],0.999)*10)/10:.1f}-{int(min(r['expected'],0.999)*10)/10+0.1:.1f}")
c = sum(r["caught"] for r in recs); e = sum(r["expected"] for r in recs); v = sum(r["expected"]*(1-r["expected"]) for r in recs)
print(f"\noverall caught {c} expected {e:.1f} z {(c-e)/math.sqrt(v) if v else 0:.2f}")
sh = defaultdict(int)
for r in recs:
    if not r["caught"]: sh[r.get("shakes")] += 1
print("failed throws by shake count:", dict(sh))
