import preview from "#.storybook/preview";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { expect, fn, waitFor, within } from "storybook/test";
import { BrainUiProvider } from "../../../ui-react/src/root-context.js";
import { createBrainUiRoot } from "../../../ui-react/src/root.js";
import { SessionsPane } from "../../../ui-react/src/components/chat/sessions-pane.js";
import { ChatComposerRow } from "../../../ui-react/src/components/chat/composer-row.js";
import consumerStyles from "../../../ui-react/dist/styles.css?raw";
import { stage } from "../_stage.js";

const now = Date.UTC(2026, 6, 12, 9, 41);
const sessions = ["Raft timber tally", "Letter to Penelope"].map((title, i) => ({
  id: `session-${i}`, title, createdAt: now, lastActiveAt: now, totalCostUsd: 0, numTurns: 1,
}));

function SessionTheme({ wide, onOpen, theme }: { wide: boolean; onOpen: (id: string) => void; theme?: string }) {
  const mount = useRef<HTMLDivElement>(null);
  const [shadow, setShadow] = useState<ShadowRoot | null>(null);
  const [root] = useState(() => {
    const root = createBrainUiRoot({ storage: null, request: async () => Response.json({ sessions }) });
    root.stores.chat.getState().setActiveSession("session-open");
    root.stores.trackers.getState().setRecoverySupported(true);
    for (const session of sessions) {
      root.stores.trackers.getState().track(session.id, { now });
      root.stores.trackers.getState().live(session.id, [{ kind: "running", turnId: `turn-${session.id}`, requestId: null }]);
    }
    root.stores.sessions.setState({ sessions, loading: false, loaded: true });
    root.stores.followUp.getState().applyReport({ type: "session_queue", sessionId: "session-open", followUps: [
      { id: "wind", requestId: "request-wind", text: "Ask Aeolus about the west wind", label: "West wind", queuedAt: now },
    ] });
    return root;
  });
  useEffect(() => {
    setShadow(mount.current!.shadowRoot ?? mount.current!.attachShadow({ mode: "open" }));
    return () => root.dispose();
  }, [root]);
  return <div ref={mount} data-session-theme style={{ width: "100%" }}>{shadow && createPortal(<>
    <style>{consumerStyles}</style><BrainUiProvider root={root}>
      <div data-theme={theme} style={{ display: "flex", minHeight: 300 }}>
        {wide && <SessionsPane empty={false} onResume={onOpen} onOpenTracker={onOpen} />}
        <div style={{ flex: 1, minWidth: 0, alignSelf: "end" }}><ChatComposerRow wide={wide} onOpenTracker={onOpen} /></div>
      </div>
    </BrainUiProvider>
  </>, shadow)}</div>;
}

const meta = preview.meta({
  title: "Conversation/Session theme", component: SessionTheme, decorators: [stage],
  render: (args, { globals }) => <SessionTheme {...args} theme={globals.theme} />,
  parameters: { stageWidth: 320 }, args: { wide: false, onOpen: fn() },
});

export const Phone = meta.story({
  play: async ({ canvasElement, userEvent, args, globals }) => {
    const host = canvasElement.querySelector<HTMLElement>("[data-session-theme]")!;
    await waitFor(() => expect(host.shadowRoot?.querySelector("[data-composer-row]")).toBeTruthy());
    const shadow = host.shadowRoot!;
    await expect(getComputedStyle(shadow.querySelector("[data-theme]")!).colorScheme, "consumer subtree paints the project theme").toBe(globals.theme);
    const canvas = within(shadow as unknown as HTMLElement);
    const row = shadow.querySelector<HTMLElement>("[data-composer-row]")!;
    await expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
    const half = shadow.querySelector<HTMLElement>('[data-row-half="right"]')!.getBoundingClientRect();
    const pending = canvas.getByRole("button", { name: /^Pending follow-up 1 of 1: West wind/ });
    await expect(pending.getBoundingClientRect().height).toBe(44);
    await expect(pending.getBoundingClientRect().right).toBe(half.right);
    const selector = args.wide ? "[data-working-row]" : "[data-session-strip] [data-session]";
    const tracked = [...shadow.querySelectorAll<HTMLElement>(selector)];
    await expect(tracked.map(item => item.dataset.session)).toEqual(["session-0", "session-1"]);
    if (args.wide) {
      const pane = shadow.querySelector<HTMLElement>("[data-sessions-pane]")!;
      await expect(pane.getBoundingClientRect().width, "consumer desktop pane remains 280px").toBe(280);
      await expect(pane.scrollWidth).toBeLessThanOrEqual(pane.clientWidth + 1);
      await expect(shadow.querySelector("[data-session-strip]")).toBeNull();
    } else {
      await expect(row.getBoundingClientRect().height, "two consumer working pills remain 94px").toBe(94);
      await expect(shadow.querySelector("[data-sessions-pane]")).toBeNull();
    }
    const first = tracked[0]!.matches('[role="button"]') ? tracked[0]! : tracked[0]!.querySelector<HTMLElement>('[role="button"]')!;
    first.focus();
    await expect(shadow.activeElement).toBe(first);
    await userEvent.keyboard("{Enter}");
    await expect(args.onOpen).toHaveBeenCalledWith("session-0");
    await userEvent.click(first);
    await expect(args.onOpen).toHaveBeenCalledTimes(2);
  },
});

// Render the actual desktop pane and its companion row. ChatPage's breakpoint
// selection remains runtime proof; this owns the distinct consumer CSS boundary.
export const DesktopPane = Phone.extend({ args: { wide: true }, parameters: { stageWidth: 900 } });
