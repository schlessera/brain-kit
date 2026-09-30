import preview from "#.storybook/preview";
import { expect, fn } from "storybook/test";
import { TurnErrorCard } from "../../src/conversation/TurnErrorCard.js";
import { overflowing, stage } from "../_stage.js";

const meta = preview.meta({
  title: "Conversation/TurnErrorCard", component: TurnErrorCard, decorators: [stage],
  parameters: { stageWidth: 320 },
  args: {
    headline: "The provider failed to complete this request.",
    explanation: "Any partial answer and tool activity above are kept.",
    tone: "gold", rows: [{ k: "backend", v: "pi" }, { k: "status", v: "500" }, { k: "class", v: "server_error" }],
    providerMessage: "Provider returned a failure.", backend: "pi",
    actions: [{ label: "Retry", primary: true, onClick: fn() }, { label: "Copy details", onClick: fn() }], retryWarning: true,
  },
});

const play = async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  const card = canvasElement.querySelector<HTMLElement>('[aria-label="Turn failed"]')!;
  await expect(overflowing(card)).toEqual([]);
  await expect(card.getBoundingClientRect().width).toBeCloseTo(card.parentElement!.getBoundingClientRect().width, 0);
  for (const control of card.querySelectorAll<HTMLElement>('[role="button"]')) {
    await expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  }
};
export const Default = meta.story({ args: {
  headline: "The provider failed to complete this request.", explanation: "Any partial answer and tool activity above are kept.", tone: "gold", rows: [{ k: "class", v: "server_error" }], providerMessage: "Provider returned a failure.",
  actions: [{ label: "Retry", primary: true, onClick: fn() }, { label: "Copy details", onClick: fn() }],
}, play });
export const Wide = Default.extend({ parameters: { stageWidth: 860 } });

export const AuthenticationFailed = Default.extend({ args: { headline: "The backend credential was refused.", tone: "red", rows: [{ k: "class", v: "authentication_failed" }], actions: [{ label: "Copy details", primary: true, onClick: fn() }], providerOpen: false } });
export const AuthenticationFailedWide = AuthenticationFailed.extend({ parameters: { stageWidth: 860 } });

export const OrganisationRefused = Default.extend({ args: { headline: "The Claude account itself was refused.", tone: "red", rows: [{ k: "class", v: "oauth_org_not_allowed" }], actions: [{ label: "Copy details", primary: true, onClick: fn() }], providerOpen: false } });
export const OrganisationRefusedWide = OrganisationRefused.extend({ parameters: { stageWidth: 860 } });

export const AccountOnHold = Default.extend({ args: { headline: "The Claude account itself was refused.", tone: "red", rows: [{ k: "class", v: "account_on_hold" }], actions: [{ label: "Copy details", primary: true, onClick: fn() }], providerOpen: false } });
export const AccountOnHoldWide = AccountOnHold.extend({ parameters: { stageWidth: 860 } });

export const BillingError = Default.extend({ args: { headline: "The Claude account itself was refused.", tone: "red", rows: [{ k: "class", v: "billing_error" }], actions: [{ label: "Copy details", primary: true, onClick: fn() }], providerOpen: false } });
export const BillingErrorWide = BillingError.extend({ parameters: { stageWidth: 860 } });

export const SubscriptionRequired = Default.extend({ args: { headline: "The Claude subscription configuration was refused.", tone: "red", rows: [{ k: "class", v: "subscription_required" }], actions: [{ label: "Copy details", primary: true, onClick: fn() }], providerOpen: false } });
export const SubscriptionRequiredWide = SubscriptionRequired.extend({ parameters: { stageWidth: 860 } });

export const RateLimit = Default.extend({ args: { headline: "The provider rate limited this request.", tone: "gold", rows: [{ k: "class", v: "rate_limit" }], actions: [{ label: "Retry", primary: true, onClick: fn() }, { label: "Copy details", onClick: fn() }], providerOpen: false } });
export const RateLimitWide = RateLimit.extend({ parameters: { stageWidth: 860 } });

export const Overloaded = Default.extend({ args: { headline: "The provider is overloaded.", tone: "gold", rows: [{ k: "class", v: "overloaded" }], actions: [{ label: "Retry", primary: true, onClick: fn() }, { label: "Copy details", onClick: fn() }], providerOpen: false } });
export const OverloadedWide = Overloaded.extend({ parameters: { stageWidth: 860 } });

export const InvalidRequest = Default.extend({ args: { headline: "The provider rejected this request.", tone: "red", rows: [{ k: "class", v: "invalid_request" }], actions: [{ label: "Copy details", primary: true, onClick: fn() }, { label: "Report a bug", onClick: fn() }], providerOpen: false } });
export const InvalidRequestWide = InvalidRequest.extend({ parameters: { stageWidth: 860 } });

export const ModelNotFound = Default.extend({ args: { headline: "This model is unavailable on the backend.", tone: "red", rows: [{ k: "class", v: "model_not_found" }], actions: [{ label: "Copy details", primary: true, onClick: fn() }], providerOpen: false } });
export const ModelNotFoundWide = ModelNotFound.extend({ parameters: { stageWidth: 860 } });

export const MaxOutputTokens = Default.extend({ args: { headline: "The answer reached its length limit and stopped.", tone: "gold", rows: [{ k: "class", v: "max_output_tokens" }], actions: [{ label: "Copy details", primary: true, onClick: fn() }], providerOpen: false } });
export const MaxOutputTokensWide = MaxOutputTokens.extend({ parameters: { stageWidth: 860 } });

export const Unknown = Default.extend({ args: { headline: "This turn failed.", tone: "red", rows: [{ k: "class", v: "unknown" }], actions: [{ label: "Retry", primary: true, onClick: fn() }, { label: "Copy details", onClick: fn() }, { label: "Report a bug", onClick: fn() }], providerOpen: true } });
export const UnknownWide = Unknown.extend({ parameters: { stageWidth: 860 } });

export const Busy = Default.extend({ args: { busy: true, actions: [{ label: "Retrying…", disabled: true, onClick: fn() }, { label: "Copy details", disabled: true, onClick: fn() }] } });
export const SendFailed = Default.extend({ args: { notice: "Couldn't send. Check the connection and try again." } });
export const DeliveryUnknown = Default.extend({ args: { notice: "Delivery is unconfirmed. Check delivery before sending another turn.", actions: [{ label: "Check delivery", primary: true, onClick: fn() }, { label: "Copy details", onClick: fn() }] } });
export const Live = Default.extend({ args: { announce: true }, play: async context => { await play(context); await expect(context.canvasElement.querySelectorAll('[role="alert"]')).toHaveLength(1); } });
export const Replay = Default.extend({ args: { announce: false }, play: async context => { await play(context); await expect(context.canvasElement.querySelector('[role="alert"]')).toBeNull(); } });
export const ReplayNotLatest = Replay.extend({ args: { retryWarning: false, actions: [{ label: "Copy details", primary: true, onClick: fn() }] } });
export const LongMessage = Unknown.extend({ args: { providerMessage: "Unbroken provider detail ".repeat(300) } });
export const LongMessageWide = LongMessage.extend({ parameters: { stageWidth: 860 } });
