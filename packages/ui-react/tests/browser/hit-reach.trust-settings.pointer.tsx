import { useLayoutEffect, type ReactNode } from "react";
import { createBrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
/**
 * Security Settings transition model (review round 2).
 * Review = a host-prepared exact-byte proposal, with no publication yet.
 * Unknown outcomes are retained as unknown when their editor is left.
 *
 * | ID | From | Event / evidence | To / invariant |
 * | T01 | idle | owner + capability, Add/Edit/Remove | draft |
 * | T02 | draft | prepare succeeds | preparing -> review (prepared) |
 * | T03 | review | Save + proved receipt | committing -> idle, fresh facts |
 * | T04 | draft/review | Cancel | idle, focus returns |
 * | T05 | committing | reply lost | uncertain, no replay |
 * | T06 | uncertain | proved receipt | idle, truthful current rule |
 * | T07 | review/uncertain | expired unsent or prepared/not_published | draft |
 * | T08 | uncertain | unknown receipt, including expired | uncertain |
 * | T09 | uncertain | receipt permanently 404 | receipt-lost |
 * | T10 | uncertain/receipt-lost | Leave as outcome unknown | idle + unknown notice |
 * | T11 | draft/review/uncertain/receipt-lost | read denied (401/403) | idle, no protected draft/bytes; dispatched saves stay unknown |
 * | T12 | any | auth epoch/root replaced | idle, no protected state; same-root unknown count retained |
 * | T13 | preparing/review | readable but owner unavailable | draft, no private/late review |
 * | T14 | any edit | read unavailable then recovers | suspended writes -> same edit; preparing -> draft, committing -> uncertain |
 * | T15 | draft/review | required enforcement withdrawn | same edit, writes disabled |
 * | T16 | capability-blocked | required enforcement restored | same intent, writes enabled |
 * | T17 | draft | unrelated revision; selected bytes + instance unchanged | refresh base, preserve intent |
 * | T18 | draft | selected bytes/instance changed or disappeared | conflict, explicit re-selection |
 * | T19 | preparing/review | policy base changes | draft, discard stale preview/reply |
 * | T20 | removal draft/review | enforcement withdrawn | revocation remains available |
 * | T21 | any edit | responsive remount | preserve edit; preparing -> draft, committing -> uncertain |
 * | T22 | any readable state | list refresh / Save | refresh enforcing facts, no stale current claim |
 * | T23 | committing / receipt lookup pending | Leave as outcome unknown | idle + unknown notice; late reply fenced |
 */
import { expect, inject, test, vi, type TestContext } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { PasskeyList } from "../../src/components/settings/passkey-list.js";
import { TrustSettingsSection } from "../../src/components/settings/trust-settings-section.js";
import type { TrustRule, TrustSettingsRead, TrustOperation, TrustChange } from "../../src/lib/trust-settings.js";
import { mount, reach } from "./hit-reach-scene.js";

const button = (name: string | RegExp) => page.getByRole("button", { name, exact: typeof name === "string" });
const rule = { id: "ithaca", label: "Ithaca", incomingContent: true, recipientWhileRestricted: false, selector: { kind: "web_origin", scheme: "https", host: "example.org", port: 443 } } satisfies TrustRule;
async function scene(ctx: TestContext, width: number, theme: string, rules: TrustRule[] = []) {
  let read: TrustSettingsRead = { revision: "0", policyHash: null, error: null, instances: Object.fromEntries(rules.map(r => [r.id, "birth-0"])), rules, origins: rules.filter(r => !r.selector.kind.startsWith("github_")), repositories: rules.filter(r => r.selector.kind.startsWith("github_")), mutationAllowed: true,
    capabilities: { originRules: true, recipientRules: true, repositoryRules: false, repositoryIdentity: true, readOnlyReason: null } };
  const calls: { path: string; body?: Record<string, unknown> }[] = [];
  let change: TrustChange, operation: TrustOperation, stale = false, loseReply = false;
  let listFailure = 0, policyFailure = 0, receiptFailure = 0, commitFailure = 0, expired = false, dropCommit = false, prepareWait: Promise<void> | undefined, listWait: Promise<void> | undefined;
  let releaseList: (() => void) | undefined;
  let commitWait: Promise<void> | undefined, policyWait: Promise<void> | undefined, receiptWait: Promise<void> | undefined;
  let releaseReceipt: (() => void) | undefined;
  let releaseCommit: (() => void) | undefined, releasePolicy: (() => void) | undefined;
  let prepareReplies = 0, commitEnforced = true;
  let releasePrepare: (() => void) | undefined;
  const s = await mount(ctx, width, async (url, init) => {
    const path = new URL(url, location.href).pathname, body = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({ path, body });
    if (path.endsWith("/agent-policy")) {
      const hash = read.policyHash; if (policyWait) await policyWait;
      return policyFailure ? Response.json({ reason: "unavailable" }, { status: policyFailure }) : Response.json({ source: hash ? "policy" : "default", hash,
        path: "context/policies/governance.md", errors: [], warnings: [], profiles: { interactive: "governed", voice: "strict" }, protectedPaths: [], workerLimits: null });
    }
    if (path.endsWith("/trust-settings/prepare")) {
      if (stale) return Response.json({ error: "stale_base" }, { status: 409 });
      change = body.change;
      operation = { receipt: { requestId: "ithaca-review", stage: "prepared", publication: "not_published", currentRule: "unknown", enforcement: "unavailable", reason: null },
        review: { reviewId: "ithaca-bytes", reviewedBytesHash: "a".repeat(64), base: null, proposed: JSON.stringify(change), diff: JSON.stringify(change), expiresAt: Date.now() + 60_000, includesFutureRepositories: false }, policy: read, capabilities: read.capabilities };
      if (prepareWait) await prepareWait; prepareReplies++;
      return Response.json(operation);
    }
    if (path.endsWith("/trust-settings/commit")) {
      if (commitFailure) return Response.json({ reason: "unauthorized" }, { status: commitFailure });
      if (dropCommit) throw new Error("connection ended before commit");
      if (expired) return Response.json({ reason: "request_expired" }, { status: 409 });
      const selected = change;
      read.rules = selected.action === "remove" ? read.rules.filter(r => r.id !== selected.ruleId) : [...read.rules.filter(r => r.id !== selected.rule.id), selected.rule];
      read = { ...read, revision: String(Number(read.revision) + 1), policyHash: "a".repeat(64), origins: read.rules.filter(r => !r.selector.kind.startsWith("github_")), repositories: read.rules.filter(r => r.selector.kind.startsWith("github_")) };
      operation = { ...operation, receipt: { ...operation.receipt, stage: commitEnforced ? "committed" : "partial", publication: "proved", currentRule: change.action === "remove" ? "removed" : "present", enforcement: commitEnforced ? "enforced" : "unavailable" } };
      if (commitWait) await commitWait;
      if (loseReply) throw new Error("lost reply");
      return Response.json(operation);
    }
    if (path.endsWith("/trust-settings/ithaca-review")) { if (receiptWait) await receiptWait; return receiptFailure ? Response.json({ reason: "unavailable" }, { status: receiptFailure }) : Response.json(operation); }
    if (listWait) await listWait;
    return listFailure ? Response.json({ reason: "read_unavailable" }, { status: listFailure }) : Response.json(read);
  });
  s.ui.stores.connection.getState().setVpnStatus("connected", "odysseus");
  document.documentElement.dataset.theme = theme;
  s.draw(<TrustSettingsSection active />);
  await expect.element(button("Add origin")).toBeVisible();
  return { ...s, calls, setRead(next: Partial<TrustSettingsRead>) { read = { ...read, ...next, ...(next.rules ? { origins: next.rules.filter(r => !r.selector.kind.startsWith("github_")), repositories: next.rules.filter(r => r.selector.kind.startsWith("github_")) } : {}) }; },
    holdReceipt() { receiptWait = new Promise<void>(resolve => { releaseReceipt = resolve; }); },
    releaseReceipt() { releaseReceipt?.(); },
    holdCommit() { commitWait = new Promise<void>(resolve => { releaseCommit = resolve; }); },
    releaseCommit() { releaseCommit?.(); },
    holdPolicy() { policyWait = new Promise<void>(resolve => { releasePolicy = resolve; }); },
    releasePolicy() { releasePolicy?.(); },
    failPolicy(status: number) { policyFailure = status; },
    unavailableCommit() { commitEnforced = false; },
    prepareReplies() { return prepareReplies; },
    failReceipt(status: number) { receiptFailure = status; },
    rejectCommit(status: number) { commitFailure = status; },
    loseBeforeCommit() { dropCommit = true; },
    holdList() { listWait = new Promise<void>(resolve => { releaseList = resolve; }); },
    releaseList() { releaseList?.(); },
    failList(status: number) { listFailure = status; },
    expireHostReview() { expired = true; operation.review.expiresAt = Date.now() - 1; },
    unknownExpiredReceipt() { operation.receipt.stage = "unknown"; operation.receipt.publication = "unknown"; operation.review.expiresAt = Date.now() - 1; },
    holdPrepare() { prepareWait = new Promise<void>(resolve => { releasePrepare = resolve; }); },
    releasePrepare() { releasePrepare?.(); }, stale(value: boolean) { stale = value; }, loseReply() { loseReply = true; } };
}
for (const width of [320, 1280]) for (const theme of ["dark", "light"]) {
  test(`T01 T02 T03 trust canonical CRUD, exact review and independent permission at ${width} ${theme}`, async ctx => {
    const s = await scene(ctx, width, theme);
    if (inject("railPointer") === "fine") await button("Add origin").click();
    else { const node = button("Add origin").element(); node.scrollIntoView({ block: "center" }); const r = node.getBoundingClientRect(); await commands.rankTap({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); }
    await expect.element(page.getByRole("checkbox", { name: /Allow sending data while restricted/ })).not.toBeChecked();
    await page.getByLabelText("Origin", { exact: true }).fill("https://example.org/path");
    await button("Review change").click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("bare HTTP(S) origin");
    await expect.element(page.getByLabelText("Origin", { exact: true })).toHaveValue("https://example.org/path");
    await page.getByLabelText("Origin", { exact: true }).fill("https://EXAMPLE.org/");
    await page.getByLabelText("Label", { exact: true }).fill("Ithaca");
    await button("Review change").click();
    await expect.element(button("Save rule")).toBeVisible();
    expect(s.calls.filter(c => c.path.endsWith("/commit"))).toHaveLength(0);
    expect(s.host.textContent).toContain('"recipientWhileRestricted":false');
    await expect.poll(() => document.activeElement?.textContent).toBe("Review exact policy change");
    reach(s.host, "trust review");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth);
    await button("Save rule").click();
    await expect.element(button("Edit https://example.org:443")).toBeVisible();
    expect(s.host.scrollWidth).toBeLessThanOrEqual(width);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth);
    await button("Edit https://example.org:443").click();
    await page.getByLabelText("Label", { exact: true }).fill("Home harbor");
    await page.getByRole("checkbox", { name: /Allow sending data while restricted/ }).click();
    await button("Review change").click(); await button("Save rule").click();
    await expect.poll(() => s.host.textContent).toContain("Home harbor");
    await button("Remove https://example.org:443").click();
    expect(s.host.textContent).toContain("Historical events remain unchanged");
    await button("Review change").click(); await button("Remove rule").click();
    await expect.element(button("Add origin")).toBeEnabled();
    expect(s.calls.filter(c => c.path.includes("safety"))).toHaveLength(0);
    expect(s.host.textContent).toContain("Current rule: removed");
  });
  test(`T05 T06 T21 trust stale base, remount and lost save never discard or republish at ${width} ${theme}`, async ctx => {
    const s = await scene(ctx, width, theme);
    await button("Add origin").click();
    await page.getByLabelText("Origin", { exact: true }).fill("https://example.org");
    s.stale(true); await button("Review change").click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("stale_base");
    s.draw(null); s.draw(<TrustSettingsSection active />);
    await expect.element(page.getByLabelText("Origin", { exact: true })).toHaveValue("https://example.org");
    s.stale(false); await button("Refresh base").click(); await button("Review change").click();
    s.loseReply(); await button("Save rule").click();
    await expect.element(button("Check save receipt")).toBeVisible();
    s.draw(null); s.draw(<TrustSettingsSection active />);
    await button("Check save receipt").click();
    await expect.element(button("Edit https://example.org:443")).toBeVisible();
    expect(s.calls.filter(c => c.path.endsWith("/commit"))).toHaveLength(1);
  });
}
test("read-only, missing capability, invalid policy and auth loss never expose mutation", async ctx => {
  const s = await scene(ctx, 320, "light", [rule, { ...rule, id: "argo", selector: { kind: "github_owner", host: "github.com", owner: "odysseus", ownerId: "12" } }]);
  await expect.element(button("Add repository or organization")).toBeDisabled();
  expect(s.host.textContent).toContain("includes future repositories");
  await button("Add origin").click(); await page.getByLabelText("Label", { exact: true }).fill("Private draft");
  s.setRead({ mutationAllowed: false, error: "policy_unavailable" }); window.dispatchEvent(new Event("focus"));
  await expect.element(button("Review change")).toBeDisabled();
  await expect.element(page.getByLabelText("Label", { exact: true })).toHaveValue("Private draft");
  expect(s.host.textContent).toContain("last-valid rules");
  flushSync(() => { void s.ui.authLock.expire("revoked"); });
  await expect.poll(() => s.host.querySelectorAll("input").length).toBe(0);
});

