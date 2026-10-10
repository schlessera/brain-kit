import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { commands, userEvent } from "vitest/browser";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { ToolCallTimeline } from "../../src/components/chat/tool-call-timeline.js";
import { SubagentView } from "../../src/components/chat/subagent-view.js";
import { activeChat, useChatStore, type ToolCall } from "../../src/stores/chat-store.js";
import type { RendererPack } from "@schlessera/brain-ui-sdk/client";

// A third-party renderer that throws from whichever hook the call's input
// names, so one test can break the header, the detail view or the approval
// card. The renderer seam is where code the app does not own runs (#1376).
const rigging: RendererPack = { renderers: [{
  match: "odyssey_rigging",
  label: tool => { if (tool.input.mode === "label") throw new Error("label hook broke"); return "Rigging the mast"; },
  summary: tool => { if (tool.input.mode === "summary") throw new Error("summary hook broke"); return "lashed to the mast"; },
  Output: ({ tool }) => { if (tool.input.mode === "output") throw new Error("output view broke"); return <p data-rigging-output>{tool.output}</p>; },
}] };

let renderer: Root | undefined, root: BrainUiRoot | undefined, host: HTMLDivElement | undefined, styles: HTMLStyleElement;
beforeAll(async () => { styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles); });
afterAll(() => styles.remove());
afterEach(() => { if (renderer) flushSync(() => renderer!.unmount()); root?.dispose(); host?.remove(); renderer = undefined; root = undefined; host = undefined; vi.restoreAllMocks(); });

function call(id: string, name: string, input: Record<string, unknown>, extra: Partial<ToolCall> = {}): ToolCall {
  return { id, name, input, inputJson: JSON.stringify(input), status: "complete", output: `${id} output`, ...extra };
}
function mount(view: (props: { calls: ToolCall[] }) => ReactNode, calls: ToolCall[]) {
  root = createBrainUiRoot({ storage: null, request: async () => { throw new Error("no lookup"); } });
  root.renderers.register(rigging);
  host = document.createElement("div"); host.style.cssText = "width:720px;background:var(--bk-color-canvas);color:var(--bk-color-ink)"; document.body.append(host);
  renderer = createRoot(host);
  const render = (next: ToolCall[]) => flushSync(() => renderer!.render(<BrainUiProvider root={root!}>{view({ calls: next })}</BrainUiProvider>));
  render(calls);
  return render;
}
const reports = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.filter((args: unknown[]) => String(args[0]).includes("renderer for the odyssey_rigging tool failed"));
const headers = () => [...host!.querySelectorAll<HTMLElement>(".relative.ml-1 > div > button")];

test("a renderer that throws from its header falls back to the generic view and keeps the other rows", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const calls = [call("before", "Read", { file_path: "ithaca/before.md" }), call("broken", "odyssey_rigging", { mode: "summary" }), call("after", "odyssey_rigging", { mode: "fine" })];
  mount(({ calls }) => <ToolCallTimeline live toolCalls={calls} onApproval={() => {}} />, calls);
  expect(headers()).toHaveLength(3);
  const [before, broken, after] = headers();
  expect(before!.textContent).toContain("Read");
  expect(after!.textContent, "a working row keeps its own renderer").toContain("Rigging the mast");
  expect(broken!.textContent, "the failing row shows the generic label").toContain("odyssey_rigging");
  expect(broken!.textContent).not.toContain("Rigging the mast");
  await userEvent.click(broken!);
  await expect.poll(() => host!.textContent).toContain("broken output");
  expect(reports(errors), "reported once to the console").toHaveLength(1);
  expect(root!.stores.connection.getState().lastError?.code).toBe("TOOL_RENDERER_FAILED");
});

test("a detail view that throws on expand falls back for that row only", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const calls = [call("broken", "odyssey_rigging", { mode: "output" }), call("after", "odyssey_rigging", { mode: "fine" })];
  mount(({ calls }) => <ToolCallTimeline live toolCalls={calls} onApproval={() => {}} />, calls);
  const [broken, after] = headers();
  await userEvent.click(after!);
  await expect.poll(() => host!.querySelector("[data-rigging-output]")?.textContent).toBe("after output");
  await userEvent.click(broken!);
  await expect.poll(() => host!.textContent, { message: "the opened row stays open in its generic view" }).toContain("broken output");
  expect(headers()).toHaveLength(2);
  expect(host!.querySelectorAll("[data-rigging-output]"), "the working row's own view survives").toHaveLength(1);
  expect(reports(errors)).toHaveLength(1);
});

test("the boundary resets when the tool call updates, and reports once per row", () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const render = mount(({ calls }) => <ToolCallTimeline live toolCalls={calls} onApproval={() => {}} />, [call("rig", "odyssey_rigging", { mode: "summary" }, { status: "streaming", output: undefined })]);
  expect(headers()[0]!.textContent).not.toContain("Rigging the mast");
  render([call("rig", "odyssey_rigging", { mode: "fine" })]);
  expect(headers()[0]!.textContent, "an updated call gets its renderer back").toContain("Rigging the mast");
  render([call("rig", "odyssey_rigging", { mode: "summary" }, { output: "rig output again" })]);
  expect(headers()[0]!.textContent, "a later throw falls back again").not.toContain("Rigging the mast");
  expect(reports(errors), "two throws on one row report once").toHaveLength(1);
});

for (const location of ["main", "subagent"] as const) {
  test(`${location}: a pending approval whose renderer throws can still be answered`, async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const decided: [string, boolean][] = [];
    const onApproval = (id: string, approved: boolean) => { decided.push([id, approved]); };
    const parent = { spanId: "rigging-agent", runId: "rigging-run", kind: "subagent" as const, origin: "session" as const, name: "Agent", startedAt: 0 };
    const none: ToolCall[] = [];
    function View() {
      const calls = useChatStore(s => activeChat(s).messages.at(-1)?.toolCalls ?? none);
      return location === "main" ? <ToolCallTimeline live toolCalls={calls} onApproval={onApproval} /> : <SubagentView spanId={parent.spanId} onApproval={onApproval} />;
    }
    mount(() => <View />, []);
    root!.stores.chat.getState().requestToolApproval(null, "rig-approval", "odyssey_rigging", { mode: "label" }, undefined, "tool");
    const child = { ...parent, spanId: "rig-approval", parentSpanId: parent.spanId, kind: "tool" as const };
    root!.stores.activity.setState({ spans: { [parent.runId]: { [parent.spanId]: parent, [child.spanId]: child } }, spanRun: { [parent.spanId]: parent.runId, [child.spanId]: parent.runId } });
    await expect.poll(() => host!.querySelectorAll('[role="button"][aria-label="Allow"]').length).toBe(1);
    expect(host!.querySelector("[data-approval-card]")!.getAttribute("aria-label")).toBe("Approval: odyssey_rigging");
    await userEvent.click(host!.querySelector<HTMLElement>('[role="button"][aria-label="Allow"]')!);
    expect(decided).toEqual([["rig-approval", true]]);
  });
}
