/// <reference types="@vitest/browser-playwright" />
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import type { BrowserCommand } from "vitest/node";
import type { HygieneReviewRead, InboxActionItem } from "@schlessera/brain-ui-sdk/protocol";
import { holdCompletionFrames, releaseCompletionFrames, waitForCompletionFrame } from "./hygiene-completion-frame.js";

type Finding = { id: string; category: string; path: string; sources: Array<{source: string}>; fingerprint: string; severity: string; firstSeen: string };
const repo = resolve("../..");
const day = Date.parse("2026-07-12T09:00:00Z");
/** Full-loop command runs inside the pinned, network-disabled browser container. */
export const hygieneLoop: BrowserCommand<[{ width: number }], unknown> = async (ctx, { width }) => {
  const root = mkdtempSync(join(tmpdir(), "hygiene-loop-"));
  let server: ChildProcess | undefined;
  let closing = false, crashing = false;
  const pending = new Set<Promise<void>>();
  const diagnostics: string[] = [];
  const context = await ctx.context.browser()!.newContext({ viewport: { width, height: 1000 }, reducedMotion: "reduce", hasTouch: width === 320 });
  context.setDefaultTimeout(5000);
  const clock = (at: number) => writeFileSync(join(root, "clock.txt"), String(at));
  const write = (path: string, bytes: string) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), bytes);
    utimesSync(join(root, path), new Date(day), new Date(day));
  };
  const bytes = (path: string) => readFileSync(join(root, path), "utf8");
  const doc = (title: string, body: string, extra = "") => `---\ntitle: ${title}\ntype: note\ncreated: 2026-07-12\nupdated: 2026-07-12\ntags: [voyage]\n${extra}---\n# The voyage\n${body}\n`;
  const argv = () => existsSync(join(root, "argv.jsonl")) ? bytes("argv.jsonl").trim().split("\n").map(s => JSON.parse(s) as string[]) : [];
  const applies = () => argv().filter(a => a.includes("resolve") && !a.includes("--dry-run"));
  let heldActionId: string | undefined;
  const decisions: Array<{ page: Page; forward: () => void }> = [];
  async function routeDecisions(page: Page) {
    await page.routeWebSocket(url.replace("http:", "ws:") + "/ws", socket => {
      const server = socket.connectToServer();
      socket.onMessage(raw => {
        const message = JSON.parse(String(raw));
        // Keep replication live. Only the two confirmed responses for this
        // Action wait until both native clicks finish, as in #1556's fixture.
        if (message.type === "inbox_resolve" && message.itemId === heldActionId) {
          decisions.push({ page, forward: () => server.send(raw) });
        } else server.send(raw);
      });
    });
  }
  async function cli(args: string[], expected = 0) {
    const child = spawn(process.env.BUN_BIN ?? "bun", ["--preload", join(repo, "scripts/test-network-child-preload.ts"), join(root, "scripts/brain-cli.ts"), ...args], { cwd: root, env: process.env });
    let out = "", err = "";
    child.stdout!.on("data", b => { out += String(b); }); child.stderr!.on("data", b => { err += String(b); });
    const [code, signal] = await once(child, "exit");
    assert.equal(code, expected, `real CLI ${args.join(" ")} exit: ${err}`); assert.equal(signal, null);
    return JSON.parse(out);
  }
  async function boot(port = 0) {
    server = spawn(process.env.BUN_BIN ?? "bun", ["--preload", join(repo, "scripts/test-network-child-preload.ts"), join(repo, "packages/ui-react/tests/fixtures/hygiene-loop-server.ts"), root, String(port)], { cwd: repo, env: process.env });
    let out = "", err = "";
    server.stderr!.on("data", b => { err += String(b); diagnostics.push(String(b)); });
    return await new Promise<string>((res, reject) => {
      const timer = setTimeout(() => reject(new Error(`server boot timeout: ${err}`)), 15000);
      server!.once("error", e => { clearTimeout(timer); reject(e); });
      server!.once("exit", (code, signal) => { clearTimeout(timer); reject(new Error(`server exited ${code}/${signal}: ${err}`)); });
      server!.stdout!.on("data", b => { out += String(b); if (out.includes("\n")) { clearTimeout(timer); res(JSON.parse(out.split("\n")[0]).url); } });
    });
  }
  async function stop(crash = false) {
    if (!server || server.exitCode !== null || server.signalCode !== null) return;
    crashing = crash;
    const ended = once(server, "exit"); server.kill(crash ? "SIGKILL" : "SIGTERM");
    const [code, signal] = await ended;
    assert.equal(code, crash ? null : 0, "server cleanup exit"); assert.equal(signal, crash ? "SIGKILL" : null);
    server = undefined;
  }
  async function poll<T>(read: () => T | Promise<T>, check: (v: T) => boolean, message: string): Promise<T> {
    let value!: T;
    for (let i = 0; i < 250; i++) { value = await read(); if (check(value)) return value; await new Promise(r => setTimeout(r, 20)); }
    assert.fail(`${message}: ${JSON.stringify(value)}`);
  }
  let url = "";
  const state = async () => (await (await fetch(`${url}/fixture`)).json()) as {read: HygieneReviewRead; items: InboxActionItem[]};
  const active = async () => (await state()).read.action!;
  const card = (page: Page) => page.locator("[data-hygiene-detail] [data-hygiene-id]").or(page.locator("[data-hygiene-id]")).last();
  async function show(page: Page) {
    const item = await poll(active, Boolean, "server selects pending Action");
    await poll(() => page.locator(`[data-hygiene-id="${item.id}"]`).count(), n => n > 0, "browser receives selected Action");
    const open = page.getByRole("button", { name: /^Open finding:/ });
    if (width >= 900) {
      // Entry follows the visible replicated-Action control, including the
      // legitimate waiting state introduced by #1547.
      await open.last().waitFor({ state: "visible" });
      await open.last().click();
      // REST can publish the compact card before the reconnect snapshot reaches
      // the inbox store used by the detail pane. Observe the same Action there
      // before reading its evidence or operating its controls.
      await page.locator(`[data-hygiene-detail] [data-hygiene-id="${item.id}"]`).waitFor({ state: "visible" });
    }
    return item;
  }
  async function choose(page: Page) {
    await page.getByRole("radio", { name: "Keep the text, remove the link", exact: true }).check();
  }
  async function apply(page: Page) {
    const button = page.getByRole("button", { name: "Apply fix", exact: true });
    await poll(() => button.getAttribute("aria-disabled"), v => v !== "true", "confirmed preview enables Apply");
    await button.click();
  }
  async function outcome(status: string) {
    return await poll(active, a => a?.hygiene?.outcome?.status === status, `outcome ${status}`);
  }
  async function advance(id: string) {
    // A cleared pointer precedes the server's asynchronous next selection.
    // Observe its settled next Action or completion before editing the fixture
    // and running another real CLI reconciliation.
    await poll(state, s => s.read.review.pendingActionId !== id && (Boolean(s.read.action) || s.read.review.status === "complete"), "confirmed disposition advances once");
  }
  async function dismiss(page: Page) {
    const item = await show(page);
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    await page.getByRole("button", { name: "Confirm dismiss finding", exact: true }).click();
    await advance(item.id);
    return item;
  }
  try {
    // Keep the fixture-owned clocked CLI selected: a whole node_modules link
    // exposes .bin/brain, which the real server client prefers over scripts.
    mkdirSync(join(root, "node_modules"));
    symlinkSync(join(repo, "node_modules/@schlessera"), join(root, "node_modules/@schlessera"));
    write("scripts/brain-cli.ts", `import ${JSON.stringify(join(repo, "packages/ui-react/tests/fixtures/hygiene-loop-cli.ts"))};\n`);
    write("brain.config.ts", 'export default { taxonomy: { types: { note: { dir: "journeys", orphanExempt: true, staleDays: 10000 } } } };\n');
    const fieldPath = "journeys/a-field.md";
    const main = "journeys/return-to-ithaca.md", validation = "journeys/z-validation.md", changed = "journeys/circe.md";
    const original = doc("Return to Ithaca", "Odysseus sees [[Eumaeus hut]].").replace("created: 2026-07-12\n", "");
    write(main, original);
    const fieldOriginal = doc("Return to Ithaca", "Odysseus plans the voyage.").replace("title: Return to Ithaca\n", "");
    write(fieldPath, fieldOriginal);
    clock(day - 2 * 86400000);
    await cli(["hygiene", "reconcile", "--json"]);
    write(validation, doc("Telemachus returns", "Telemachus waits.").replace("title: Telemachus returns\n", ""));
    write(changed, doc("Circe palace", "Odysseus sees [[Circe hall|the hall]]."));
    write("journeys/aeolus.md", doc("Aeolus island", "Odysseus sees [[Aeolus harbor]]."));
    write("journeys/calypso.md", doc("Ogygia", "Odysseus sees [[Calypso cave]]."));
    write("journeys/review.md", doc("Oar inventory", "Eumaeus counts the oars.", "next_review: 2026-07-01\n"));
    // Seed the established integration corpus's actual informational note.
    write("journeys/water.md", readFileSync(join(repo, "packages/core/fixtures/corpus/notes/quick-note-water.md"), "utf8").replace("[[materials]]", "materials").replace("updated: 2026-07-02", "updated: 2026-07-12").replace("tags: [note, voyage, water]", "tags: [voyage, water]"));
    clock(day - 86400000);
    const detected = (await cli(["hygiene", "reconcile", "--json"])).detected as Finding[];
    assert.equal(detected.filter(f => f.category === "broken-link" && f.path === main).length, 1, "canonical dedupe: one broken-link finding from two sources");
    const broken = detected.find(f => f.category === "broken-link" && f.path === main)!;
    assert.deepEqual(broken.sources.map(s => s.source), ["audit", "validation"], "validation provenance survives the join");
    assert.equal(detected.filter(f => f.category === "required-field" && f.path === main).length, 1, "distinct missing field on the same path");
    for (const [path, until] of [["journeys/aeolus.md", "2026-07-12T08:00:00Z"], ["journeys/calypso.md", "2026-07-13T08:00:00Z"]]) {
      const f = detected.find(f => f.path === path && f.category === "broken-link")!;
      await cli(["hygiene", "snooze", f.id, "--expect-fingerprint", f.fingerprint, "--until", until, "--json"]);
    }
    clock(day);
    url = await boot();
    const origin = new URL(ctx.page.url()).origin;
    await context.grantPermissions(["local-network-access"], { origin });
    await context.route("**/*", async route => {
      const task = (async () => {
      try {
      const req = route.request(), u = new URL(req.url());
      if (u.origin !== origin) { await route.abort(); return; }
      if (u.pathname === "/c6-loop") {
        await route.fulfill({ contentType: "text/html", body: `<html data-theme="dark"><body style="margin:0"><div id="scene" class="bg-background text-foreground" style="height:100vh;display:flex"></div><script>window.__c5Url=${JSON.stringify(url)}</script><script type="module" src="/@fs${join(repo, "packages/ui-react/tests/browser/hygiene-reload-scene.tsx")}"></script></body></html>` }); return;
      }
      if (u.pathname.startsWith("/api/hygiene/")) {
        const r = await fetch(`${url}${u.pathname}`, { method: req.method(), headers: { "content-type": "application/json" }, ...(req.postData() ? { body: req.postData()! } : {}) });
        await route.fulfill({ status: r.status, contentType: "application/json", body: await r.text() }); return;
      }
      await route.continue();
      } catch (error) {
        if (!closing && !crashing) diagnostics.push(String(error));
        await route.abort().catch(() => {});
      }
      })();
      pending.add(task);
      try { await task; } finally { pending.delete(task); }
    });
    context.on("page", p => p.on("pageerror", e => diagnostics.push(e.message)));
    const a = await context.newPage(); await routeDecisions(a); await a.goto(`${origin}/c6-loop`);
    await a.getByRole("tab", { name: /^needs you / }).click();
    await a.getByRole("button", { name: "Start hygiene review", exact: true }).click();
    const field = await show(a);
    assert.equal(field.hygiene?.finding.path, fieldPath, "oldest error selected before younger error and warnings");
    assert.equal(field.hygiene?.finding.category, "required-field");
    const first = (await state()).read;
    assert.equal(first.review.counts?.snoozed, 1, "not-due snooze excluded; due snooze returns");
    assert.ok(detected.some(f => f.category === "todo" && f.severity === "info"), "nonempty informational TODO from the core corpus");
    assert.equal(first.review.counts?.informationalNotShown, 2, "informational findings are counted without blocking cards");
    assert.equal(field.hygiene?.finding.priorityReason && (field.hygiene.finding.priorityReason as {tieBreak: string}).tieBreak, "age");
    const input = a.getByRole("textbox", { name: "title (text)" });
    await input.fill("Return to Ithaca");
    assert.equal(await input.evaluate(el => document.activeElement === el), true, "typing retains focus");
    await a.keyboard.type("a"); assert.equal(applies().length, 0, "typing cannot invoke Apply shortcut");
    await input.fill("Return to Ithaca"); await a.getByRole("button", { name: "Check preview", exact: true }).click();
    await apply(a); await advance(field.id);
    assert.equal(bytes(fieldPath), fieldOriginal.replace("tags: [voyage]\n", 'tags: [voyage]\ntitle: "Return to Ithaca"\n'), "field fix preserves every other byte");
    const dismissedError = await dismiss(a);
    assert.equal(dismissedError.hygiene?.finding.path, validation);
    write(validation, bytes(validation).replace("# The voyage", "# Telemachus returns"));
    await cli(["hygiene", "reconcile", "--json"]);
    const preserved = (await cli(["hygiene", "list", "--json"])).entries;
    assert.equal(preserved.find((v: Finding) => v.id === dismissedError.hygiene!.findingId).state, "dismissed", "unrelated heading edit preserves dismissed validation finding");
    const validationResult = await cli(["validate", "--json"], 1);
    assert.ok(JSON.stringify(validationResult).includes(validation), "dismissed validation error still fails real validate");
    const link = await show(a);
    assert.equal(link.hygiene?.findingId, broken.id, "older warning precedes equal-age warning pair");
    assert.ok((await card(a).innerText()).includes("hygiene + validation · same finding"), "browser card retains both sources");
    await a.getByRole("button", { name: "Pause", exact: true }).click();
    await a.getByText("Hygiene review paused", { exact: true }).waitFor();
    await a.reload(); await a.getByText("Hygiene review paused", { exact: true }).waitFor();
    assert.equal((await active()).id, link.id, "reload retains the paused Action");
    await a.getByRole("button", { name: "Resume hygiene review", exact: true }).click(); await show(a);
    await a.evaluate(() => (window as unknown as {__c5Reconnect(): void}).__c5Reconnect());
    await show(a); assert.equal((await active()).id, link.id, "reconnect/resume retains the same Action");
    await choose(a);
    const beforeStale = bytes(main); write(main, beforeStale.replace("[[Eumaeus hut]]", "[[Eumaeus hut|his hut]]"));
    const edited = bytes(main); await apply(a); await outcome("stale");
    assert.equal(bytes(main), edited, "stale premise writes no bytes"); assert.equal((await active()).id, link.id, "stale premise cannot advance");
    await a.getByRole("button", { name: "Refresh finding", exact: true }).click();
    await poll(active, v => v.id !== link.id, "Refresh supersedes stale Action");
    const refreshed = await show(a); await choose(a);
    // Independent title removal does not alter this link's premise, but actual
    // file validation must fail after its bounded write. This is no canned fault.
    write(main, bytes(main).replace("title: Return to Ithaca\n", "")); const beforeFailure = bytes(main);
    await apply(a);
    await poll(state, s => s.items.find(v => v.id === refreshed.id)?.hygiene?.outcome?.status === "check_failed", "real post-check records check_failed on the original Action");
    assert.equal((await state()).read.review.pendingActionId, refreshed.id, "check_failed retains the pending Action and does not advance");
    assert.equal(bytes(main), beforeFailure.replace("[[Eumaeus hut|his hut]]", "his hut"), "failed post-check retains the applied bytes");
    await a.getByRole("button", { name: "Undo change", exact: true }).click();
    assert.equal(bytes(main), beforeFailure.replace("[[Eumaeus hut|his hut]]", "his hut"), "inverse preview never writes");
    await a.getByRole("button", { name: "Confirm undo", exact: true }).click(); await outcome("undone");
    assert.equal(bytes(main), beforeFailure, "confirmed Undo restores exact original bytes");
    write(main, beforeFailure.replace("type: note\n", "title: Return to Ithaca\ntype: note\ncreated: 2026-07-12\n"));
    await choose(a); await a.getByRole("button", { name: "Check preview", exact: true }).click();
    const b = await context.newPage(); await routeDecisions(b); await b.goto(`${origin}/c6-loop`); await show(b); await choose(b);
    assert.equal((await active()).id, refreshed.id, "both devices answer one durable Action");
    const priorWrites = applies().length;
    heldActionId = refreshed.id;
    await apply(a); await poll(() => decisions.filter(d => d.page === a).length, n => n === 1, "first native confirmation sends one response");
    await apply(b); await poll(() => decisions.filter(d => d.page === b).length, n => n === 1, "second native confirmation sends one response");
    assert.deepEqual(decisions.map(d => d.page === a ? "first" : "second"), ["first", "second"], "both native confirmations precede response forwarding");
    assert.equal(applies().length, priorWrites, "held confirmations cannot write before forwarding");
    heldActionId = undefined;
    for (const decision of decisions) decision.forward();
    await advance(refreshed.id);
    assert.equal(applies().length - priorWrites, 1, "two devices cause exactly one CLI write");
    assert.equal(bytes(main), beforeFailure.replace("type: note\n", "title: Return to Ithaca\ntype: note\ncreated: 2026-07-12\n").replace("[[Eumaeus hut|his hut]]", "his hut"), "choice fix leaves exactly the confirmed bytes");
    // The remaining warning pair has equal rank and age; compare published IDs
    // independently, then observe each browser card in that order.
    const pair = detected.filter(f => [changed, "journeys/aeolus.md"].includes(f.path) && f.category === "broken-link").sort((x,y) => x.id < y.id ? -1 : 1);
    assert.equal(pair.length, 2);
    let dismissedLink!: InboxActionItem;
    const visited: string[] = [];
    for (const f of pair) {
      const item = await show(a); visited.push(item.hygiene!.findingId);
      assert.equal(item.hygiene!.findingId, f.id, "equal-priority equal-age pair uses stable ID order");
      if (f.path === changed) dismissedLink = await dismiss(a);
      else {
        await choose(a); write("crash.txt", "armed"); const beforeCrash = bytes(f.path), beforeWrites = applies().length;
        await apply(a);
        await poll(() => existsSync(join(root, "written.flag")), Boolean, "crash point after CLI publication before recording outcome");
        assert.equal(bytes(f.path), beforeCrash.replace("[[Aeolus harbor]]", "Aeolus harbor"));
        await stop(true); rmSync(join(root, "crash.txt"));
        const port = Number(new URL(url).port); url = await boot(port); crashing = false;
        assert.equal(applies().length - beforeWrites, 1, "restart recovery never replays resolve");
        assert.equal(bytes(f.path), beforeCrash.replace("[[Aeolus harbor]]", "Aeolus harbor"), "recovery preserves confirmed bytes");
        assert.equal((await state()).items.find(v => v.id === item.id)?.status, "resolved", "recovery records the interrupted fix");
        await a.reload();
      }
    }
    const manual = await show(a); assert.equal(manual.hygiene!.finding.category, "review-overdue");
    await a.getByRole("button", { name: "Done, check again", exact: true }).click(); await outcome("still_detected");
    assert.equal((await active()).id, manual.id, "manual check does not acknowledge a still-detected warning");
    // Recovery killed the second device's socket too. Reload, then explicitly
    // resume the same pending Action so its local focus handoff is exercised.
    await b.reload();
    await b.getByRole("button", { name: "Pause", exact: true }).click();
    await b.getByText("Hygiene review paused", { exact: true }).waitFor();
    await b.getByRole("button", { name: "Resume hygiene review", exact: true }).click();
    await show(b);
    assert.equal((await active()).id, manual.id, "second-device resume retains the pending Action");
    // Completion focus must respect an editable target, including one entered
    // after the heading mounts but before its scheduled frame executes.
    await holdCompletionFrames(a);
    await holdCompletionFrames(b);
    await a.getByRole("button", { name: "Later ▾", exact: true }).click();
    await a.getByRole("button", { name: "Snooze until the next scheduled time", exact: true }).click(); await advance(manual.id);
    await poll(state, s => s.read.review.status === "complete", "real CLI selection completes server review");
    try { await a.getByText("Review complete", { exact: true }).waitFor(); }
    catch {
      const completed = (await state()).read;
      await a.screenshot({ path: join(tmpdir(), `c6-stalled-${width}.png`) });
      await a.reload(); await a.getByRole("tab", { name: /^needs you / }).click();
      await a.getByText("Review complete", { exact: true }).waitFor();
      assert.fail(`server complete but browser remains active until reload: ${JSON.stringify(completed.review)}`);
    }
    await b.getByText("Review complete", { exact: true }).waitFor();
    await waitForCompletionFrame(a);
    await waitForCompletionFrame(b);
    assert.equal(await a.getByText("Review complete", { exact: true }).evaluate(el => document.activeElement === el), false, "visible completion precedes its held focus frame");
    await b.evaluate(() => {
      const input = document.createElement("input");
      input.id = "completion-typing";
      document.body.append(input);
      input.focus();
      input.value = "Odysseus";
    });
    await releaseCompletionFrames(a);
    await releaseCompletionFrames(b);
    assert.equal(await a.getByText("Review complete", { exact: true }).evaluate(el => document.activeElement === el), true, "completion receives keyboard focus");
    assert.equal(await b.evaluate(() => document.activeElement?.id), "completion-typing", "completion preserves editable focus at frame execution");
    await b.close();
    assert.equal((await state()).read.review.status, "complete");
    assert.equal((await state()).read.review.fixed, 3); assert.equal((await state()).read.review.dismissed, 2); assert.equal((await state()).read.review.snoozed, 1);
    await a.screenshot({ path: join(tmpdir(), `c6-complete-${width}.png`) });
    // Restart reconciliation after a relevant token change and an unrelated
    // heading edit. The first dismissal returns with receipt; the other holds.
    write(changed, bytes(changed).replace("|the hall", "|her hall"));
    write(validation, bytes(validation).replace("# Telemachus returns", "# Telemachus plans the return"));
    await cli(["hygiene", "reconcile", "--json"]);
    await stop(); url = await boot(Number(new URL(url).port)); await a.reload();
    await a.getByRole("tab", { name: /^needs you / }).click();
    await a.getByRole("button", { name: "Start hygiene review", exact: true }).click();
    const invalidated = await show(a);
    assert.equal(invalidated.hygiene!.findingId, dismissedLink.hygiene!.findingId, "relevant evidence change returns dismissed finding");
    assert.deepEqual(invalidated.hygiene!.finding.invalidation && (invalidated.hygiene!.finding.invalidation as {changed: string[]}).changed, ["tokens"], "invalidation receipt names changed token evidence");
    assert.ok((await card(a).innerText()).includes("Evidence changed since you dismissed"), "browser displays invalidation receipt");
    const entries = (await cli(["hygiene", "list", "--json"])).entries;
    assert.equal(entries.find((v: Finding) => v.id === dismissedError.hygiene!.findingId).state, "dismissed", "unrelated heading edit preserves a different dismissal");
    assert.equal(entries.find((v: Finding) => v.path === "journeys/calypso.md").state, "snoozed", "unchanged not-due snooze survives reconciliation and restart");
    await a.screenshot({ path: join(tmpdir(), `c6-invalidation-${width}.png`) });
    assert.deepEqual(diagnostics, [], "native browser has no runtime errors");
    return { width, fixed: 3, dismissed: 2, snoozed: 1, pair: visited, recoveryWrites: 1, invalidation: ["tokens"] };
  } catch (error) {
    diagnostics.push(JSON.stringify(argv().slice(-6)));
    for (const p of context.pages()) diagnostics.push((await p.locator("body").innerText()).slice(-2500));
    throw new Error(`${String(error)}\n${diagnostics.join("\n")}`);
  } finally {
    closing = true; await context.close(); await Promise.all([...pending]); await stop(); rmSync(root, { recursive: true, force: true });
  }
};
declare module "vitest/browser" {
  interface BrowserCommands { hygieneLoop: (op: { width: number }) => Promise<unknown>; }
}
