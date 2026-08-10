# @schlessera/brain-ui-react

The brain-kit chat UI as a React component library: chat surface with
streaming transcript and tool-call timeline, file browser, voice dictation,
share flows, zustand stores, and the WebSocket transport speaking the
`@schlessera/brain-ui-sdk` protocol.

The deployment shell owns the document: `index.html`, the mount point, the
Vite/PWA build, the service worker, and the theme entry. This package ships
prebuilt JS + `.d.ts` plus its styles in two forms.

## Usage

```tsx
import {
  configureBrainUi,
  ConnectionGate,
  AppShell,
  ChatPage,
} from "@schlessera/brain-ui-react";

configureBrainUi({ appName: "Brain UI" }); // optional; defaults shown

export function App() {
  return (
    <ConnectionGate>
      <AppShell>
        <ChatPage />
      </AppShell>
    </ConnectionGate>
  );
}
```

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

## Registries

Tool renderers and ASR clients register at module load into the
`@schlessera/brain-ui-sdk/client` registries (build-time composition — no
runtime plugin loading).

## Versioning

Versions in lockstep with all `@schlessera/brain-*` packages.
