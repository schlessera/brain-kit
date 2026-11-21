# Admission overlap spike evidence (#4305)

Throwaway experiment against source `61b8b2e052fbb35b2a544ee6c42849d8fa592581`.
Bun 1.4.4; host bubblewrap 0.11.1. No product change is proposed here.
These files are retained only in this intermediate spike commit, then removed
from the PR landing tree. The PR body carries the decision and limitations.

Reproduce from this commit (with frozen dependencies), behind the shared heavy
lock and with TMPDIR on an owned filesystem outside /tmp:

```sh
bun run test ./scripts/measurements/admission-overlap-4305/admission-spike.test.ts ./scripts/measurements/admission-overlap-4305/overlap-safety.test.ts
```

`admission-results.json` keeps all paired samples. Setup and cleanup are outside
measured intervals; ordering alternates baseline/variant, then variant/baseline.
No warmup rows are discarded. C1, C3 and C5 have 15 pairs; C2 has 40, C4 100,
C6 three. C6 uses complete offline byte-copy fixtures: its timings are NOT
Btrfs snapshot timings. Workspace entries stay in their read-only default mode;
no writable workspace alias walk was enabled. Tree seeding uses the exact
large-scenario helper, with 80000 workspace leaves, 19000 dependency leaves,
30000 journal objects and 40 checkout roots. No cache-drop operation ran.

The real worker namespace probe, sandbox planner, sandboxed Git query, policy
reader and FULL SQLite write worker run locally. The six experiments time
components, not a hosted turn, backend/model request, provider or native broker.
C1 compares pure policy/mount preparation after/alongside a real probe. C2 batches
only recordPolicy+manifestBegin via their production writers, not the entire
admission sequence. C3 has both an intentionally unsafe process-pass reuse and
a narrower two-probes-to-one per-turn prototype. C4 measures the three mount
queries observed during one real sandbox resolution, with equal returned sets.
C5 replaces only brainGitSteps with a cached success, retaining all other
sandbox checks. Changing .git/info/exclude while holding .gitignore constant
changes the real Git answer: the supposed ignore-only dependency is false.
C6 removes the offline startup acquisition entirely: it is an unsafe upper
bound, not an admitted no-checkpoint turn.

Native attempt:

```sh
bun scripts/prove-native-host.ts --backend=claude --app-uid=1000 --observation-timing --tree=large
```

It exited 1 before admission: `PermissionError: [Errno 13] Permission denied:
'/dev/loop-control'`. The fixture's cleanup receipt reports mounted=false,
attached=false, loopCreated=false, backingExists=false, errors=[]; the parent
user-namespace quota is unchanged. No native observation timings were produced.

Safety mutation (on a separate byte-identical copy of overlap-prototype.ts):
move effect(prepared) before `await admitted`, retaining the await. Command:

```sh
bun run test ./.wi-logs/overlap-mutation/overlap-safety.test.ts
```

Red: `NO_EFFECT_BEFORE_ADMISSION` expected 0, received 1; and
`REFUSED_ADMISSION_LEAVES_NOTHING_BEHIND` received an extra effect.md.
Restore overlap-prototype.ts byte-for-byte from this source; same command:
2 pass, 0 fail, 9 assertions. Both red and restored logs are retained.
This proves the prototype's join, not the product's full admission or native
crash cleanup. No shipped behavior changes, so a product failing-first receipt
is not applicable. The unsafe early-effect behavior is the failing-first
prototype and mutation control.
