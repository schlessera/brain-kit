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

## UI roots

`createBrainUiRoot({ config, storagePrefix, storage, request, api })` constructs
independent stores, API access, renderer/ASR registries and a connection without
opening a socket. Pass it to `<BrainUiProvider root={root}>`. Store selector
hooks resolve the nearest provider; imperative code uses `root.stores` and
`root.connection`. `useBrainApi()` and `useBrainConfig()` expose its services.

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

## Registries

Tool renderers and ASR clients register synchronously on first render into the
current root's registries. Imports are inert. Repeated registration is safe;
resetting one root's registry leaves other roots untouched. This is build-time
composition, with no runtime plugin loading.

The chat UI's own tools render from their SDK contracts through
`bind(contract, Component)`: `get_current_location` as a map card,
`request_image_mask` as a receipt, and `show_block` as one of the kit's answer
blocks (comparison table, stat tiles, trend chart, data table, bar list,
receipt, step list, timeline, schedule, quote card, contact card, and a map
of places that fetches each frame's geometry from `/geo/coastline` and always
lists every place). A block is
part of the answer, so the transcript draws it inline where the model called
it rather than inside the tool timeline; a call whose result does not parse
stays in the timeline with the result's own words.

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
