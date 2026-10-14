# Product proof domains

Default execution ownership is discovered, not copied into a static test
allowlist. `bun run test:inventory` writes `tmp/proof-inventory.json`; CI publishes
it with the metadata artifact. Each row has a runner/project/file identity,
its domain, source test declarations and assertion line locations. An assertion
inside a parameterized test runs for every collected case: the inventory does
not pretend source declarations are runtime test counts. Actual suite reports
remain authoritative for collected cases, skips, assertions and outcomes.
Imported/shared helper assertions retain their existing callers and full runs;
the source-location index is navigation, not a completeness proof by counting.

| Existing scenario family | Default domain | Intermediate push | Final candidate |
| --- | --- | --- | --- |
| Curated contract/integrity files in `FAST_TESTS` | Fast | Affected subset with strict types | Included once by complete affected unit discovery |
| Every other product Bun test in `packages/` and `tests/` | Unit confirmation | Deferred | Complete affected discovery plus root tests |
| Storybook dark/light, visual, pointer and isolated browser projects | Browser confirmation | Deferred | Every discovered project/file instance in the existing two shards |
| `.layout.tsx` and `.offline.tsx` in `ui-react-layout` | Layout confirmation | Deferred | Every discovered project/file instance in the existing two shards |
| `.endurance.tsx` in `ui-react-endurance` | Endurance confirmation | Deferred | Every discovered file in a separate concurrent job |
| Native permission/enforcement/delegation/capability/host/cleanup probes | Runtime confirmation | Deferred | Existing complete command inventory and offline namespaces |
| Packed consumer probes and editorial capture verification | Packaging/capture confirmation | Deferred | Existing affected commands, pins and artifacts |

A project/file instance is a distinct execution: for example, the recordings
tray's layout and three native pointer cases intentionally remain separate.
The same scenario is never assigned to both ordinary and endurance projects.
Unknown ordinary tests join full confirmation; unknown browser costs are listed
as unmeasured, never skipped. A `.endurance.tsx` outside the endurance project,
a duplicate project/file identity, or an undiscovered browser leaf fails metadata.
The separate endurance project never participates in ordinary shard balancing.
#1836 owns broader cost-table refresh; this split does not invent new weights.

The classification follows purpose and measured cost, not an arbitrary duration
cutoff: native browser/media/permission and packaging proof needs its complete
environment; fast feedback is the existing curated keyless contract/integrity
subset. The recording cap's measured ten-minute real media path has a temporal
claim that short deadline logic alone cannot establish. No assertion moves to
an optional command. Adding a long temporal scenario requires explaining its
wall-clock purpose and retaining final confirmation; all unknown cases are
conservatively final until deliberately classified.

## Recording assertion mapping

#1853 separates short limit correctness from native duration endurance. Every
other test in `recordings.offline.tsx` remains ordinary layout proof, including
quota failures, auth/partition boundaries, interrupted/reloaded pages, tab
ownership, microphone/update-hold ordering and cleanup. Short threshold and
warning logic lives in `recording-limits.offline.tsx` with real media proof.

The original “the 10-minute-5-second fixture stops at the hard duration cap
with warning, copy and playable audio” scenario moves to
`recordings.endurance.tsx` as “ten-minute native endurance preserves sustained
commits, full-length decode and resource cleanup”. All original assertions
remain; the extracted scenario additionally proves sustained sequential commits,
chunk continuity and byte totals, complete-content hashing, microphone/lock/
update-hold release, and playback URL revocation. Its assertion mapping is:

| Retained assertion/obligation | Execution |
| --- | --- |
| Real generated 10m05s microphone input and native MediaRecorder encoding | Endurance |
| Automatic completion before 605000ms with the original 650000ms test deadline | Endurance |
| Persisted saved-through boundary greater than 598000ms and at most 600000ms | Endurance |
| Exactly one warning and the exact saved-at-limit message | Endurance; short correctness separately tests deadline transitions |
| Persisted playback URL and native AudioContext decoding | Endurance |
| Decoded duration greater than 598s and at most 600.1s | Endurance |
| Microphone restoration, playback revocation, audio context/store/database cleanup | Endurance, through the unchanged fixture lifetime |

The old file's temporary side-effect import is removed when standalone discovery
lands, so the long scenario executes once. The split preserves the browser pin,
`--network=none`, real APIs and product limits. Full local checks include both
ordinary and endurance commands; standalone commands remain convenient.

## Independent tiers

Experiment-only harness tests stay under `experiments/` and the release-time
`test:experiments` policy. Paid live-provider tests remain explicit opt-ins and
unmeasured here; they are not product endurance. Neither tier is admitted into
ordinary product discovery by renaming a file.

For cadence, identity validation and required evidence, see
[the CI decision](../decisions/ci-utility.md) and [testing](testing.md#required-proof-for-a-pr).
