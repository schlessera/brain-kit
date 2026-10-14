# Scope observer proof

The long single Bash loop in `packages/ui-server/tests/turn-scope.test.ts`
controls only the interval registered while the real journal begins. It
advances the captured production callback to 14,999 and 15,000 logical
milliseconds after the independent native observer has recorded the writer
crossing its 20-file cap, then reaching at least 22 files so overshoot must be positive. `Date.now`, `Bun.sleep`, the shell's 50 ms write
cadence and the observer process's 20 ms interval remain real. Production
code, scheduling defaults and namespace/offline guards are unchanged.

The original copied native-journal fixture remains the storage boundary:
real files, checkpoint copies, delta parsing and retention. This case does
not claim a native Btrfs checkpoint; native storage proof remains separately
owned. Its writer, freezer, process tree and Stop lifecycle are real.

## Assertion map

| Existing guarantee | Retained or strengthened proof |
| --- | --- |
| File cap is reached independently | The separate process records `count >= 20` before host time advances; receipt dimension is still `files_changed`. |
| `SCOPE_FROZEN_WITHIN_OBSERVATION_INTERVAL` | Retains the real crossing-to-freeze upper bound. Registered delay is exactly 15,000 ms; no observation/freeze at 14,999; actual callback dispatch and completed observation at 15,000. |
| `SCOPE_EXTERNAL_WRITER_PROGRESS_STOPS_BEFORE_RETENTION` | Retains final external count equality and checks kernel shell/sleep stop states (or confirmed frozen cgroup) before the real checkpoint begins. |
| `SCOPE_EXTERNAL_OBSERVER_CONFIRMS_PAUSE_DURING_CAPTURE` | Retains the post-freeze external sample beyond 150 ms and adds all-sample count stability, before and across the real checkpoint. |
| `SCOPE_COUNT_TAKEN_AFTER_CONFIRMED_FREEZE` | Retains receipt versus live-file equality and additionally compares the actual copied snapshot count. |
| Exact overshoot and `SCOPE_OBSERVATION_RATE_BOUND` | Retains `count - 20` and the original maximum of 300 files; requires positive native overshoot so an always-zero receipt fails. |
| `SCOPE_LONG_BASH_REALLY_FROZEN` | Retains the final real 150 ms no-progress window and checks at least five independent observer ticks with unchanged counts. |
| Writer has not finished | Retains absent `finished` marker from the original 10,000-write loop. |
| Stop and child exit | Retains Stop and awaited exit, adds accepted decision and SIGKILL exit-code assertions. |
| Shutdown | Adds cancellation of the actual captured interval handle and no dispatch across two subsequent deadlines; restores both complete global timer descriptors even on failure. |

An added cleanup-failure control checks that every teardown action is attempted, errors are collected, full timer descriptors are restored and a successor uses native scheduling. No other existing case changes its coverage or timing. The two
periodic productive-worker/capture-failure cases still use their native
15-second intervals.

## Real-time minimum and execution ownership

Before snapshot capture, the independent observer must supply at least eight
20 ms ticks spanning at least 150 real milliseconds, with a stable count.
This distinguishes native absence of progress from a host callback merely
claiming to freeze. The final 150 ms window remains: it spans three possible
50 ms writes and normally seven observer ticks, and explicitly requires at
least five ticks. A single instant or a host logical clock cannot establish
that a separately scheduled native writer remained stopped. These windows
belong to expensive candidate native confirmation under the repository's
execution-tier policy; default test discovery and selected proof requirements
are unchanged here. The 10,000-write fixture lifetime is cancelled by Stop,
not awaited as test duration. Polling deadlines are failure bounds, not claimed
elapsed savings.
