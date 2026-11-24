import json, sys, math
for fn in sys.argv[1:]:
    rs = [json.loads(l) for l in open(fn)]
    rs = [r for r in rs if r["ballMult"] != -1 and r["mcr"] < 255]
    E = [0.0]*4; O = [0]*4
    for r in rs:
        q = r["shakeProb"]/65536; c = r["critChance"]/256
        p = [(1-c)*(1-q), (1-c)*q*(1-q) + c*(1-q), (1-c)*q*q*(1-q), c*q + (1-c)*q**3]
        for i in range(4): E[i] += p[i]
        k = 3 if r["caught"] else r["shakes"]-1
        O[k] += 1
    chi = sum((O[i]-E[i])**2/E[i] for i in range(4))
    print(fn, "n", len(rs), "fail@1,2,3,caught obs", O, "exp", [round(e,1) for e in E], "chi2(3df) %.2f" % chi)