test("duplicate canonical targets stay actionable and cancel returns focus", async ctx => {
  const s = await scene(ctx, 320, "dark", [rule]);
  await button("Add origin").click(); await page.getByLabelText("Origin", { exact: true }).fill("https://EXAMPLE.org/");
  await button("Review change").click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("already has a rule");
  await button("Cancel").click();
  await expect.poll(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent).toContain("Add origin");
  expect(s.calls.filter(c => c.path.endsWith("/prepare"))).toHaveLength(0);
});

test("mixed-version hosts are read-only and tunnel scope never looks like HTTPS", async ctx => {
  const s = await scene(ctx, 320, "light", [{ ...rule, selector: { kind: "tunnel_authority", host: "example.org", port: 443 } }]);
  expect(s.host.textContent).toContain("opaque tunnel");
  expect(s.host.textContent).toContain("not verified HTTPS");
  s.setRead({ mutationAllowed: undefined }); window.dispatchEvent(new Event("focus"));
  await expect.element(button("Add origin")).toBeDisabled();
  expect(s.host.textContent).toContain("Read-only");
  expect(s.calls.filter(c => c.path.endsWith("/prepare"))).toHaveLength(0);
});

test("T04 keyboard review and cancel retain focus without changing the policy", async ctx => {
  const s = await scene(ctx, 320, "dark");
  (button("Add origin").element() as HTMLElement).focus(); await userEvent.keyboard("{Enter}");
  await page.getByLabelText("Origin", { exact: true }).fill("https://example.org");
  (button("Review change").element() as HTMLElement).focus(); await userEvent.keyboard("{Enter}");
  await expect.poll(() => document.activeElement?.textContent).toBe("Review exact policy change");
  (button("Cancel").element() as HTMLElement).focus(); await userEvent.keyboard("{Enter}");
  await expect.poll(() => document.activeElement?.textContent).toContain("Add origin");
  expect(s.calls.filter(c => c.path.endsWith("/commit"))).toHaveLength(0);
});

