import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";
import { ModelPicker } from "../../src/chrome/ModelPicker.js";
import { Composer } from "../../src/chrome/Composer.js";
import { stage } from "../_stage.js";

const meta = preview.meta({
  title: "Chrome/ModelPicker",
  component: ModelPicker,
  decorators: [stage],
  parameters: { stageWidth: 390 },
  args: {
    models: [{ id: "opus", label: "Claude Opus 5.5" }, { id: "sonnet", label: "Claude Sonnet 4.6" }],
    selectedModelId: "opus", defaultEffort: "medium", effortLevels: ["low", "medium", "high", "xhigh", "max"],
    selectedEffort: null, onModel: fn(), onEffort: fn(), onDismiss: fn(),
  },
  render: (args) => <div style={{ position: "relative", width: "100%", height: 590 }}>
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
      <ModelPicker {...args} />
      <Composer provider="Claude Opus 5.5" providerDetail={args.selectedEffort ?? undefined} />
    </div>
  </div>,
});

/** Arrow keys browse effort; Enter commits it. Model selection keeps the picker open. */
export const Default = meta.story({
  play: async ({ canvas, userEvent, args }) => {
    const model = canvas.getByRole("radio", { name: "Claude Opus 5.5" });
    await expect(model).toHaveFocus();
    await userEvent.tab();
    await expect(canvas.getByRole("radio", { name: "Default (medium)" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    await expect(canvas.getByRole("radio", { name: "medium" })).toHaveFocus();
    await expect(args.onEffort).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    await expect(args.onEffort).toHaveBeenCalledWith("medium");
    await userEvent.keyboard("{Escape}");
    await expect(args.onDismiss).toHaveBeenCalled();
  },
});

export const Pinned = meta.story({
  args: { modelLocked: true, selectedEffort: "high" },
  play: async ({ canvas, userEvent, args }) => {
    await expect(canvas.getByRole("radio", { name: "Claude Opus 5.5" })).toBeDisabled();
    await expect(canvas.getByRole("radio", { name: "high" })).toHaveFocus();
    await userEvent.click(canvas.getByRole("radio", { name: "Default (medium)" }));
    await expect(args.onEffort).toHaveBeenCalledWith(null);
  },
});

/** A locked model offers the way out (#61): continuing on another backend starts a new chat. */
export const PinnedWithHandoff = meta.story({
  args: { modelLocked: true, effortLevels: [], defaultEffort: undefined,
    lockedAction: { label: "Continue on another backend", detail: "starts a new linked chat", onSelect: fn() } },
  play: async ({ canvas, userEvent, args }) => {
    const action = canvas.getByRole("button", { name: /Continue on another backend/ });
    await expect(action).toHaveFocus();
    await userEvent.click(action);
    await expect(args.lockedAction!.onSelect).toHaveBeenCalled();
  },
});

/** Without a second backend the action stays visible, dimmed, with its reason. */
export const PinnedHandoffUnavailable = meta.story({
  args: { modelLocked: true, effortLevels: [], defaultEffort: undefined,
    lockedAction: { label: "Continue on another backend", why: "no other backend set up", onSelect: fn() } },
  play: async ({ canvas, userEvent, args }) => {
    const action = canvas.getByRole("button", { name: /Continue on another backend/ });
    await expect(action).toHaveAttribute("aria-disabled", "true");
    await expect(canvas.getByText("no other backend set up")).toBeVisible();
    await userEvent.click(action);
    await expect(args.lockedAction!.onSelect).not.toHaveBeenCalled();
  },
});

export const WithoutEffort = meta.story({
  args: { defaultEffort: undefined, effortLevels: [] },
  play: async ({ canvas }) => {
    await expect(canvas.queryByText("Effort · next message")).toBeNull();
    await expect(canvas.queryByText("After sending, effort returns to the default.")).toBeNull();
  },
});


export const UnknownDefault = meta.story({
  args: { defaultEffort: undefined },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("radio", { name: "Default" })).toBeChecked();
    await expect(canvas.queryByRole("radio", { name: "Default (medium)" })).toBeNull();
  },
});
