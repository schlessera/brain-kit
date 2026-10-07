# @schlessera/brain-ui-react

The brain-kit chat UI as a React component library: chat surface with
streaming transcript and tool-call timeline, file browser, voice dictation,
share flows, zustand stores, and the WebSocket transport speaking the
`@schlessera/brain-ui-sdk` protocol.

The deployment shell owns the document: `index.html`, the mount point, the
Vite/PWA build, the service worker, and the theme entry. This package ships
prebuilt JS + `.d.ts` plus its styles in two forms.

`ConnectionGate` derives its message from the authenticated HTTP reachability
probe and live WebSocket facts. After three consecutive handshakes fail before
opening, it distinguishes a refused live connection from an unreachable
server; close code 4008 is shown specifically as the server connection limit.

## Dictation

At widths of 900px and above, dictation opens a panel immediately above the
composer, bounded to its width. Done or the composer's mic stops capture and
hands the transcript to review. Conversation text remains selectable while
recording. Done receives focus on opening; Enter or Space activates the
focused stop control, and Escape cancels. Closing returns focus to the mic.

Below 900px, dictation keeps the full-width phone sheet and its backdrop stop
control. Its 200ms upward entrance respects reduced-motion preferences through
both stylesheet entry points. Both forms keep the provider disclosure,
transcript scrolling and review flow. The composer preserves its draft and
prevents typing or sending while capture or its final drain is active.

### Recording on the device

Set `localCapture: true` and a stable `storagePrefix` on a persistent root to
use its durable `root.recordings` store. Recording remains opt-in. `start()`
checks the origin's audio budget and acquires the single recording tab lock
before asking for microphone permission. Each chunk and its saved boundary
commit together; events report only committed `savedThroughMs`. The store
holds service-worker update reloads until capture and finalization finish.

Pending audio has no age expiry and is never evicted to make room. The store
limits each recording to ten minutes and all partitions together to 100 MiB,
with the browser's estimated headroom as a tighter budget. A failed write
stops capture and keeps the committed prefix. Encoded chunks are never sliced
to fit a limit: playback uses the contiguous chunks that committed.

Account audio is accessible only while the matching `accountKey` is held;
locked audio still counts toward the cap. New captures without an account are
`unassigned`, and `assign(id)` requires an explicit choice by the caller.
Partitioning is an app boundary, not protection against someone with access
to the device. `stop("auth")` stops capture, accepts at most the in-flight
write, and retains the originating partition.

`ConnectionGate` stops capture on a 401 or a 1008 close, commits the work
snapshot, then unmounts protected views and drops their account payloads. A
failed snapshot is reported on the re-auth screen. Signing in as the same
account confirms the account key on the existing authenticated probe and
restores text, images, uploaded track references, selection, focus and the
transcript anchor without reloading. An unfinished IME composition is not
recoverable. A different account, or a missing snapshot, reloads; other
accounts' recordings remain locked, with only their aggregate size shown.
The account key is retained only through the ordered stop and snapshot, then
cleared after unmount. Transport loss keeps the views and capture running.
Service-worker takeover stays held through this auth transition.

Call `recover(partition)` on a readable partition after launch. If capacity
prevents a repair write, the store still returns and plays the committed
prefix, and retries the durable classification on later recovery. It never opens
the microphone: live indexes and partial audio become interrupted recordings,
using the last contiguous committed end. An index with no playable chunks
adds a durable removed-by-browser notice until `dismissRemoved(partition)`.
If both index and chunks disappear, the browser leaves nothing detectable.
Durable-storage requests and capacity estimates are not guarantees.
`playback(partition, id)` returns a Blob URL and its `revoke()` cleanup;
`discard(partition, id)` deletes that recording and its chunks. Playback URLs are revoked on discard, association, auth loss and disposal.
Recording, playback and recovery perform no upload or transcription.

The composer shows a local recording sheet with the microphone level, timer,
remaining cap and Stop/Discard controls. Saved recordings appear in a collapsed
“On this device” tray; expansion preserves the transcript's reading position.
The tray reads only the held account and the unassigned partition. It offers
playback and confirmed discard, and says when saved-audio transcription is
unavailable. Nothing in these actions sends audio or a chat message.

