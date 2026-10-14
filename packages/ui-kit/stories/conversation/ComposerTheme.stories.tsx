import preview from "#.storybook/preview";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { expect, fn, waitFor, within } from "storybook/test";
import { ComposerView, type ComposerViewProps } from "../../../ui-react/src/components/chat/composer-view.js";
import consumerStyles from "../../../ui-react/dist/styles.css?raw";
import { stage } from "../_stage.js";

const initial = "Keep the raft timber dry until the crossing to Ithaca. ".repeat(8);
const image = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="teal"/></svg>');

/** Actual consumer composition and shipped CSS. The shadow boundary prevents
 * the kit preview's different Tailwind spacing from supplying missing styles. */
function ConsumerComposer({ state, onSend, theme }: { state: "ready" | "offline"; onSend: () => void; theme?: string }) {
  const mount = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const providerMenuRef = useRef<HTMLDivElement>(null);
  const [shadow, setShadow] = useState<ShadowRoot | null>(null);
  const [value, onChange] = useState(initial);
  const [attachments, setAttachments] = useState([{ name: "raft.svg", previewUrl: image }]);
  useEffect(() => { setShadow(mount.current!.shadowRoot ?? mount.current!.attachShadow({ mode: "open" })); }, []);
  const props: ComposerViewProps = {
    value, onChange, state, onSend, frameRef, providerMenuRef, attachments,
    paletteOpen: false, palette: null, attachMenuOpen: false, attachErrors: [], provider: null,
    onRemoveAttachment: index => setAttachments(items => items.filter((_, i) => i !== index)),
    onStop: fn(), onAttachToggle: fn(), onPickLibrary: fn(), onPickCamera: fn(),
    onPasteFiles: fn(), onRecall: fn(), onEscape: fn(), onDismissErrors: fn(),
    onProviderToggle: fn(), onProviderSelect: fn(), onProviderDismiss: fn(), onEffortSelect: fn(),
    mic: false,
  };
  return <div ref={mount} data-consumer-composer style={{ width: "100%" }}>{shadow && createPortal(<>
    <style>{consumerStyles}</style><div data-theme={theme}><ComposerView {...props} /></div>
  </>, shadow)}</div>;
}

const meta = preview.meta({
  title: "Conversation/Composer theme",
  component: ConsumerComposer,
  decorators: [stage],
  render: (args, { globals }) => <ConsumerComposer {...args} theme={globals.theme} />,
  parameters: { stageWidth: 320 },
  args: { state: "ready" as const, onSend: fn() },
});

export const Phone = meta.story({
  play: async ({ canvasElement, userEvent, args, globals }) => {
    const host = canvasElement.querySelector<HTMLElement>("[data-consumer-composer]")!;
    await waitFor(() => expect(host.shadowRoot?.querySelector("textarea")).toBeTruthy());
    const shadow = host.shadowRoot!;
    await expect(getComputedStyle(shadow.querySelector("[data-theme]")!).colorScheme, "consumer subtree paints the project theme").toBe(globals.theme);
    const canvas = within(shadow as unknown as HTMLElement);
    const field = canvas.getByRole("textbox") as HTMLTextAreaElement;
    const frame = shadow.querySelector<HTMLElement>("div[data-composer]")!;
    const picture = canvas.getByRole("img", { name: "raft.svg" });
    await expect(picture.getBoundingClientRect().width, "consumer attachment width").toBe(64);
    await expect(picture.getBoundingClientRect().height, "consumer attachment height").toBe(64);
    await expect(frame.scrollWidth, "consumer composition has no horizontal overflow").toBeLessThanOrEqual(frame.clientWidth + 1);
    await expect(frame.getBoundingClientRect().width, "consumer fills the representative column").toBeCloseTo(host.getBoundingClientRect().width, 1);
    await expect(field.getBoundingClientRect().height, "consumer wrapped composer caps at 96px").toBe(96);
    await expect(field.scrollHeight).toBeGreaterThan(field.clientHeight);

    // Browser selection survives focusing, and replacing it reaches controlled
    // consumer state. This is editing parity; reload/transport survival stays E2E.
    field.focus();
    field.setSelectionRange(0, 4);
    await expect(shadow.activeElement).toBe(field);
    await expect([field.selectionStart, field.selectionEnd]).toEqual([0, 4]);
    await userEvent.keyboard("Guard");
    await expect(field.value).toBe("Guard" + initial.slice(4));
    // testing-library clear() compares document.activeElement directly and
    // rejects shadow-root focus. Select/delete through the already focused field.
    await userEvent.type(field, "{Backspace}", { skipClick: true, initialSelectionStart: 0, initialSelectionEnd: field.value.length });
    await expect(field).toHaveValue("");
    await userEvent.keyboard("Chart Ithaca");
    await expect(field).toHaveValue("Chart Ithaca");
    await expect(field.getBoundingClientRect().height, "consumer shrinks back to one line").toBeCloseTo(13.5 * 1.45, 1);

    const remove = canvas.getByRole("button", { name: "Remove raft.svg" });
    await userEvent.click(remove);
    await expect(canvas.queryByRole("img")).toBeNull();
    const send = canvas.getByRole("button", { name: args.state === "offline" ? "Send — unavailable" : "Send" });
    field.focus();
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    await expect(args.onSend).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    if (args.state === "offline") {
      await expect(send).toHaveAttribute("aria-disabled", "true");
      await expect(send).toHaveAttribute("tabindex", "-1");
      await expect(getComputedStyle(send).pointerEvents).toBe("none");
      send.click(); // Even programmatic activation must remain inert.
      await expect(args.onSend).not.toHaveBeenCalled();
      await expect(field.value).toContain("Chart Ithaca");
    } else {
      await expect(args.onSend).toHaveBeenCalledTimes(1);
      await userEvent.click(send);
      await expect(args.onSend).toHaveBeenCalledTimes(2);
    }
  },
});

// Width is independent of state: the widest ordinary column catches a broken
// max-width, while the phone exercises wrapping and the disabled branch.
export const Wide = Phone.extend({ parameters: { stageWidth: 720 } });
export const Offline = Phone.extend({ args: { state: "offline" } });