for (const kind of ["github_repository", "github_owner"] as const) test(`qualified host exposes bounded ${kind} CRUD without recipient permission`, async ctx => {
  const s = await scene(ctx, 320, "light");
  s.setRead({ capabilities: { originRules: true, recipientRules: true, repositoryRules: true, repositoryIdentity: true, readOnlyReason: null } });
  window.dispatchEvent(new Event("focus"));
  await expect.element(button("Add repository or organization")).toBeEnabled();
  await button("Add repository or organization").click();
  if (kind === "github_owner") await page.getByRole("combobox", { name: /Target type/ }).selectOptions("github_owner");
  await page.getByLabelText(kind === "github_owner" ? "GitHub owner" : "GitHub owner/repository", { exact: true }).fill(kind === "github_owner" ? "Odysseus" : "Odysseus/Navigation.git");
  await page.getByLabelText("Stable provider ID (verified independently by the host)", { exact: true }).fill("12");
  await expect.element(page.getByRole("checkbox", { name: /Allow sending data while restricted/ })).toBeDisabled();
  if (kind === "github_owner") expect(s.host.textContent).toContain("includes present and future repositories");
  await button("Review change").click();
  const prepared = s.calls.find(c => c.path.endsWith("/prepare"))!.body!.change as TrustChange;
  expect(prepared).toMatchObject({ action: "create", rule: { incomingContent: true, recipientWhileRestricted: false, selector: { kind, owner: "odysseus" } } });
  await button("Save rule").click();
  const target = kind === "github_owner" ? "github.com/odysseus · owner ID 12 · includes future repositories" : "github.com/odysseus/navigation · repository ID 12";
  await button(`Edit ${target}`).click(); await page.getByLabelText("Label", { exact: true }).fill("Argo");
  await button("Review change").click(); await button("Save rule").click();
  await expect.poll(() => s.host.textContent).toContain("Argo");
  await button(`Remove ${target}`).click(); await button("Review change").click(); await button("Remove rule").click();
  await expect.element(button("Add repository or organization")).toBeEnabled();
  expect(s.host.textContent).not.toContain(target);
});