`RecordingsTray` and `LocalRecordingSheet` are exported for other root-scoped
views. A ready transcript is editable and each input is committed locally.
Add to draft appends after a newline and commits through the account's local
work snapshot before marking the recording accepted or deleting its audio and
transcript. A hash-bound acceptance receipt makes a retry safe after a failed
cleanup or reload; a failed draft write retains the recording. Unaccepted
transcripts hold service-worker reloads even after the tray unmounts. A surviving
transcript remains reviewable if the browser removes its audio. Acceptance stays
device-local even when host draft autosave is available; a subsequent user edit
or explicit Send resumes the ordinary draft workflow.


A root created with `localCapture: { sink }` also records without the host.
While the host is unreachable the mic becomes "Record on this device": a tap
opens the microphone and records with MediaRecorder into the sink, chunk by
chunk, with no network request. The draft stays editable, and the mic stops
the recording ("Stop and save"). A recording stays one when the host returns,
and a dictation never becomes one. A refused microphone and a browser that
cannot record on the device (`detectLocalCaptureSupport`) each say so in place
of the capture panel; the latter draws no mic. Without the option the mic
dictates online and offline exactly as before. The engine is also exported:
`startLocalCapture({ sink })` returns a capture whose `stop(reason)` resolves
once the final chunk was handed over and the microphone released.

## Track files

The composer accepts validated GPX, KML and supported GeoJSON alongside images
and text. A `.json` must contain supported GeoJSON; ordinary files receive an
inline refusal. Each track chip shows upload, reading, waiting, failure or ready
state, with Retry/Remove controls. Sending while files are pending holds the
editable draft; all must validate before a single message is sent. Failed files
keep the draft, and an acknowledgement removes only that message's files.

Sent tracks use the kit's static `AttachmentRow`: the original incoming name,
format, known byte count and `sent`, plus a differing staged name and any
no-line waypoint note. Live and replayed messages use the same mapping. These
rows offer no open or playback action. Image attachments retain their live
80px zoomable thumbnails and count-only history chip.

System shares remain under review until **Add to brain** is tapped. Dismiss
cancels an in-flight upload. A previously confirmed share may resume when the
connection returns; a share the reader has not confirmed never starts itself.
Generic share intake still retains ordinary originals without track labeling.

`show_block`'s `track` kind names only a staged `source.path`. The server parses
the original and provides canonical summary/geometry. File timestamps never
prove travel. Drawing retains every usable point and separate gaps; unsupported
projections retain the full text, waypoints and original. PNG/PDF sharing resolves
the original and background before producing scriptless markup.

## React compatibility

The `react` and `react-dom` peer range remains `>=18`: React 18 and the current
React release are both covered by the packaging smoke test. It installs the
packed package with matching `@types/react` and `@types/react-dom`, imports the
entry point, and typechecks the emitted `.d.ts` against React 18's types.

## Usage

```tsx
import {
  configureBrainUi,
  ConnectionGate,
  AppShell,
  ChatPage,
  GraphPage,
  ActivityPage,
  useHashRoutes,
  useUIStore,
} from "@schlessera/brain-ui-react";

configureBrainUi({ appName: "Brain UI" }); // optional; defaults shown

export function App() {
  useHashRoutes();
  const activeView = useUIStore((state) => state.activeView);

  return (
    <ConnectionGate>
      <AppShell>
        {/* Keep chat mounted so an in-flight turn survives a view switch.
            `display: contents` rather than a plain wrapper: ChatPage is a
            flex child of AppShell and its `flex-1` needs to reach the shell's
            flex container, or the chat loses its viewport-filling layout and
            bounded scrolling. */}
        <div style={{ display: activeView === "chat" ? "contents" : "none" }}>
          <ChatPage />
        </div>
        {activeView === "graph" && <GraphPage />}
        {activeView === "activity" && <ActivityPage />}
      </AppShell>
    </ConnectionGate>
  );
}
```

## Shell hooks

`useHashRoutes()` owns the generic client routes: `#/files/<path>` opens the
file panel, `#/graph` and `#/activity` select their full-screen views, activity
deep links keep their suffix, and store-driven view changes use
`history.replaceState` rather than adding browser-history entries.

