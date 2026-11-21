import { expect, inject, test, vi, type TestContext } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { TrustSettingsSection } from "../../src/components/settings/trust-settings-section.js";
import type { TrustRule, TrustSettingsRead, TrustOperation, TrustChange } from "../../src/lib/trust-settings.js";
import { mount, reach } from "./hit-reach-scene.js";

const button = (name: string | RegExp) => page.getByRole("button", { name, exact: typeof name === "string" });
const rule = { id: "ithaca", label: "Ithaca", incomingContent: true, recipientWhileRestricted: false, selector: { kind: "web_origin", scheme: "https", host: "example.org", port: 443 } } satisfies TrustRule;
async function scene(ctx: TestContext, width: number, theme: string, rules: TrustRule[] = []) {
  let read: TrustSettingsRead = { revision: "0", policyHash: null, error: null, rules, origins: rules.filter(r => !r.selector.kind.startsWith("github_")), repositories: rules.filter(r => r.selector.kind.startsWith("github_")), mutationAllowed: true,
    capabilities: { originRules: true, recipientRules: true, repositoryRules: false, repositoryIdentity: true, readOnlyReason: null } };
  const calls: { path: string; body?: Record<string, unknown> }[] = [];
  let change: TrustChange, operation: TrustOperation, stale = false, loseReply = false;
  let listFailure = 0, commitFailure = 0, expired = false, dropCommit = false, prepareWait: Promise<void> | undefined, listWait: Promise<void> | undefined;
  let releaseList: (() => void) | undefined;
  let releasePrepare: (() => void) | undefined;
  const s = await mount(ctx, width, async (url, init) => {
    const path = new URL(url, location.href).pathname, body = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({ path, body });
    if (path.endsWith("/agent-policy")) return Response.json({ source: "default", hash: null, path: "context/policies/governance.md", errors: [], warnings: [], profiles: { interactive: "governed", voice: "strict" }, protectedPaths: [], workerLimits: null });
    if (path.endsWith("/trust-settings/prepare")) {
      if (stale) return Response.json({ error: "stale_base" }, { status: 409 });
      change = body.change;
      operation = { receipt: { requestId: "ithaca-review", stage: "prepared", publication: "not_published", currentRule: "unknown", enforcement: "unavailable", reason: null },
        review: { reviewId: "ithaca-bytes", reviewedBytesHash: "a".repeat(64), base: null, proposed: JSON.stringify(change), diff: JSON.stringify(change), expiresAt: Date.now() + 60_000, includesFutureRepositories: false }, policy: read, capabilities: read.capabilities };
      if (prepareWait) await prepareWait;
      return Response.json(operation);
    }
    if (path.endsWith("/trust-settings/commit")) {
      if (commitFailure) return Response.json({ reason: "unauthorized" }, { status: commitFailure });
      if (dropCommit) throw new Error("connection ended before commit");
      if (expired) return Response.json({ reason: "request_expired" }, { status: 409 });
      const selected = change;
      read.rules = selected.action === "remove" ? read.rules.filter(r => r.id !== selected.ruleId) : [...read.rules.filter(r => r.id !== selected.rule.id), selected.rule];
      read = { ...read, revision: "1", origins: read.rules.filter(r => !r.selector.kind.startsWith("github_")), repositories: read.rules.filter(r => r.selector.kind.startsWith("github_")) };
      operation = { ...operation, receipt: { ...operation.receipt, stage: "committed", publication: "proved", currentRule: change.action === "remove" ? "removed" : "present", enforcement: "enforced" } };
      if (loseReply) throw new Error("lost reply");
      return Response.json(operation);
    }
    if (path.endsWith("/trust-settings/ithaca-review")) return Response.json(operation);
    if (listWait) await listWait;
    return listFailure ? Response.json({ reason: "read_unavailable" }, { status: listFailure }) : Response.json(read);
  });
  s.ui.stores.connection.getState().setVpnStatus("connected", "odysseus");
  document.documentElement.dataset.theme = theme;
  s.draw(<TrustSettingsSection active />);
  await expect.element(button("Add origin")).toBeVisible();
  return { ...s, calls, setRead(next: Partial<TrustSettingsRead>) { read = { ...read, ...next, ...(next.rules ? { origins: next.rules.filter(r => !r.selector.kind.startsWith("github_")), repositories: next.rules.filter(r => r.selector.kind.startsWith("github_")) } : {}) }; },
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
  test(`trust canonical CRUD, exact review and independent permission at ${width} ${theme}`, async ctx => {
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
    await button("Save rule").click();
    await expect.element(button("Edit https://example.org:443")).toBeVisible();
    expect(s.host.scrollWidth).toBeLessThanOrEqual(width);
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
  test(`trust stale base, remount and lost save never discard or republish at ${width} ${theme}`, async ctx => {
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

test("keyboard review and cancel retain focus without changing the policy", async ctx => {
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

test("F2 owner downgrade removes the private review, including a late prepare reply", async ctx => {
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

test("F3 elapsed unknown publication remains uncertain after receipt expiry", async ctx => {
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

for (const status of [403, 503]) test(`F5 failed ${status} refresh disables cached authority and successful reads clear its error`, async ctx => {
  const s = await prepared(ctx); s.failList(status); window.dispatchEvent(new Event("focus"));
  await expect.element(page.getByRole("alert")).toBeVisible();
  await expect.poll(() => button("Save rule").elements().every(node => node.getAttribute("aria-disabled") === "true")).toBe(true);
  expect(s.host.querySelector("pre")).toBeNull();
  s.failList(0); window.dispatchEvent(new Event("focus"));
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  await expect.element(page.getByLabelText("Origin", { exact: true })).toHaveValue("https://example.org");
});

test("F3 locally expired unsent review returns to the draft without dispatch", async ctx => {
  const s = await prepared(ctx); vi.setSystemTime(Date.now() + 900_001);
  await button("Save rule").click(); await expect.element(button("Review change")).toBeEnabled();
  expect(s.calls.filter(c => c.path.endsWith("/commit"))).toHaveLength(0);
});

test("F3 expired prepared receipt proves an interrupted commit can leave review", async ctx => {
  const s = await prepared(ctx); s.loseBeforeCommit(); await button("Save rule").click();
  await expect.element(button("Check save receipt")).toBeVisible();
  s.expireHostReview(); await button("Check save receipt").click();
  await expect.element(button("Review change")).toBeEnabled(); await expect.element(button("Cancel")).toBeEnabled();
  expect(s.calls.filter(c => c.path.endsWith("/commit"))).toHaveLength(1);
});

test("F4 even byte-identical ID reuse requires selecting the current rule", async ctx => {
  const s = await scene(ctx, 320, "dark", [rule]);
  await button("Remove https://example.org:443").click(); s.setRead({ revision: "2", rules: [rule] });
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

test("F2 auth loss during a pending list read cannot restore private review or capability", async ctx => {
  const s = await prepared(ctx); s.holdList(); window.dispatchEvent(new Event("focus"));
  await expect.poll(() => s.calls.filter(c => c.path.endsWith("/trust-settings")).length).toBeGreaterThan(1);
  flushSync(() => { void s.ui.authLock.expire("revoked"); }); s.releaseList();
  await expect.poll(() => s.host.querySelectorAll("input, pre").length).toBe(0);
  await expect.element(button("Save rule")).not.toBeInTheDocument();
});

test("F2 a denied owner commit immediately removes private bytes and stale write authority", async ctx => {
  const s = await prepared(ctx); s.rejectCommit(403); await button("Save rule").click();
  await expect.element(button("Review change")).toBeDisabled();
  expect(s.host.querySelector("pre")).toBeNull();
  expect(s.calls.filter(c => c.path.endsWith("/commit"))).toHaveLength(1);
});
