#!/usr/bin/env python3
"""#4116 demand: which of the 150 most recent first-parent commits on main changed a Vitest spec."""
import json, re, subprocess, sys
HEAD, OUT = sys.argv[1], sys.argv[2]  # collect.py <ref> <commits.json>
git = lambda *a: subprocess.run(["git", *a], check=True, capture_output=True, text=True).stdout
shas = git("log", "--first-parent", "-150", "--format=%H", HEAD).split()
SPEC = re.compile(r"^(packages/ui-kit/tests/visual/.+\.visual\.tsx|packages/ui-react/tests/browser/.+\.(pointer|layout|offline|endurance)\.tsx|packages/ui-kit/stories/.+\.stories\.tsx?)$")
HELPER_DIRS = ("packages/ui-kit/tests/visual/", "packages/ui-react/tests/browser/", "packages/ui-kit/stories/", "packages/ui-kit/.storybook/")
out = []
for sha in shas:
    subject = git("log", "-1", "--format=%s", sha).strip()
    specs, helpers, deleted = [], [], []
    for line in git("diff-tree", "--no-commit-id", "-r", "-M", "--name-status", f"{sha}^", sha).splitlines():
        parts = line.split("\t"); status, path = parts[0][0], parts[-1]
        if status == "D":
            if SPEC.match(path): deleted.append(path)
            continue
        if SPEC.match(path): specs.append({"path": path, "status": status})
        elif path.startswith(HELPER_DIRS) and re.search(r"\.(tsx?|mjs|css|json|html)$", path) and "__screenshots__" not in path: helpers.append(path)
    out.append({"sha": sha, "subject": subject, "specs": specs, "helpers": helpers, "deletedSpecs": deleted})
json.dump({"head": git("rev-parse", HEAD).strip(), "commits": out}, open(OUT, "w"), indent=1)
n = sum(1 for c in out if c["specs"]); h = sum(1 for c in out if c["helpers"] and not c["specs"])
print(f"commits={len(out)} changedSpec={n} helperOnly={h} first={out[-1]['sha'][:9]} last={out[0]['sha'][:9]}")
