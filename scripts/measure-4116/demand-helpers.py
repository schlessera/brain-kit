#!/usr/bin/env python3
"""#4116: for each non-spec file under the spec directories that the 150 merges changed, how many specs import it (transitively, relative imports only)."""
import json, os, re, subprocess, collections, statistics, sys  # demand-helpers.py <commits.json>
SPEC = re.compile(r"^(packages/ui-kit/tests/visual/.+\.visual\.tsx|packages/ui-react/tests/browser/.+\.(pointer|layout|offline|endurance)\.tsx|packages/ui-kit/stories/.+\.stories\.tsx?)$")
files = subprocess.run(["git", "ls-files", "packages/ui-kit/tests", "packages/ui-react/tests", "packages/ui-kit/stories", "packages/ui-kit/.storybook"], capture_output=True, text=True).stdout.split()
tracked = set(files)
IMPORT = re.compile(r"""(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}/[^"']+)["']""")
def resolve(src, spec):
    base = os.path.normpath(os.path.join(os.path.dirname(src), spec.split("?")[0]))
    for cand in (base, base + ".ts", base + ".tsx", base + ".mjs", base + ".js", base + "/index.ts", base + "/index.tsx", re.sub(r"\.js$", ".ts", base)):
        if cand in tracked: return cand
graph = {}
for f in files:
    if not re.search(r"\.(tsx?|mjs|js)$", f): continue
    try: text = open(f, encoding="utf8").read()
    except Exception: continue
    graph[f] = {r for r in (resolve(f, m) for m in IMPORT.findall(text)) if r}
def closure(f):
    seen, todo = set(), [f]
    while todo:
        for n in graph.get(todo.pop(), ()):
            if n not in seen: seen.add(n); todo.append(n)
    return seen
importers = collections.defaultdict(set)
specs = [f for f in files if SPEC.match(f)]
for s in specs:
    for dep in closure(s):
        if not SPEC.match(dep): importers[dep].add(s)
commits = json.load(open(sys.argv[1]))["commits"]
rows = []
for c in commits:
    if not c["helpers"]: continue
    selected = set()
    for h in c["helpers"]: selected |= importers.get(h, set())
    own = {s["path"] for s in c["specs"]}
    rows.append((c["sha"][:9], len(c["helpers"]), len(own), len(selected - own), c["subject"][:70]))
print(f"specs={len(specs)} helpers imported by a spec={len(importers)}")
fan = sorted(len(v) for v in importers.values())
print("specs importing a helper: median", statistics.median(fan), "p90", fan[int(.9*len(fan))], "max", fan[-1])
print(f"merges changing a helper file: {len(rows)}; of them without a changed spec: {sum(1 for r in rows if r[2]==0)}")
extra = sorted(r[3] for r in rows)
print("extra specs a helper rule would add per such merge: median", statistics.median(extra), "p75", extra[int(.75*len(extra))], "max", extra[-1], "; merges adding none:", sum(1 for e in extra if e == 0))
for r in sorted(rows, key=lambda r: -r[3])[:12]: print("  %s helpers=%d ownSpecs=%d extraSpecs=%d %s" % r)
top = sorted(importers.items(), key=lambda kv: -len(kv[1]))[:6]
for k, v in top: print("  most imported:", k, len(v))