async function prepared(ctx: TestContext) {
  const s = await scene(ctx, 320, "dark");
  await button("Add origin").click(); await page.getByLabelText("Origin", { exact: true }).fill("https://example.org");
  await button("Review change").click(); await expect.element(button("Save rule")).toBeVisible();
  return s;
}

test("T13 F2 owner downgrade removes the private review, including a late prepare reply", async ctx => {
  const s = await prepared(ctx);
  expect(s.host.querySelector("pre")).not.toBeNull();
  s.setRead({ mutationAllowed: false }); window.dispatchEvent(new Event("focus"));
  await expect.element(button("Save rule")).not.toBeInTheDocument();
  expect(s.host.querySelector("pre")).toBeNull();
  s.setRead({ mutationAllowed: true }); window.dispatchEvent(new Event("focus"));
  await expect.element(button("Review change")).toBeEnabled();
  s.holdPrepare(); await button("Review change").click();
  s.setRead({ mutationAllowed: false }); window.dispatchEvent(new Event("focus"));
  await expect.element(button("Review change")).toBeDisabled();
  s.releasePrepare();
  await expect.poll(() => s.host.querySelector("pre")).toBeNull();
});

test("F3 expired prepared reviews recover without replaying a commit", async ctx => {
  const s = await prepared(ctx); s.expireHostReview();
  await button("Save rule").click();
  await expect.element(button("Cancel")).toBeEnabled();
  await expect.element(button("Review change")).toBeEnabled();
  await expect.element(page.getByLabelText("Origin", { exact: true })).toHaveValue("https://example.org");
  expect(s.calls.filter(c => c.path.endsWith("/commit"))).toHaveLength(1);
  s.draw(null); s.draw(<TrustSettingsSection active />);
  await expect.element(button("Cancel")).toBeEnabled();
});

test("T08 F3 elapsed unknown publication remains uncertain after receipt expiry", async ctx => {
  const s = await prepared(ctx); s.loseReply(); await button("Save rule").click();
  await expect.element(button("Check save receipt")).toBeVisible();
  s.unknownExpiredReceipt(); await button("Check save receipt").click();
  await expect.element(button("Cancel")).toBeDisabled();
  expect(s.calls.filter(c => c.path.endsWith("/commit"))).toHaveLength(1);
});

for (const action of ["edit", "remove"] as const) test(`F4 refresh never rebases ${action} onto a revoked capability or reused identity`, async ctx => {
  const original = { ...rule, recipientWhileRestricted: true };
  const s = await scene(ctx, 320, "light", [original]);
  await button(`${action === "edit" ? "Edit" : "Remove"} https://example.org:443`).click();
  if (action === "edit") await page.getByLabelText("Label", { exact: true }).fill("Edited harbor");
  s.setRead({ revision: "2", policyHash: "b".repeat(64), rules: [{ ...original, recipientWhileRestricted: false,
    ...(action === "remove" ? { selector: { ...rule.selector, host: "troy.example.org" } } : {}) }] });
  await button("Refresh base").click();
  await expect.element(button("Review change")).toBeDisabled();
  await expect.element(page.getByRole("alert")).toHaveTextContent("select the current rule");
  if (action === "edit") await expect.element(page.getByLabelText("Label", { exact: true })).toHaveValue("Edited harbor");
  expect(s.calls.filter(c => c.path.endsWith("/prepare"))).toHaveLength(0);
});

for (const status of [403, 503]) test(`T11 T14 F5 failed ${status} refresh disables cached authority and successful reads clear its error`, async ctx => {
  const s = await prepared(ctx); s.failList(status); window.dispatchEvent(new Event("focus"));
  await expect.element(page.getByRole("alert")).toBeVisible();
  await expect.poll(() => button("Save rule").elements().every(node => node.getAttribute("aria-disabled") === "true")).toBe(true);
  expect(s.host.querySelector("pre")).toBeNull();
  s.failList(0); window.dispatchEvent(new Event("focus"));
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  if (status === 403) { await expect.element(button("Add origin")).toBeEnabled(); expect(s.host.querySelector("input")).toBeNull(); }
  else await expect.element(page.getByLabelText("Origin", { exact: true })).toHaveValue("https://example.org");
});