`useServiceWorkerUpdates({ isBusy })` registers `/service-worker.js` and
reloads after an update takes control. It never reloads for a first install,
and an update takeover that happens while `isBusy` is true waits for the
transition back to idle. Non-empty text fields are treated as busy by default;
`hasUnsentText` can override that DOM probe. A Vite shell can preserve its
development gate with `enabled: import.meta.env.PROD`.

## Configuration

`configureBrainUi()` is this package's only configuration entry, and it must
run before the first render. Nothing in here reads the ambient environment —
no `import.meta.env`, no bundler globals — so the package works the same under
Vite, webpack, Next.js or a plain bundle. The shell reads whatever it likes and
passes values in.

| Field | Default | What it does |
| --- | --- | --- |
| `appName` | `"Brain UI"` | Product name on the login screen and connection status |
| `assistantName` | `"Brain"` | Name the assistant speaks as in the transcript |
| `shareTitle` | `"Shared from Brain"` | Default title for shared artifacts |
| `composerPlaceholder` | `"Ask your brain anything..."` | Composer placeholder |
| `backendUrl` | `""` (same-origin) | Origin of the API/WebSocket backend, for a split topology |
| `devTools` | `false` | Install the `window.__chatStore` / `window.__graphStore` fixture-injection handles |
| `pdfWorkerUrl` | `""` (main thread) | URL of pdf.js's worker script, for the file viewer's PDF preview |

Same-origin is the default topology: the server serves the built client and the
API/WS from one origin, so nothing needs configuring. Set `backendUrl` only when
the client and backend live on different origins — a Vite shell would pass
`import.meta.env.VITE_BACKEND_URL`, but that read belongs in the shell, not here.

The file viewer draws PDFs with pdf.js, which parses them in a worker. Only
the shell's bundler knows where that script ends up, so the shell passes its
URL. With Vite:

```ts
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

configureBrainUi({ pdfWorkerUrl });
```

Import it from the `pdfjs-dist` version this package depends on. Without a URL,
or with one that does not start a worker of that version, PDFs are parsed on the
main thread instead. They still open, but a heavy document can stall the page
while it loads.

Because configuration arrives at boot rather than at import, the API base is a
function: use `apiBase()`, not a constant.

## Styles

Two ways to get the CSS, pick one:

- **Tailwind v4 build (recommended):** import the source theme and let your
  build scan the package's components for the utilities they use:

  ```css
  @import "tailwindcss";
  @import "@schlessera/brain-ui-react/theme.css";
  @source "../node_modules/@schlessera/brain-ui-react/src";
  ```

  `theme.css` imports the kit's `tokens.css` itself (not the kit's
  `theme.css`, which carries the kit's own `@theme` scales and would redefine
  `p-2`), so the `--bk-*` values the kit components inside this package read
  arrive with it. Importing `@schlessera/brain-ui-kit/tokens.css` a second
  time is harmless.

- **No Tailwind:** import the precompiled stylesheet, which already includes
  the kit's tokens:

  ```ts
  import "@schlessera/brain-ui-react/styles.css";
  ```

### Theme

The app is dark by default. Settings carries a three-way toggle (system /
paper / dark), stored per root under `brain-theme`, and `AppShell` writes it to
`<html data-theme>`; the kit's tokens switch on that attribute. Because the
attribute is applied in an effect, a host that wants a stored non-default
preference to paint correctly on the very first frame adds one inline line to
its HTML before the stylesheet:

```html
<script>document.documentElement.dataset.theme = localStorage.getItem("brain-theme") || "dark";</script>
```

The app types no colour of its own. Every utility colour `theme.css`
declares (`bg-surface`, `text-foreground`, `border-border`, …) is one of the
kit's `--bk-*` tokens, declared `@theme inline`, so the same attribute
switches the shell and the kit components inside it. Accents come in two
names, as the kit names them: `primary`, `accent` and `destructive` are the
inks — for text, borders and rings, dark on paper — and `primary-fill`,
`accent-fill` and `destructive-fill` are the fills, the same colour in both
themes, for backgrounds solid or with an alpha, with `primary-foreground` as
the ink that sits on a fill, and `primary-mark` / `accent-mark` /
`destructive-mark` for a status dot, which the kit darkens on paper because
a fill that small falls under 3:1. A host that styles its own elements with these
utilities follows the same split; `bg-primary` is the ink and reads as brown
on paper.

