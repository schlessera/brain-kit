/**
 * #4212, as #3252 holds every Settings control: the Gmail lists' Revoke
 * targets where ui-react places them, under each rail project's native
 * pointer (fine, coarse, mixed; no matchMedia mock).
 *
 * - Settings › Security: each remembered approval is a whole-row target, at
 *   least 44px on both axes, owning each edge of itself beside the
 *   always-allowed tools. The probe is scoped to the Gmail section.
 * - A restricted chat: each allowance's Revoke is a reaching kit Button inside
 *   the safety notice. Under a coarse pointer it reaches 44px and owns every
 *   edge of that reach; the notice's own controls below it keep theirs.
 */
import { expect, test } from "vitest";
import { page } from "vitest/browser";
import type { SafetyHistoryProjection } from "@schlessera/brain-ui-sdk/protocol";
import { PasskeyTab } from "../../src/components/settings/passkey-tab.js";
import { SessionSafety } from "../../src/components/chat/safety-indicator.js";
import type { TrustSettingsRead } from "../../src/lib/trust-settings.js";
import { mount, reach } from "./hit-reach-scene.js";
import { OWNED, describeHit, probeScope, touchFloor } from "./hit-reach.js";

const ODYSSEUS = "odysseus@example.com", PENELOPE = "penelope@example.com", SESSION = "ithaca";
const trustRead = {
  revision: "0", policyHash: null, error: null, rules: [], origins: [], repositories: [], mutationAllowed: false,
  capabilities: { originRules: true, recipientRules: true, repositoryRules: false, repositoryIdentity: false, readOnlyReason: null },
} satisfies TrustSettingsRead;
const approval = (id: string, account: string, operation: string, entity: string, at: number) =>
  ({ id, principal_id: "owner-odysseus", brain_id: "brain-ithaca", account_identity: account, operation, entity, approved_at: at });
const allowance = (card: string, operation: string, entity: string, remaining: number) => ({
  session_id: SESSION, principal_id: "owner-odysseus", brain_id: "brain-ithaca", account_identity: ODYSSEUS, operation, entity, host_epoch: "epoch-1",
  policy_hash: "policy-1", granted_card_id: card, granted_at: Date.UTC(2026, 6, 12, 8), expires_at: Date.UTC(2026, 6, 12, 18, 2), remaining_items: remaining,
});
const projection: SafetyHistoryProjection = {
  session: { sessionId: SESSION, historyOwnerId: SESSION, historyGeneration: "0" }, evidenceRevision: "1", unresolvedCount: 1, earliestUnresolvedId: null,
  pendingCount: 0, restriction: "restricted", reasons: ["unresolved"], coverage: { detectorVersion: 1, state: "complete", epochs: [], exclusions: [] },
};