test("T07 F3 locally expired unsent review returns to the draft without dispatch", async ctx => {
  const s = await prepared(ctx); vi.setSystemTime(Date.now() + 900_001);
  await button("Save rule").click(); await expect.element(button("Review change")).toBeEnabled();
  expect(s.calls.filter(c => c.path.endsWith("/commit"))).toHaveLength(0);
});

test("T07 F3 expired prepared receipt proves an interrupted commit can leave review", async ctx => {
  const s = await prepared(ctx); s.loseBeforeCommit(); await button("Save rule").click();
  await expect.element(button("Check save receipt")).toBeVisible();
  s.expireHostReview(); await button("Check save receipt").click();
  await expect.element(button("Review change")).toBeEnabled(); await expect.element(button("Cancel")).toBeEnabled();
  expect(s.calls.filter(c => c.path.endsWith("/commit"))).toHaveLength(1);
});

test("F4 even byte-identical ID reuse requires selecting the current rule", async ctx => {
  const s = await scene(ctx, 320, "dark", [rule]);
  await button("Remove https://example.org:443").click(); s.setRead({ revision: "2", rules: [rule], instances: { [rule.id]: "birth-2" } });
  await button("Refresh base").click(); await expect.element(button("Review change")).toBeDisabled();
  expect(s.calls.filter(c => c.path.endsWith("/prepare"))).toHaveLength(0);
});

test("F4 ordinary policy hash refresh preserves a label draft at the same trust revision", async ctx => {
  const s = await scene(ctx, 320, "dark", [rule]);
  await button("Edit https://example.org:443").click(); await page.getByLabelText("Label", { exact: true }).fill("Edited harbor");
  s.setRead({ policyHash: "b".repeat(64) }); await button("Refresh base").click(); await button("Review change").click();
  await expect.element(button("Save rule")).toBeVisible();
  expect(s.calls.find(c => c.path.endsWith("/prepare"))!.body).toMatchObject({ expectedTrustRevision: "0", expectedPolicyHash: "b".repeat(64), change: { rule: { label: "Edited harbor", recipientWhileRestricted: false } } });
});

test("T12 F2 auth loss during a pending list read cannot restore private review or capability", async ctx => {
  const s = await prepared(ctx); s.holdList(); window.dispatchEvent(new Event("focus"));
  await expect.poll(() => s.calls.filter(c => c.path.endsWith("/trust-settings")).length).toBeGreaterThan(1);
  flushSync(() => { void s.ui.authLock.expire("revoked"); }); s.releaseList();
  await expect.poll(() => s.host.querySelectorAll("input, pre").length).toBe(0);
  await expect.element(button("Save rule")).not.toBeInTheDocument();
});

for (const status of [401, 403]) test(`F2 a denied owner commit ${status} immediately removes private bytes and stale write authority`, async ctx => {
  const s = await prepared(ctx); s.rejectCommit(status); await button("Save rule").click();
  await expect.poll(() => s.host.querySelectorAll("input, pre").length).toBe(0);
  await expect.element(button("Review change")).not.toBeInTheDocument();
  expect(s.calls.filter(c => c.path.endsWith("/commit"))).toHaveLength(1);
  expect(s.host.textContent).toContain("outcome remains unknown");
});

for (const status of [401, 403]) for (const phase of ["draft", "review", "uncertain", "receipt-lost"] as const) test(`T11 F1 denied read ${status} clears protected ${phase} data across remount`, async ctx => {
  const s = await scene(ctx, 320, "dark", [rule]);
  await button("Edit https://example.org:443").click();
  await page.getByLabelText("Label", { exact: true }).fill("Protected harbor draft");
  if (phase !== "draft") { await button("Review change").click(); await expect.element(button("Save rule")).toBeVisible(); }
  if (phase === "uncertain" || phase === "receipt-lost") { s.loseBeforeCommit(); await button("Save rule").click(); await expect.element(button("Check save receipt")).toBeVisible(); }
  if (phase === "receipt-lost") { s.failReceipt(404); await button("Check save receipt").click(); }
  s.failList(status); window.dispatchEvent(new Event("focus"));
  await expect.poll(() => s.host.querySelector('[aria-label="Trust rule editor"]')).toBeNull();
  expect(s.host.textContent).not.toContain("example.org");
  if (phase === "uncertain" || phase === "receipt-lost") expect(s.host.textContent).toContain("outcome remains unknown");
  s.draw(null); s.draw(<TrustSettingsSection active />);
  await expect.poll(() => s.host.querySelectorAll("input, pre").length).toBe(0);
  if (phase === "uncertain" || phase === "receipt-lost") expect(s.host.textContent).toContain("outcome remains unknown");
});

for (const status of [401, 403]) test(`F5 denied receipt ${status} retains the unknown outcome after clearing private data`, async ctx => {
  const s = await prepared(ctx); s.loseBeforeCommit(); await button("Save rule").click();
  await expect.element(button("Check save receipt")).toBeVisible();
  s.failReceipt(status); await button("Check save receipt").click();
  await expect.poll(() => s.host.querySelectorAll("input, pre").length).toBe(0);
  expect(s.host.textContent).toContain("outcome remains unknown");
  expect(s.calls.filter(c => c.path.endsWith("/commit"))).toHaveLength(1);
});