## Multi-session state

`useChatStore` keeps a transcript buffer **per session** plus a draft buffer
for a not-yet-named conversation; frames from background sessions accumulate
in their own buffers while another session is in view. `activeChat(state)`
selects the buffer in view; `anyStreaming(state)` is the "something is
running" signal (used e.g. to defer service-worker update reloads).

## Store hooks

The exported store hooks are what a shell reads and calls, typed against a
minimal view of each store rather than its full state:

| Hook | View | Fields |
| --- | --- | --- |
| `useChatStore` | `ChatShellState` | `buffers`, `draft`, `activeSessionId` (what `activeChat` and `anyStreaming` read) |
| `useVoiceStore` | `VoiceShellState` | `mode`, `connecting`, `draining`, `reviewText` |
| `useShareStore` | `ShareShellState` | `queue`, `busy` (what `hasPendingShare` reads) |
| `useUIStore` | `UIShellState` | `activeView`, `setActiveView`, `setFilePanelOpen` |
| `useFileStore` | `FileShellState` | `openFile`, `openDir` |

Each hook is a `ShellStoreHook<View>`: call it with a selector inside React,
or use its `getState()` and `subscribe()` statics outside React, for example
in a service-worker reload guard:

```ts
const isBusy = () => {
  const voice = useVoiceStore.getState();
  return anyStreaming(useChatStore.getState())
    || voice.mode !== "idle" || voice.connecting || voice.draining
    || hasPendingShare(useShareStore.getState())
    || hasUnsentText();
};
```

The full store state shapes are internal and may change in any release.

## UI roots

`createBrainUiRoot({ config, storagePrefix, storage, request, api })` constructs
independent stores, API access, renderer/ASR registries and a connection without
opening a socket. Pass it to `<BrainUiProvider root={root}>`. Store selector
hooks resolve the nearest provider; imperative code uses `root.connection`.
`root.stores` carries the full store state and is internal. `useBrainApi()` and `useBrainConfig()` expose its services.

A provider without a `root` owns a new root and disposes it on unmount. An
explicit root belongs to the caller, which must call `root.dispose()` when
finished. `useWebSocket()` acquires a connection lease: multiple consumers of
the same root share one socket until the last consumer unmounts.

Use a stable, distinct `storagePrefix` to restore an embedder's session,
provider choice and frontmatter preference. Omission generates an ephemeral
namespace; `storage: null` disables persistence. Outside a provider, hooks use
the default application root and its existing storage keys. Hook statics such
as `useChatStore.getState()` always address that default root; internal code
must use explicit roots, enforced by `check-root-stores.ts`.

Component requests, media URLs and branding follow the provider's root.
Browser resources remain shared: cookies, native credential/share UI, the
share-target stash and service-worker push subscriptions. Native media loading
uses backend URLs and browser credentials rather than the injected transport.
Separate roots do not establish a browser security boundary. One root serves
all agent backends on the same brain server; separate roots are only needed
for distinct application instances.

### Health and sync helpers

`root.api` and the exported `createBrainApi()` share the configured request
transport. `health()` returns `{ status, uptime, timestamp }`. Its former
`version: string` declaration is removed as an approved breaking correction:
the public route never returned that field. For software identity, request
authenticated `status()` explicitly instead of reading `health().version`.

`brainSync()` consumes the SSE response and resolves its terminal result as
`{ success, message }`; `success: false` is a completed unsuccessful sync.
A missing/malformed terminal event or lost stream rejects as incomplete.
Non-2xx responses retain `ApiRequestError`. No POST retry or stream resumption
is automatic; disconnect does not cancel the server job or release its
repository reservation before the child exits.

## Registries

Tool renderers and ASR clients register synchronously on first render into the
current root's registries. Imports are inert. Repeated registration is safe;
resetting one root's registry leaves other roots untouched. This is build-time
composition, with no runtime plugin loading.

