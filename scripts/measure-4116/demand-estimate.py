#!/usr/bin/env python3
"""#4116 demand estimate. usage: demand-estimate.py <repo> <commits.json> <vitest-files.json> <K> <LOAD> <FIXED> <FIRST_EXTRA> [--rows]
 Reads commits.json (collect.py), the Vitest file listing and
scripts/browser-shard-costs.json; prints per-merge pass cost and job duration at 2 and 5 repetitions."""
import json, statistics, sys, collections
root, COMMITS, LISTING = sys.argv[1:4]
K = float(sys.argv[4])          # isolated pass seconds per recorded weight second (measured)
LOAD = float(sys.argv[5])       # slowdown of a pass under the chosen load (measured)
FIXED = float(sys.argv[6])      # seconds before the first spec starts plus teardown (measured, hosted)
FIRST_EXTRA = float(sys.argv[7])  # extra seconds the first pass of a project pays (browser start, cold transform)
commits = json.load(open(COMMITS))["commits"]
listing = json.load(open(LISTING))
costs = json.load(open(f"{root}/scripts/browser-shard-costs.json"))["seconds"]
projects = collections.defaultdict(set)
for entry in [e for e in listing if "zz" not in e["file"] and "measure-3953" not in e["file"]]:
    path = "packages/" + entry["file"].rsplit("/packages/", 1)[1]
    projects[path].add(entry["projectName"].split(" (")[0])
median = {}
by = collections.defaultdict(list)
for key, sec in costs.items(): by[key.split("::")[0]].append(sec)
for p, v in by.items(): median[p] = statistics.median(v)
rows = []
for c in commits:
    if not c["specs"]: continue
    weight = 0.0; keys = 0; unweighted = 0; missing = 0; projs = set()
    for s in c["specs"]:
        ps = projects.get(s["path"])
        if not ps: missing += 1; continue
        for p in ps:
            keys += 1; projs.add(p)
            k = f"{p}::{s['path']}"
            if k in costs: weight += costs[k]
            else: unweighted += 1; weight += median.get(p, 1.0)
    rows.append({"sha": c["sha"][:9], "specs": len(c["specs"]), "keys": keys, "unweighted": unweighted, "missing": missing, "projects": len(projs), "weight": weight, "subject": c["subject"][:60]})
def job(row, n): return FIXED + FIRST_EXTRA * row["projects"] + row["weight"] * K * LOAD * n
def pct(values, q):
    values = sorted(values); return values[min(len(values) - 1, int(q * len(values)))]
print(f"merges changing a spec: {len(rows)} of {len(commits)}")
print("spec files per such merge: median", statistics.median(r["specs"] for r in rows), "max", max(r["specs"] for r in rows))
print("project/file keys without a recorded weight:", sum(r["unweighted"] for r in rows), "of", sum(r["keys"] for r in rows), "; spec files no longer in the tree:", sum(r["missing"] for r in rows))
w = [r["weight"] for r in rows]
print(f"recorded weight per pass (s): median {statistics.median(w):.0f} p75 {pct(w,.75):.0f} p90 {pct(w,.9):.0f} max {max(w):.0f}")
for n in (2, 5):
    d = [job(r, n) for r in rows]
    print(f"job at {n} repetitions (s): median {statistics.median(d):.0f} p75 {pct(d,.75):.0f} p90 {pct(d,.9):.0f} max {max(d):.0f}; over 10 min: {sum(x>600 for x in d)}, over 15: {sum(x>900 for x in d)}, over 20: {sum(x>1200 for x in d)}, over 25: {sum(x>1500 for x in d)}")
if "--rows" in sys.argv:
    for r in sorted(rows, key=lambda r: -r["weight"]): print(f"  {r['sha']} specs={r['specs']:3} keys={r['keys']:3} unweighted={r['unweighted']:3} weight={r['weight']:7.1f}s job2={job(r,2):6.0f}s job5={job(r,5):6.0f}s  {r['subject']}")