for (const width of [320, 1280]) {
  test(`Security tab: remembered Gmail approval rows at ${width}`, async ctx => {
    const s = await mount(ctx, width, async url => {
      if (url.endsWith("/trust-settings")) return Response.json(trustRead);
      if (url.endsWith("/tool-permissions")) return Response.json({ tools: ["Bash"] });
      if (url.endsWith("/google/approvals")) return Response.json({ approvals: [
        approval("appr-drafts", ODYSSEUS, "gmail.draft.save", "drafts", Date.UTC(2026, 6, 9, 8, 5)),
        approval("appr-suitors", PENELOPE, "gmail.modify", "unlabel:Label_7", Date.UTC(2026, 6, 9, 8, 5)),
        approval("appr-archive", ODYSSEUS, "gmail.modify", "archive", Date.UTC(2026, 6, 11, 9, 14)),
      ] });
      if (url.endsWith("/agent-policy")) return Response.json({ error: "Not configured" }, { status: 404 });
      return Response.json({ credentials: [] });
    });
    s.draw(<PasskeyTab active />);
    await expect.poll(() => s.host.querySelector("[data-google-approvals]")?.getAttribute("data-google-approvals")).toBe("ready");
    await expect.poll(() => s.host.textContent).toContain("Always-allowed tools");
    const rows = [...s.host.querySelectorAll<HTMLElement>('[data-google-approvals] [role="button"][data-google-target]')];
    expect(rows.map(row => row.getAttribute("aria-label")), "GOOGLE_SETTINGS_REACH_ROWS").toEqual([
      `Revoke Archive for ${ODYSSEUS}`, `Revoke Save drafts for ${ODYSSEUS}`, `Revoke Remove label Label_7 for ${PENELOPE}`,
    ]);
    expect(rows.map(row => [row.getAttribute("aria-label"), touchFloor(row)]), "GOOGLE_SETTINGS_ROW_TOUCH_FLOOR").toEqual(rows.map(row => [row.getAttribute("aria-label"), "met"]));
    // Scoped to the Gmail section: the tab's own passkey and sign-out Buttons are not this change's.
    const probed = probeScope(s.host.querySelector<HTMLElement>("[data-google-approvals-section]")!);
    expect(probed.map(row => row.name), "every row is probed").toEqual(rows.map(describeHit));
    expect(probed.filter(row => JSON.stringify(row.owners) !== JSON.stringify(OWNED)), "GOOGLE_SETTINGS_ROWS_OWN_THEIR_EDGES").toEqual([]);
  });

  test(`restricted chat: Gmail allowance Revoke at ${width}`, async ctx => {
    const s = await mount(ctx, width, async url => url.endsWith(`/sessions/${SESSION}/google/allowances`)
      ? Response.json({ allowances: [
        allowance("card-ithaca", "gmail.modify", "archive", 84), allowance("card-ithaca", "gmail.modify", "mark_read", 84),
        allowance("card-drafts", "gmail.draft.save", "drafts", 3),
      ] })
      : Response.json({ providers: [] }));
    s.ui.stores.chat.setState({ activeSessionId: SESSION });
    s.ui.stores.safety.setState({ supported: true, status: "ready", reason: null, projection, normal: false });
    s.draw(<div className="px-4 md:px-6"><div className="mx-auto max-w-3xl"><SessionSafety /></div></div>);
    await expect.poll(() => s.host.querySelector("[data-google-allowances]")?.getAttribute("data-google-allowances")).toBe("ready");
    const notice = s.host.querySelector<HTMLElement>("[data-session-safety]")!;
    const revokes = [...notice.querySelectorAll<HTMLElement>("[data-google-allowances] [data-bk-button][role=button]")];
    expect(revokes.map(button => button.getAttribute("aria-label")), "GOOGLE_CHAT_REACH_REVOKES").toEqual(["Revoke Archive and Mark as read", "Revoke Save drafts"]);
    expect(revokes.map(button => [button.getAttribute("aria-label"), touchFloor(button)]), "GOOGLE_CHAT_REVOKE_TOUCH_FLOOR").toEqual(revokes.map(button => [button.getAttribute("aria-label"), "met"]));
    expect(page.getByText("What this evidence covers").elements()).toHaveLength(1);
    reach(notice, "restricted chat safety notice with Gmail allowances");
  });

  // #4212 round 2: a failed read's Try again, where each surface places it.
  test(`Security tab: a failed Gmail approvals read's Try again at ${width}`, async ctx => {
    const s = await mount(ctx, width, async url => {
      if (url.endsWith("/trust-settings")) return Response.json(trustRead);
      if (url.endsWith("/tool-permissions")) return Response.json({ tools: ["Bash"] });
      if (url.endsWith("/google/approvals")) return Response.json({ error: "Internal" }, { status: 500 });
      if (url.endsWith("/agent-policy")) return Response.json({ error: "Not configured" }, { status: 404 });
      return Response.json({ credentials: [] });
    });
    s.draw(<PasskeyTab active />);
    await expect.poll(() => s.host.querySelector("[data-google-approvals]")?.getAttribute("data-google-approvals")).toBe("failed");
    const section = s.host.querySelector<HTMLElement>("[data-google-approvals-section]")!;
    const retry = [...section.querySelectorAll<HTMLElement>("[data-bk-button][role=button]")];
    expect(retry.map(button => button.textContent), "GOOGLE_SETTINGS_REACH_RETRY").toEqual(["Try again"]);
    expect(touchFloor(retry[0]!), "GOOGLE_SETTINGS_RETRY_TOUCH_FLOOR").toBe("met");
    reach(section, "Security tab: failed Gmail approvals read");
  });

  test(`restricted chat: a failed Gmail allowances read's Try again at ${width}`, async ctx => {
    const s = await mount(ctx, width, async url => url.endsWith(`/sessions/${SESSION}/google/allowances`)
      ? Response.json({ error: "Internal" }, { status: 500 })
      : Response.json({ providers: [] }));
    s.ui.stores.chat.setState({ activeSessionId: SESSION });
    s.ui.stores.safety.setState({ supported: true, status: "ready", reason: null, projection, normal: false });
    s.draw(<div className="px-4 md:px-6"><div className="mx-auto max-w-3xl"><SessionSafety /></div></div>);
    await expect.poll(() => s.host.querySelector("[data-google-allowances]")?.getAttribute("data-google-allowances")).toBe("failed");
    const notice = s.host.querySelector<HTMLElement>("[data-session-safety]")!;
    const retry = [...notice.querySelectorAll<HTMLElement>("[data-google-allowances] [data-bk-button][role=button]")];
    expect(retry.map(button => button.textContent), "GOOGLE_CHAT_REACH_RETRY").toEqual(["Try again"]);
    expect(touchFloor(retry[0]!), "GOOGLE_CHAT_RETRY_TOUCH_FLOOR").toBe("met");
    reach(notice, "restricted chat safety notice with a failed Gmail allowances read");
  });
}
