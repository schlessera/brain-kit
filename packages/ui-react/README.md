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

Same-origin is the default topology: the server serves the built client and the
API/WS from one origin, so nothing needs configuring. Set `backendUrl` only when
the client and backend live on different origins — a Vite shell would pass
`import.meta.env.VITE_BACKEND_URL`, but that read belongs in the shell, not here.

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

- **No Tailwind:** import the precompiled stylesheet:

  ```ts
  import "@schlessera/brain-ui-react/styles.css";
  ```

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

**Migration is in progress:** stores and WebSocket handlers are isolated, but
some components and helpers still use the default API/config. Separate-backend
application embeds require the remaining S4 caller migration in `.plan/PLAN.md`.

## Registries

Tool renderers and ASR clients register synchronously on first render into the
current root's registries. Imports are inert. Repeated registration is safe;
resetting one root's registry leaves other roots untouched. This is build-time
composition, with no runtime plugin loading.

## Versioning

Versions in lockstep with all `@schlessera/brain-*` packages.

### Quick capture recovery

The Add panel shows the saved path and whether indexing completed. If indexing
failed, it keeps the saved confirmation visible and offers **Retry indexing**.
That action updates the index without creating or appending the note again.
Older servers that omit the indexing outcome are shown as unconfirmed.