for (const status of [401, 403]) test(`F5 denied read ${status} retains an already abandoned unknown outcome without counting twice`, async ctx => {
  const s = await prepared(ctx); s.loseBeforeCommit(); await button("Save rule").click();
  await expect.element(button("Check save receipt")).toBeVisible(); await button("Leave as outcome unknown").click();
  await expect.element(button("Add origin")).toBeEnabled(); await button("Add origin").click();
  s.failList(status); window.dispatchEvent(new Event("focus"));
  await expect.poll(() => s.host.querySelectorAll("input, pre").length).toBe(0);
  expect(s.host.textContent).toContain("A previous save outcome remains unknown");
  expect(s.host.textContent).not.toContain("2 save outcomes");
});

for (const lost of [false, true]) test(`T09 T10 F2 leaving ${lost ? "receipt-lost" : "uncertain"} retains outcome unknown without replay`, async ctx => {
  const s = await prepared(ctx); s.loseBeforeCommit(); await button("Save rule").click();
  await expect.element(button("Check save receipt")).toBeVisible();
  if (lost) { s.failReceipt(404); await button("Check save receipt").click(); }
  await button("Leave as outcome unknown").click();
  await expect.element(button("Add origin")).toBeEnabled();
  expect(s.host.textContent).toContain("outcome remains unknown");
  s.draw(null); s.draw(<TrustSettingsSection active />);
  await expect.element(button("Add origin")).toBeEnabled();
  expect(s.host.textContent).toContain("outcome remains unknown");
  expect(s.calls.filter(c => c.path.endsWith("/commit"))).toHaveLength(1);
});

for (const phase of ["draft", "review"] as const) for (const kind of ["origin", "recipient", "repository"] as const) test(`T15 T16 F3 ${kind} capability withdraw/restore preserves ${phase} but fences writes`, async ctx => {
  const selected: TrustRule = kind === "repository" ? { ...rule, selector: { kind: "github_repository", host: "github.com", owner: "odysseus", repository: "navigation", repositoryId: "12" } } : { ...rule, recipientWhileRestricted: kind === "recipient" };
  const s = await scene(ctx, 320, "light", [selected]);
  const caps = { originRules: true, recipientRules: true, repositoryRules: true, repositoryIdentity: true, readOnlyReason: null };
  s.setRead({ capabilities: caps }); window.dispatchEvent(new Event("focus"));
  const target = kind === "repository" ? "github.com/odysseus/navigation · repository ID 12" : "https://example.org:443";
  await expect.element(button(`Edit ${target}`)).toBeEnabled(); await button(`Edit ${target}`).click();
  await page.getByLabelText("Label", { exact: true }).fill("Edited harbor");
  if (phase === "review") { await button("Review change").click(); await expect.element(button("Save rule")).toBeVisible(); }
  const field = kind === "origin" ? "originRules" : kind === "recipient" ? "recipientRules" : "repositoryRules";
  s.setRead({ capabilities: { ...caps, [field]: false } }); window.dispatchEvent(new Event("focus"));
  await expect.element(button(phase === "draft" ? "Review change" : "Save rule")).toBeDisabled();
  s.setRead({ capabilities: caps }); window.dispatchEvent(new Event("focus"));
  await expect.element(button(phase === "draft" ? "Review change" : "Save rule")).toBeEnabled();
  await expect.element(page.getByLabelText("Label", { exact: true })).toHaveValue("Edited harbor");
});

test("T17 F4 unrelated trust revision refresh preserves selected label and permission intent", async ctx => {
  const s = await scene(ctx, 320, "dark", [rule]);
  await button("Edit https://example.org:443").click(); await page.getByLabelText("Label", { exact: true }).fill("Edited harbor");
  await page.getByRole("checkbox", { name: /Allow sending data while restricted/ }).click();
  s.setRead({ revision: "2", policyHash: "b".repeat(64), rules: [rule, { ...rule, id: "argo", selector: { ...rule.selector, host: "troy.example.org" } }] });
  await button("Refresh base").click(); await expect.element(button("Review change")).toBeEnabled();
  await button("Review change").click(); await expect.element(button("Save rule")).toBeVisible();
  expect(s.calls.find(c => c.path.endsWith("/prepare"))!.body).toMatchObject({ expectedTrustRevision: "2", change: { rule: { label: "Edited harbor", recipientWhileRestricted: true } } });
});

for (const trigger of ["focus", "save"] as const) test(`T22 F5 ${trigger} refreshes the enforcing policy facts with trust facts`, async ctx => {
  const s = await scene(ctx, 320, "dark");
  await expect.poll(() => s.calls.filter(c => c.path.endsWith("/agent-policy")).length).toBe(1);
  if (trigger === "focus") { s.setRead({ policyHash: "b".repeat(64) }); window.dispatchEvent(new Event("focus")); }
  else { await button("Add origin").click(); await page.getByLabelText("Origin", { exact: true }).fill("https://example.org"); await button("Review change").click(); await button("Save rule").click(); }
  await expect.poll(() => s.host.querySelector("[data-agent-policy]")?.textContent).toContain(`Enforcing version: ${(trigger === "focus" ? "b" : "a").repeat(64)}`);
});

