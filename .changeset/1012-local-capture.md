---
"@schlessera/brain-ui-react": minor
"@schlessera/brain-ui-kit": minor
---

Record on the device without a server voice session. `startLocalCapture` opens the microphone and records with MediaRecorder (`audio/webm;codecs=opus`, else `audio/mp4`), handing each chunk to a sink with its start and end in milliseconds; `stop(reason)` resolves once the final chunk was handed over and the microphone released. It makes no network request. `detectLocalCaptureSupport` reports whether the page can: a supported container, a Blob write to IndexedDB and a secure context, without touching the microphone.

A root created with `localCapture: { sink }` offers it in the composer: with the host unreachable, the mic becomes "Record on this device", and a tap records into the sink. A recording stays one when the host comes back, and a dictation never turns into one. A refused microphone and a browser that cannot record on the device each get their own copy, and the latter shows no mic. Without the option nothing changes: online and offline, the mic dictates as before. Shipped builds leave it off until recordings are stored durably.

The kit `Composer` gains `mic` (off hides the microphone) and `micLabel` (its accessible name when the capture is not dictation).
