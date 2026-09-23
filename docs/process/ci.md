# CI

CI runs on [Depot CI](https://depot.dev/docs). Two workflow files describe it:

- `.depot/workflows/ci.yml` is the one that runs.
- `.github/workflows/ci.yml` is the same pipeline for GitHub Actions. The `CI`
  workflow is disabled in the repository settings and kept as the way back: re-enable it
  with `gh workflow enable CI` and it runs the same jobs.

**Change both files in the same commit.** They differ only where Depot needs
something GitHub cannot use, and each difference is listed in the comment at the
top of the Depot file. `depot ci migrate workflows --overwrite` regenerates the
Depot file from the GitHub one but drops those hand-made differences, so re-apply
them if you use it.

## Jobs

All jobs run in parallel. The run takes as long as the slowest one.

| Job | What it runs |
| --- | --- |
| `typecheck` | `tsc --noEmit`, `bun run lint`, the env-docs check |
| `test` (2 shards) | `bun run test --shard=N/2` |
| `pack` | build, pin check, pack, smoke tests of the packed packages |
| `ui-kit-browser` (2 shards) | `scripts/visual.mjs --shard=N/2`: every story on dark and on paper, and the visual baselines, in the pinned Playwright image |
| `changeset`, `leakage` | the changeset gate and the leakage gate |

The shard counts were chosen by measurement, recorded in PR #197. Adding a shard
pays off only while that job is the slowest one.

## The Playwright image copy (Depot only)

`ui-kit-browser` runs in `mcr.microsoft.com/playwright:<version>-noble`, the
image the visual baselines were generated in (D10). Downloading it from Microsoft's
registry took about 10s per job on Depot, so the Depot workflow pulls a copy from
Depot's own registry instead:

```
${{ vars.DEPOT_REGISTRY }}/ci/playwright:<version>-noble@sha256:<amd64 digest>
```

- The digest is MCR's own `linux/amd64` manifest digest. The copy holds the same
  bytes, so the baselines stay valid.
- `DEPOT_REGISTRY` is a Depot CI variable holding the organization's registry host
  (`<org-id>.registry.depot.dev`). It is a variable rather than a literal because
  this repository is public and the host carries the org ID.
- The job authenticates with the `DEPOT_TOKEN` that Depot CI injects into every
  job.

**When the Playwright pin moves** (a `playwright` bump in `packages/ui-kit`, which
also moves `scripts/visual.mjs` and the GitHub workflow), refresh the copy before
merging:

```sh
V=v1.64.0-noble                        # the new tag
REG=<org-id>.registry.depot.dev        # the value of DEPOT_REGISTRY
docker login $REG -u x-token           # password: a Depot user token
docker buildx imagetools create -t $REG/ci/playwright:$V mcr.microsoft.com/playwright:$V
docker buildx imagetools inspect mcr.microsoft.com/playwright:$V
docker buildx imagetools inspect $REG/ci/playwright:$V
```

`imagetools create` copies the multi-arch index registry to registry, so both
`inspect` calls must print the same top-level digest. It can run for over ten
minutes with no output while roughly 1GB of layers is copied.

Then put the new tag and the `linux/amd64` manifest digest (listed under
`Manifests:` in the `inspect` output) into `.depot/workflows/ci.yml`.

## Bun's package store cache

Without a cache every `bun install` downloads all ~880 packages. `ui-kit-browser`
caches bun's package store with `actions/cache`, keyed on the hash of
`bun.lock`. The other jobs do not cache yet.

Nothing needs maintaining. A lockfile change misses the cache once, installs from
the network, and saves a new entry. There are deliberately no `restore-keys`, so
old packages never pile up in the store. Old entries expire under the cache
backend's own eviction.

## Measuring

`gh api repos/schlessera/brain-kit/commits/<sha>/check-runs` gives start and end
times for every job on both systems. For step-level timing on Depot, use
`depot ci logs <attempt-id> --timestamps`.