for (const phase of ["draft", "review", "uncertain", "receipt-lost"] as const) test(`T14 unavailable/recovered read preserves ${phase} without stale write authority`, async ctx => {
  const s = await scene(ctx, 320, "light", [rule]); await button("Edit https://example.org:443").click();
  await page.getByLabelText("Label", { exact: true }).fill("Preserved harbor");
  if (phase !== "draft") { await button("Review change").click(); await expect.element(button("Save rule")).toBeVisible(); }
  if (phase === "uncertain" || phase === "receipt-lost") { s.loseBeforeCommit(); await button("Save rule").click(); await expect.element(button("Check save receipt")).toBeVisible(); }
  if (phase === "receipt-lost") { s.failReceipt(404); await button("Check save receipt").click(); }
  s.failList(503); window.dispatchEvent(new Event("focus")); await expect.poll(() => s.host.textContent).toContain("Trust settings unavailable.");
  expect(s.host.querySelector("pre")).toBeNull();
  s.failList(0); window.dispatchEvent(new Event("focus")); await expect.poll(() => s.host.textContent).not.toContain("Trust settings unavailable.");
  await expect.element(page.getByLabelText("Label", { exact: true })).toHaveValue("Preserved harbor");
  if (phase === "draft" || phase === "review") await expect.element(button(phase === "draft" ? "Review change" : "Save rule")).toBeEnabled();
  else await expect.element(button("Leave as outcome unknown")).toBeEnabled();
});

for (const pending of [false, true]) test(`T19 base refresh discards ${pending ? "late prepared reply" : "prepared review"} and keeps draft`, async ctx => {
  const s = await scene(ctx, 320, "dark", [rule]); await button("Edit https://example.org:443").click();
  await page.getByLabelText("Label", { exact: true }).fill("Preserved harbor");
  if (pending) s.holdPrepare(); await button("Review change").click();
  if (!pending) await expect.element(button("Save rule")).toBeVisible();
  s.setRead({ revision: "2", policyHash: "b".repeat(64) }); window.dispatchEvent(new Event("focus"));
  await expect.element(button("Review change")).toBeEnabled();
  if (pending) { s.releasePrepare(); await expect.poll(() => s.prepareReplies()).toBe(1); await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); }
  await expect.element(button("Save rule")).not.toBeInTheDocument();
  await expect.element(page.getByLabelText("Label", { exact: true })).toHaveValue("Preserved harbor");
  await button("Refresh base").click(); await button("Review change").click(); await expect.element(button("Save rule")).toBeVisible();
});

for (const phase of ["draft", "review"] as const) test(`T20 removal ${phase} remains available after enforcement disappears`, async ctx => {
  const s = await scene(ctx, 320, "dark", [rule]); await button("Remove https://example.org:443").click();
  if (phase === "review") { await button("Review change").click(); await expect.element(button("Remove rule")).toBeVisible(); }
  s.setRead({ capabilities: { originRules: false, recipientRules: false, repositoryRules: false, repositoryIdentity: false, readOnlyReason: "unavailable" } });
  window.dispatchEvent(new Event("focus")); await expect.element(button(phase === "draft" ? "Review change" : "Remove rule")).toBeEnabled();
  if (phase === "draft") await button("Review change").click(); s.unavailableCommit(); await button("Remove rule").click();
  await expect.poll(() => s.host.textContent).toContain("Runtime enforcement unavailable");
  expect(s.host.textContent).toContain("Current rule: removed");
});

for (const phase of ["preparing", "committing"] as const) test(`T21 remount recovers ${phase} without duplicate dispatch`, async ctx => {
  const s = await scene(ctx, 320, "light"); await button("Add origin").click(); await page.getByLabelText("Origin", { exact: true }).fill("https://example.org");
  if (phase === "preparing") s.holdPrepare(); await button("Review change").click();
  if (phase === "committing") { await expect.element(button("Save rule")).toBeVisible(); s.holdCommit(); await button("Save rule").click(); }
  s.draw(null); s.draw(<TrustSettingsSection active />);
  if (phase === "preparing") { s.releasePrepare(); await expect.element(button("Review change")).toBeEnabled(); expect(s.calls.filter(c => c.path.endsWith("/commit"))).toHaveLength(0); }
  else { s.releaseCommit(); await button("Check save receipt").click(); await expect.element(button("Add origin")).toBeEnabled(); expect(s.calls.filter(c => c.path.endsWith("/commit"))).toHaveLength(1); }
});

test("T18 mixed-version observation gaps never rebase a selected rule across revisions", async ctx => {
  const s = await scene(ctx, 320, "light", [rule]); s.setRead({ instances: undefined }); window.dispatchEvent(new Event("focus"));
  await expect.poll(() => s.calls.filter(c => c.path.endsWith("/trust-settings")).length).toBeGreaterThan(1);
  await button("Edit https://example.org:443").click(); s.setRead({ revision: "2" }); await button("Refresh base").click();
  await expect.element(button("Review change")).toBeDisabled();
});

test("T22 pending and failed policy facts never label an old hash as enforcing", async ctx => {
  const s = await scene(ctx, 320, "dark"); await expect.poll(() => s.host.textContent).toContain("Enforcing version: built-in defaults");
  s.holdPolicy(); s.setRead({ policyHash: "b".repeat(64) }); window.dispatchEvent(new Event("focus"));
  await expect.poll(() => s.calls.filter(c => c.path.endsWith("/agent-policy")).length).toBe(2);
  expect(s.host.textContent).not.toContain("Enforcing version: built-in defaults");
  s.failPolicy(503); s.releasePolicy(); await expect.poll(() => s.host.textContent).toContain("Could not read this brain's enforcing policy");
  s.failPolicy(0); window.dispatchEvent(new Event("focus")); await expect.poll(() => s.host.textContent).toContain(`Enforcing version: ${"b".repeat(64)}`);
});

