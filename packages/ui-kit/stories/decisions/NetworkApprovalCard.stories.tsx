import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";

import { NetworkApprovalCard } from "../../src/decisions/NetworkApprovalCard.js";
import { ApprovalStack } from "../../src/decisions/ApprovalStack.js";
import { overflowing, stage, wide } from "../_stage.js";

const meta = preview.meta({
  title: "Decisions/NetworkApprovalCard",
  component: NetworkApprovalCard,
  decorators: [stage],
  parameters: { stageWidth: 320 },
  args: {
    originLabel: "ithaca.example",
    target: "https://ithaca.example:443",
    connectionCount: 1,
    description:
      "This session fetched a web page, so content you did not write may be steering it. Allow it to connect to ithaca.example:443?",
    scopes: ["once", "origin", "session"],
    state: "pending",
    waitingLabel: "Waiting 0:18",
    onSelectScope: fn(),
    onDeny: fn(),
  },
});

export const Pending = meta.story({
  args: { originLabel: "ithaca.example" },
  play: async ({ canvasElement }) => {
    const card = canvasElement.querySelector("[data-kit-network-approval-card]") as HTMLElement;
    await expect(overflowing(card)).toEqual([]);
    for (const btn of card.querySelectorAll<HTMLElement>('[role="button"]')) {
      await expect(btn.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
  },
});

export const PendingWide = Pending.extend({ parameters: wide });

export const Armed = Pending.extend({
  args: {
    state: "armed",
    waitingLabel: "Waiting 0:00",
  },
  play: async ({ canvasElement, userEvent, args }) => {
    const card = canvasElement.querySelector("[data-kit-network-approval-card]") as HTMLElement;
    const buttons = [...card.querySelectorAll<HTMLElement>('[role="button"]')];
    await expect(buttons.length).toBeGreaterThanOrEqual(2);
    for (const btn of buttons) {
      await expect(btn.getAttribute("aria-disabled")).toBe("true");
      await expect(btn.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
    await userEvent.click(buttons[0]!);
    await expect(args.onSelectScope).not.toHaveBeenCalled();
    await expect(overflowing(card)).toEqual([]);
  },
});

export const ArmedWide = Armed.extend({ parameters: wide });

export const Sending = Pending.extend({
  args: {
    state: "sending",
    waitingLabel: "Waiting 0:24",
  },
});

export const SendingWide = Sending.extend({ parameters: wide });

export const Updated = Pending.extend({
  args: {
    state: "updated",
    updateNotice: "Updated: this chat also opened a shared file.",
    waitingLabel: "Waiting 1:12",
  },
});

export const UpdatedWide = Updated.extend({ parameters: wide });

const receiptPlay = async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  const receipt = canvasElement.querySelector("[data-kit-network-receipt]") as HTMLElement | null;
  await expect(receipt).not.toBeNull();
  await expect(overflowing(receipt!)).toEqual([]);
};

export const GrantedOnce = Pending.extend({
  args: { state: "granted", grantedScope: "once" },
  play: receiptPlay,
});

export const GrantedOnceWide = GrantedOnce.extend({ parameters: wide });

export const GrantedOrigin = Pending.extend({
  args: { state: "granted", grantedScope: "origin" },
  play: receiptPlay,
});

export const GrantedOriginWide = GrantedOrigin.extend({ parameters: wide });

export const GrantedSession = Pending.extend({
  args: { state: "granted", grantedScope: "session" },
  play: receiptPlay,
});

export const GrantedSessionWide = GrantedSession.extend({ parameters: wide });

export const Withdrawn = Pending.extend({
  args: { state: "withdrawn" },
  play: receiptPlay,
});

export const WithdrawnWide = Withdrawn.extend({ parameters: wide });

export const Expired = Pending.extend({
  args: { state: "expired" },
  play: receiptPlay,
});

export const ExpiredWide = Expired.extend({ parameters: wide });

export const Unknown = Pending.extend({
  args: { state: "unknown" },
  play: receiptPlay,
});

export const UnknownWide = Unknown.extend({ parameters: wide });

export const GroupedThreeConnections = Pending.extend({
  args: {
    originLabel: "ithaca.example",
    target: "https://ithaca.example:443",
    connectionCount: 3,
    waitingLabel: "Waiting 0:42",
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByText("ithaca.example · 3 connections waiting")).toBeTruthy();
    const card = canvasElement.querySelector("[data-kit-network-approval-card]") as HTMLElement;
    await expect(overflowing(card)).toEqual([]);
  },
});

export const GroupedThreeConnectionsWide = GroupedThreeConnections.extend({ parameters: wide });

export const ManagedAcquisition = Pending.extend({
  args: {
    originLabel: "api.github.com",
    target: "managed:connect://api.github.com:443",
    managedReference: true,
    scopes: ["once"],
    description:
      "This session fetched a web page, so content you did not write may be steering it. Allow this managed GitHub acquisition from api.github.com:443? Allowing covers only this acquisition.",
  },
  play: async ({ canvas }) => {
    await expect(canvas.queryByText(/for this chat/i)).toBeNull();
    await expect(canvas.getByText("Allow once")).toBeTruthy();
  },
});

export const ManagedAcquisitionWide = ManagedAcquisition.extend({ parameters: wide });

export const SeveralOriginsStack = meta.story({
  render: () => (
    <ApprovalStack
      count={6}
      originCount={4}
      allowAllLabel="Allow all 4 sites for this chat"
      onAllowAll={fn()}
      announcement="Updated approvals for 4 sites"
    >
      <NetworkApprovalCard
        originLabel="ithaca.example"
        connectionCount={3}
        compact
        hideSessionButton
        waitingLabel="Waiting 1:12"
        onSelectScope={fn()}
        onDeny={fn()}
      />
      <NetworkApprovalCard
        originLabel="pylos.example"
        compact
        hideSessionButton
        waitingLabel="Waiting 0:45"
        onSelectScope={fn()}
        onDeny={fn()}
      />
      <NetworkApprovalCard
        originLabel="sparta.example"
        compact
        hideSessionButton
        waitingLabel="Waiting 0:30"
        onSelectScope={fn()}
        onDeny={fn()}
      />
      <NetworkApprovalCard
        originLabel="ogygia.example"
        compact
        hideSessionButton
        waitingLabel="Waiting 0:12"
        onSelectScope={fn()}
        onDeny={fn()}
      />
    </ApprovalStack>
  ),
  play: async ({ canvas, canvasElement }) => {
    const stack = canvasElement.querySelector("[data-kit-approval-stack]") as HTMLElement;
    await expect(canvas.getByText("Allow all 4 sites for this chat")).toBeTruthy();
    await expect(canvas.getByText("ithaca.example · 3 connections waiting")).toBeTruthy();
    await expect(overflowing(stack)).toEqual([]);
  },
});

export const SeveralOriginsStackWide = SeveralOriginsStack.extend({ parameters: wide });

export const MobileKeyboardCollapsed = meta.story({
  render: () => (
    <ApprovalStack
      count={4}
      originCount={4}
      collapsed
      onToggleCollapsed={fn()}
    />
  ),
  play: async ({ canvasElement }) => {
    const stack = canvasElement.querySelector("[data-kit-approval-stack]") as HTMLElement;
    await expect(stack.getAttribute("data-collapsed")).toBe("true");
    await expect(overflowing(stack)).toEqual([]);
    for (const btn of stack.querySelectorAll<HTMLElement>('[role="button"]')) {
      await expect(btn.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
  },
});