The chat UI's own tools render from their SDK contracts through
`bind(contract, Component)`: `get_current_location` as a map card,
`request_image_mask` as a receipt, and `show_block` as one of the kit's answer
blocks (comparison table, stat tiles, trend chart, data table, bar list,
receipt, step list, timeline, schedule, quote card, contact card, supporting
files, and a map
of places that fetches each frame's geometry from `/geo/coastline` and always
lists every place). A block is
part of the answer, so the transcript draws it inline where the model called
it rather than inside the tool timeline; a call whose result does not parse
stays in the timeline with the result's own words.

The `files` variant lists 1–20 supporting local notes with optional plain-text
reasons. Both backends use the same data-only contract, and replay keeps the
list in place. RelatedFiles clears sample metadata and opens permitted paths
through the current root's file viewer. Unsafe paths remain readable without
controls; unavailable notes use the existing file error. PNG and PDF exports
retain paths and reasons as static text. The classifier does not infer file
citations or reasons.

The same `BlockCard` draws the blocks a host classifies out of the model's
markdown (`message_blocks`, rev 4): `MarkdownContent` cuts a text part at
each block's span and renders the kit block between the markdown pieces. A
message without blocks renders exactly as before, and a span that does not
fit the text is ignored.

## Versioning

Versions in lockstep with all `@schlessera/brain-*` packages.

### Quick capture recovery

The Add panel shows the saved path and whether indexing completed. If indexing
failed, it keeps the saved confirmation visible and offers **Retry indexing**.
That action updates the index without creating or appending the note again.
Older servers that omit the indexing outcome are shown as unconfirmed.

## Software identity in stats

`/stats` includes a Software receipt. Client release is read from the
`brain-ui-react` package bundled into the page; server release comes from the
running `brain-ui-server` package via authenticated `/api/status`. Neither is
looked up in the registry. They describe these two packages, not an inventory
of every installed module.

The shell may pass `sourceCommit` to `configureBrainUi` or the root's `config`.
Bake this application revision into the client bundle at build time; never
fetch it from the server. Use the same application revision as the server's
`SOURCE_COMMIT` when both are built from the same application checkout. Package
versions and application revisions identify different things. Without a build
revision (or with `dev`), the receipt says the build match is unverified even
when package releases match. A difference is diagnostic, not a claim of
protocol incompatibility.

The stats shortcuts work without a WebSocket connection when no turn is
streaming. Local identity appears immediately; failed server requests leave
it visible. Full revision strings wrap and can be selected for a report.

Inline `graph` answer blocks use GraphView with deterministic client layout
and only supplied edges. A complete textual node/edge list provides the
accessible equivalent; accepted local file paths open the current root's
viewer. Replay and static exports retain all nodes and edges, with no file
controls in static output and no lookup needed to draw a graph.


Markdown fences compose the kit `CodeBlock` with a permanent 44px head Copy
control. Copy uses source text rather than linkified DOM text. The lazy
highlighter soft-fails to the same plain source; its chat-only token theme
works in dark and paper. Mermaid keeps its dedicated renderer. Long lines
wrap for narrow transcripts, and exports retain the original fence content.
The Storybook `Conversation/Code fence theme` preview uses the actual consumer
renderer and shipped CSS within an isolated shadow root.


Retained Activity run details draw `LaneChart` from recorded child intervals
on one shared elapsed-time axis. A valid approval boundary alone creates
hatching, and only spans still recorded as active in an active run get an open
tail. Completed spans require a recorded end; invalid or missing timestamps
are disclosed. A complete textual interval list preserves names and outcomes,
and the existing expandable trace remains available. No model-authored runtime
state or timing telemetry is introduced.


Activity run detail uses `AgentOrbit` for two or more retained subagents.
Recorded types, pending approvals and terminal outcomes determine its state
rings; no progress is estimated. Phone containers draw marks and keep named
44px drill-in controls in the full span list. Labelled pills open the existing
subagent view over chat, selecting the recorded session when one is present;
overflow scrolls to the complete list. Unavailable, pruned, empty and single-agent
runs draw no overview or sample content.