for (const phase of ["preparing", "committing"] as const) test(`T14 unavailable read fences a pending ${phase} reply`, async ctx => {
  const s = await scene(ctx, 320, "light"); await button("Add origin").click(); await page.getByLabelText("Origin", { exact: true }).fill("https://example.org");
  if (phase === "preparing") s.holdPrepare(); await button("Review change").click();
  if (phase === "committing") { await expect.element(button("Save rule")).toBeVisible(); s.holdCommit(); await button("Save rule").click(); }
  s.failList(503); window.dispatchEvent(new Event("focus")); await expect.poll(() => s.host.textContent).toContain("Trust settings unavailable.");
  if (phase === "preparing") s.releasePrepare(); else s.releaseCommit();
  s.failList(0); window.dispatchEvent(new Event("focus")); await expect.poll(() => s.host.textContent).not.toContain("Trust settings unavailable.");
  if (phase === "preparing") { await expect.element(button("Review change")).toBeEnabled(); await expect.element(button("Save rule")).not.toBeInTheDocument(); }
  else { await button("Check save receipt").click(); await expect.element(button("Add origin")).toBeEnabled(); expect(s.calls.filter(c => c.path.endsWith("/commit"))).toHaveLength(1); }
});

for (const pending of ["commit", "receipt"] as const) test(`T23 leave a pending ${pending} as unknown and fence its late reply`, async ctx => {
  const s = await prepared(ctx);
  if (pending === "commit") { s.holdCommit(); await button("Save rule").click(); }
  else { s.loseBeforeCommit(); await button("Save rule").click(); await expect.element(button("Check save receipt")).toBeVisible(); s.holdReceipt(); await button("Check save receipt").click(); }
  await button("Leave as outcome unknown").click();
  if (pending === "commit") s.releaseCommit(); else s.releaseReceipt();
  await expect.element(button("Add origin")).toBeEnabled();
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  expect(s.host.textContent).toContain("outcome remains unknown");
  expect(s.host.textContent).not.toContain("Publication proved");
  expect(s.calls.filter(c => c.path.endsWith("/commit"))).toHaveLength(1);
});

test("T21 a responsive remount restores focus to the retained draft field", async ctx => {
  const s = await scene(ctx, 320, "dark"); await button("Add origin").click();
  await page.getByLabelText("Label", { exact: true }).fill("Preserved harbor");
  (page.getByLabelText("Label", { exact: true }).element() as HTMLElement).focus();
  s.draw(null); s.draw(<TrustSettingsSection active />);
  await expect.element(button("Review change")).toBeEnabled();
  expect(document.activeElement).toBe(page.getByLabelText("Label", { exact: true }).element());
});

test("T21 a retained draft does not steal deliberately moved destination focus", async ctx => {
  const s = await scene(ctx, 320, "dark"); await button("Add origin").click(); await page.getByLabelText("Label", { exact: true }).fill("Preserved harbor");
  const destination = document.createElement("button"); destination.textContent = "Another destination"; document.body.append(destination);
  ctx.onTestFinished(() => destination.remove()); destination.focus();
  s.draw(null); s.draw(<TrustSettingsSection active />);
  await expect.element(button("Review change")).toBeEnabled(); expect(document.activeElement).toBe(destination);
});

test("T12 replacing the brain root exposes no prior-root facts even before passive effects", async ctx => {
  const s = await scene(ctx, 320, "light", [rule]); await button("Edit https://example.org:443").click();
  const other = createBrainUiRoot({ storage: null, request: async url => String(url).endsWith("/agent-policy")
    ? Response.json({ source: "default", hash: null, path: "context/policies/governance.md", errors: [], warnings: [], profiles: { interactive: "governed", voice: "strict" }, protectedPaths: [], workerLimits: null })
    : Response.json({ revision: "0", policyHash: null, error: null, rules: [], origins: [], repositories: [], instances: {}, mutationAllowed: true,
      capabilities: { originRules: true, recipientRules: true, repositoryRules: false, repositoryIdentity: false, readOnlyReason: null } }) });
  ctx.onTestFinished(() => other.dispose()); const commits: string[] = [];
  function Audit({ children }: { children: ReactNode }) { useLayoutEffect(() => { commits.push(s.host.textContent ?? ""); }); return children; }
  s.draw(<BrainUiProvider root={s.ui}><Audit><TrustSettingsSection active /></Audit></BrainUiProvider>);
  await expect.poll(() => s.host.textContent).toContain("Trust revision 0"); commits.length = 0;
  s.draw(<BrainUiProvider root={other}><Audit><TrustSettingsSection active /></Audit></BrainUiProvider>);
  await expect.element(button("Add origin")).toBeEnabled();
  expect(commits.length).toBeGreaterThan(0); expect(commits.every(text => !text.includes("example.org"))).toBe(true);
});

for (const theme of ["dark", "light"]) test(`trust facts in the composed Security pane fit the document at 320 ${theme}`, async ctx => {
  const s = await scene(ctx, 320, theme);
  s.host.style.display = "flex"; s.host.style.flexDirection = "column";
  s.setRead({ policyHash: "a".repeat(64) });
  s.draw(<div style={{ maxWidth: 720, marginInline: "auto", padding: 12 }}><PasskeyList credentials={[]} status="ready" busy={false} error={null} supported={false} hostname="example.org" onAdd={() => {}} onRename={() => {}} onDelete={() => {}} onSignOut={() => {}} sections={<TrustSettingsSection active />} /></div>);
  await expect.element(button("Add origin")).toBeVisible();
  await expect.poll(() => s.host.querySelector("[data-agent-policy]")?.textContent).toContain(`Enforcing version: ${"a".repeat(64)}`);
  expect(document.documentElement.scrollWidth, "Security composition fits the document").toBeLessThanOrEqual(innerWidth);
});
