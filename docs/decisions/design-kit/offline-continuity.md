# Design kit — offline continuity

Part of the [design-kit decision record](../design-kit.md). Entries retain their
original dates and order within this subject; the index maps the complete chronology
and relationships with [other subjects](../design-kit.md#subjects).

<a id="2026-10-08--offline-continuity-and-committed-recording-boundaries-1023"></a>

## 2026-10-08 — Offline continuity and committed recording boundaries (#1023)

The [September 30 rulings](https://github.com/schlessera/brain-kit/issues/578)
choose deferred explicit transcription, bounded persistent audio and minimal
cached cold capture. The [October 4 reconciliation](https://github.com/schlessera/brain-kit/issues/578#issuecomment-5980965363),
[approved October 5](https://github.com/schlessera/brain-kit/issues/578#issuecomment-5998617047),
replaces the conflicting proposal: auth loss stops capture and removes
protected views; IndexedDB partitioning makes no device-protection claim;
committed boundaries replace a one-second loss promise. The speech and account
rationale lives in [dictation-speech.md](../dictation-speech.md#2026-10-08--local-capture-and-explicit-saved-audio-transcription-1023)
and [session-principals.md](../session-principals.md#2026-10-08--device-local-account-partitions-and-auth-transitions-1023).

<a id="preserve-work-through-transport-loss"></a>

### Preserve work through transport loss

A warm transport outage keeps the established UI mounted
(`if (vpnStatus === "connected" || everConnected)`,
`packages/ui-react/src/components/connectivity/connection-gate.tsx:193-207`).
Connectivity feedback uses stable slots and an overlay; Send availability is
separate from editing. Replayed history reconciles with drawn chronological
parts, preserving answer/card/image identity rather than redrawing the reading
area. Transport recovery restores capability without submitting new local work.
The [real-host continuity proof](https://github.com/schlessera/brain-kit/pull/1232)
drives repeated drop/reconnect cycles at phone and desktop widths in dark and
paper Chromium cells, plus native IME and late-history cases. Its fixed initial
geometry baseline detects cumulative movement of the field and first visible
message; a cumulative geometry mutation fails it. This is pinned desktop
Chromium runtime evidence,
not Safari, Android or OS interruption coverage.

The device-local snapshot adopts the existing per-session draft identities
from [#951](https://github.com/schlessera/brain-kit/issues/951#issuecomment-6028717821),
so reload/auth recovery does not create a second draft store. Failed storage
shows the save failure and keeps editing in memory; it cannot claim that the
new edit is kept. Staged tracks remain in this tab only, including hidden-view
queues. Their [update hold](https://github.com/schlessera/brain-kit/issues/1112#issuecomment-6032010851)
and [manual-leave warning](https://github.com/schlessera/brain-kit/issues/1150#issuecomment-6033781561)
do not turn them into durable attachments.

D31's loud stale-client boundary remains. A per-root hold registry extends the
existing reload guard for drafts, staged tracks, live/draining dictation, review
text, capture/finalization, unaccepted transcripts, transcription and account
interaction. Busy local work defers update reload; holding a reload is not a
new error state (`registerBuiltInUpdateHolds`,
`packages/ui-react/src/lib/update-holds.ts:78-104`). The
[update proof](https://github.com/schlessera/brain-kit/pull/1194) observes actual
controller changes and reload counts. Live dictation hands words to review in
one update, including the [provider-ended path](https://github.com/schlessera/brain-kit/pull/1220),
so an empty textarea cannot release the hold while speech still awaits review.

<a id="recording-review-and-retention"></a>

### Recording, review and retention

Capture is explicit, visibly device-local, and never silently restarts on
launch, reconnect or permission grant. The sheet reports recording, remaining
capacity and Stop/confirmed Discard; timer ticks are not live announcements.
The tray distinguishes saved, interrupted, transcribing, failed and
transcript-ready audio. Playback and review remain local. Transcribe requires
its explicit upload confirmation and the server capability. Add to draft
persists the chosen draft and its receipt before accepted metadata/deletion;
failure keeps the recording. It never sends a message or answers an approval
(`async accept`, `packages/ui-react/src/lib/recordings.ts:651-679`).
The [tray runtime proof](https://github.com/schlessera/brain-kit/pull/1241)
measures focus, reading-anchor preservation, playback, failed writes and native
transaction ordering. Surviving transcript text remains reviewable even if its
audio is lost; ambiguous acceptance cleanup retains audio for playback/discard.

The [retention ruling](https://github.com/schlessera/brain-kit/issues/578#issuecomment-5907064902)
sets **10 minutes per recording** and **100 MiB aggregate retained audio per
origin/device, across account and unassigned partitions**, with no age expiry
and no eviction to admit a new recording (`RECORDING_MAX_MS`,
`packages/ui-react/src/lib/recordings.ts:9-12`). The lower browser capacity
wins. Estimates are advisory; write success determines what exists
(`async function budget`, `packages/ui-react/src/lib/recordings.ts:191-201`).
Limits stop capture and keep a contiguous playable prefix, rather than cutting
an encoded chunk or deleting older work. Both quota and blob I/O errors stop
writes. The [store runtime proof](https://github.com/schlessera/brain-kit/pull/1230)
includes real elapsed ten-minute capture, failure forms, ordered/hash-checked
chunks and crash recovery.

**Saved up to** is the last chunk end whose chunk/index transaction completed,
not elapsed UI time or the requested MediaRecorder interval
(`const next =`, `packages/ui-react/src/lib/recordings.ts:291-307`). Requested
intervals and warning/minimum-budget defaults are tuning, never promises.
[#1250's measured fixture correction](https://github.com/schlessera/brain-kit/pull/1253)
further demonstrates why a visible recording sheet or a timeslice deadline is
not evidence of a durable chunk: the fixture now awaits the actual root-owned
commit before its unchanged saved-boundary/focus assertions. That test change
adds no recording capability or loss guarantee.

<a id="warm-use-cached-cold-capture-and-uncached-launch"></a>

### Warm use, cached cold capture and uncached launch

Cold launch is a separate capability, not warm reconnect with remembered auth.
With durable capture enabled and a controlling worker that precached the shell,
the gate renders the eager local screen; it never opens protected chat/history.
A fresh page's new recordings are unassigned, with only aggregate locked audio
size visible. Server reachability alone neither adopts an account nor changes
the screen. **Continue** waits for startup recovery and drains initializing/live
capture before entering the normal gate/login
(`const leave`, `packages/ui-react/src/components/connectivity/local-capture-screen.tsx:94-99`).
Same-account authentication unlocks account work; unassigned audio still needs
explicit selected-only association before upload.

The [cold-launch runtime proof](https://github.com/schlessera/brain-kit/pull/1247)
uses an actual worker and cached/uncached fresh pages. The SDK owns NetworkOnly
API policy and navigation fallback; the generated worker entry, precache/web-app
manifests, index and offline pages belong to the public hosting template
([shell counterpart #11](https://github.com/schlessera/brain-hosting-template/issues/11)).
A first-ever uncached offline visit cannot boot this UI. Serving a capture view
requires prior successful online loading and retained cached assets; it is not
a blanket offline-ready claim. No authenticated API cache or full offline
history is approved. Host configuration prerequisites and user limits are in
[the hosting guide](../../hosting/README.md#offline-use-and-local-recordings).

<a id="desktop-browser-measurements-and-their-limits"></a>

### Desktop browser measurements and their limits

All distributions below reproduce the
[V1 finding of October 7](https://github.com/schlessera/brain-kit/issues/1010#issuecomment-6039141756),
whose repeatable probe is [PR #1204](https://github.com/schlessera/brain-kit/pull/1204)
under `scripts/probes/audio-commit-boundary/`, outside published packages.
Conditions: Playwright **1.63.0**, image
`mcr.microsoft.com/playwright:v1.63.0-noble`, Ubuntu **24.04.4 LTS**, host Linux
**7.2.5**, headed Xvfb without a window manager. Chromium **153.0.8010.12**
used a seeded **48 kHz** fake-microphone WAV; Firefox **155.0** used its native
fake stream. Both recorded **WebM/Opus**, requested **1000 ms** timeslices, and
committed each delivered chunk and index boundary in one IndexedDB transaction.
Loss is measured from recorder start to the observed interruption: **index
loss** subtracts the last committed delivery-time boundary; **playable loss**
subtracts the same-engine decoded duration of concatenated committed chunks.
These are probe observations under this stop policy, not product guarantees.

Main run: **seven runs per measured cell**; milliseconds **min / median / max**.
Every row is from the linked V1 finding above.

| Browser | Observed interruption | Index loss (ms) | Playable loss (ms) | Surviving storage, all seven runs |
| --- | --- | --- | --- | --- |
| Chromium desktop | Tab close, no unload | 24 / 436 / 789 | 22 / 437 / 785 | Index + some chunks |
| Chromium desktop | Renderer crash (`Page.crash`) | 7 / 463 / 820 | 9 / 466 / 820 | Index + some chunks |
| Chromium desktop | Whole browser SIGKILL | 109 / 453 / 739 | 111 / 452 / 741 | Index + some chunks |
| Chromium desktop | Hidden behind another tab for 6 s, then SIGKILL | 119 / 415 / 822 | 122 / 412 / 821 | Index + some chunks |
| Chromium desktop | Simulated capture-track end | −1 / −1 / −1 | −54 / −38 / −8 | Index + all chunks |
| Chromium desktop | Full disk, stop on first failed write | 1018 / 1021 / 1026 | 1017 / 1022 / 1025 | Index + some chunks |
| Firefox desktop | Tab close, no unload | 45 / 546 / 897 | 44 / 546 / 898 | Index + some chunks |
| Firefox desktop | Tab content processes SIGKILL | 274 / 404 / 643 | 276 / 406 / 645 | Index + some chunks |
| Firefox desktop | Whole browser SIGKILL | 53 / 361 / 743 | 53 / 362 / 746 | Index + some chunks |
| Firefox desktop | Simulated capture-track end | −12 / −8 / −3 | −27 / −12 / −1 | Index + all chunks |
| Firefox desktop | Full disk, stop on first failed write | 999 / 1000 / 1002 | 1002 / 1004 / 1006 | Index + some chunks |

A separate confirmation invocation of the final probe ran **five runs per cell**
under the same versions/timeslice/source conditions. Its **index-loss**
distributions (ms, min / median / max), also from V1, are:

| Browser | Case | Index loss (ms) |
| --- | --- | --- |
| Chromium desktop | Whole browser SIGKILL | 265 / 666 / 996 |
| Chromium desktop | Hidden then SIGKILL | 86 / 541 / 857 |
| Chromium desktop | Full disk | 1020 / 1022 / 1024 |
| Firefox desktop | Whole browser SIGKILL | 317 / 525 / 789 |
| Firefox desktop | Full disk | 999 / 1000 / 1000 |

No interrupted run lost its index or a previously committed chunk. **Index +
some chunks** means a recoverable prefix missing the unsaved tail, not deletion
of already committed chunks. Negative track-end loss reflects decoder padding
and recorder-start lag, not extra captured speech. The final track-end chunk
committed, but that simulated event says nothing about an incoming call. Kill
observations stayed below the requested interval; full-disk failures lost about
one chunk under the probe's stop-on-first-write-error policy. Neither result
establishes a universal tail-loss bound or background-capture promise.

Single capability reports per engine under those same V1 conditions found:

| Primitive | Chromium 153.0.8010.12 | Firefox 155.0 | Playwright Linux WebKit 26.6 |
| --- | --- | --- | --- |
| MediaRecorder | Present | Present | Absent |
| WebM/Opus support | Yes | Yes | No |
| MP4 support | Yes (capability only; interruption runs used WebM) | No | No |
| Default recorder container | WebM/Opus | Ogg/Opus (probe explicitly chose WebM) | None |
| IndexedDB Blob round-trip | Passed | Passed | Passed |
| Storage persistence request | Returned false | Did not settle within 3 s; prompt unanswered | Returned false |

A separate single Chromium visibility capability trial delivered and committed
**ten chunks in ten seconds hidden**, still at the requested **1000 ms**
interval. The single CDP freeze trial produced **four chunks during a five-second
freeze request**, with no freeze event: it failed to induce a freeze and is
**not** a freeze measurement. The full-disk runs used a **48 MiB** disk;
Chromium still estimated **1 GiB** quota/zero usage, while Firefox reported
**10 MiB** quota. Chromium failed with blob `DataError`/IOError; Firefox with
`QuotaExceededError`. These V1 results explain why estimates/persistence requests
cannot establish durable capture or free physical space.

<a id="unmeasured-cells-and-detectable-storage-loss"></a>

### Unmeasured cells and detectable storage loss

The [October 7 desktop-suffices ruling](https://github.com/schlessera/brain-kit/issues/1010#issuecomment-6040793673)
permits dependent work on the desktop results. The
[later scope ruling](https://github.com/schlessera/brain-kit/issues/1010#issuecomment-6045077836)
keeps Safari unmeasured and transfers attainable Android/OS/lock cells to
[#1236](https://github.com/schlessera/brain-kit/issues/1236). None of the
following is inferred from desktop tests or documentation. Every row links the measurement handoff for context. #1236 owns the attainable
Android, real OS interruption and screen-lock measurements; it does not expand
to the desktop/storage omissions below, and Safari remains excluded by the
ruling.

| Cell | Finding and reason | Tracking |
| --- | --- | --- |
| Android Chromium, every capture/interruption cell | **NOT MEASURED**: no device in V1; emulator measurements not supplied | [#1236](https://github.com/schlessera/brain-kit/issues/1236) |
| Safari macOS, every cell | **NOT MEASURED**: no available Apple device; Linux WebKit is not Safari | [#1236 scope exclusion](https://github.com/schlessera/brain-kit/issues/1236), [maintainer ruling](https://github.com/schlessera/brain-kit/issues/1010#issuecomment-6045077836) |
| Safari iOS tab, every cell | **NOT MEASURED**: no available Apple device | [#1236 scope exclusion](https://github.com/schlessera/brain-kit/issues/1236), [maintainer ruling](https://github.com/schlessera/brain-kit/issues/1010#issuecomment-6045077836) |
| Safari iOS installed PWA, every cell | **NOT MEASURED**: no available Apple device; no inference from tab/emulator behavior | [#1236 scope exclusion](https://github.com/schlessera/brain-kit/issues/1236), [maintainer ruling](https://github.com/schlessera/brain-kit/issues/1010#issuecomment-6045077836) |
| Linux WebKit 26.6, every recording-interruption cell | **NOT MEASURED**: its MediaRecorder is absent | [V1](https://github.com/schlessera/brain-kit/issues/1010#issuecomment-6039141756), [#1236 handoff](https://github.com/schlessera/brain-kit/issues/1236) |
| Firefox hidden-then-kill / hidden delivery | **NOT MEASURED**: separate windows and no window manager prevented hiding a tab | [V1](https://github.com/schlessera/brain-kit/issues/1010#issuecomment-6039141756), [#1236 handoff](https://github.com/schlessera/brain-kit/issues/1236) |
| Real OS microphone interruption, any browser | **NOT MEASURED**: only track end was simulated; no call/OS event was produced | [#1236](https://github.com/schlessera/brain-kit/issues/1236) |
| Screen lock / actual background freeze, any browser | **NOT MEASURED**: container cannot lock a real screen; Chromium ignored CDP freeze | [#1236](https://github.com/schlessera/brain-kit/issues/1236) |
| Browser eviction and private-mode lifetime, per browser | **NOT MEASURED**: V1 neither provoked eviction nor ran private profiles | [V1](https://github.com/schlessera/brain-kit/issues/1010#issuecomment-6039141756), [#1236 measurement scope](https://github.com/schlessera/brain-kit/issues/1236) |
| User-cleared site data, per browser | **NOT MEASURED**: V1 did not clear the origin during its trials | [V1](https://github.com/schlessera/brain-kit/issues/1010#issuecomment-6039141756), [#1236 measurement scope](https://github.com/schlessera/brain-kit/issues/1236) |
| Origin quota lower than free disk, per browser | **NOT MEASURED**: runner could fill a disk but not impose an engine quota reflected by estimate | [V1](https://github.com/schlessera/brain-kit/issues/1010#issuecomment-6039141756), [#1236 measurement scope](https://github.com/schlessera/brain-kit/issues/1236) |

Eviction, private-mode lifetime and cleared site data are limitations, not
measured loss distributions. Injected product tests establish what recovery
can do with surviving data; they do not measure when a real browser evicts it:

| Surviving evidence | Recovery boundary |
| --- | --- |
| Index + all chunks | Saved audio; an unfinished capture is marked interrupted |
| Index + some chunks | Interrupted contiguous playable prefix; saved boundary is adjusted |
| Index but no audio chunks or transcript | Persistent removed-recording notice |
| Index and unaccepted transcript, but no audio chunks | Transcript-ready review with an audio-unavailable explanation; transcript is kept, with no added removed-recording count |
| Neither index nor chunks (and no other surviving record) | Nothing can be listed or reported; no loss notice can be promised |

Recovery uses the surviving index and ordered chunks
(`async recover(partition)`, `packages/ui-react/src/lib/recordings.ts:516-580`).
The store tests force missing-chunk states, including a full origin that cannot
repair metadata. Requesting `navigator.storage.persist()` is best effort; no
copy calls it a guarantee. No unload callback can save data after a crash, and
no local UI can report a recording after all evidence of it has disappeared.

