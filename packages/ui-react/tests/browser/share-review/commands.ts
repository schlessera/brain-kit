/// <reference types="@vitest/browser-playwright" />
import { createServer } from "node:http";
import { resolve } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { build } from "esbuild";
import { strict as assert } from "node:assert";
import type { BrowserCommand } from "vitest/node";
import type { Page } from "playwright";

type Scenario = "reload" | "auth" | "race" | "dismiss" | "confirmed" | "lost-response" | "signout" | "transfer" | "transfer-signout" | "partial" | "ttl";
let bundle: Promise<string> | undefined;
type Original = { id: string; text: string; bytes: number[] };
async function action<T>(page: Page, method: string): Promise<T> {
  return page.evaluate(method => (window as unknown as { shareProof: Record<string, () => unknown> }).shareProof[method]!(), method) as Promise<T>;
}
async function ready(page: Page) { await page.waitForFunction(() => "shareProof" in window); }
async function queue(page: Page) { await page.waitForFunction(() => (window as unknown as { shareProof: { queue(): string[] } }).shareProof.queue().length === 1); }
async function original(page: Page) {
  const originals = await action<Original[]>(page, "inventory");
  assert.equal(originals.length, 1, "one durable original remains before authoritative handoff");
  assert.equal(originals[0]!.text, "Penelope keeps the original loom plan.");
  assert.deepEqual(originals[0]!.bytes, [0, 1, 2, 255, 17], "original file bytes survive native IndexedDB");
}

export const shareReview: BrowserCommand<[Scenario], string> = async (ctx, scenario) => {
  bundle ??= build({ entryPoints: [resolve("../ui-react/tests/browser/share-review/app.tsx")], bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" }).then(result => result.outputFiles[0]!.text);
  const script = await bundle;
  let uploads = 0;
  const contents: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    if (url.pathname === "/app.js") { res.setHeader("content-type", "text/javascript"); res.end(script); return; }
    if (url.pathname.endsWith("/share")) {
      uploads++;
      const chunks: Buffer[] = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {
        contents.push(Buffer.concat(chunks).toString("latin1"));
        if (scenario === "lost-response" && uploads === 1) {
          // Start the response before losing its body. An unopened response on
          // a reused connection can be transparently retried by Chromium.
          res.writeHead(201, { "content-type": "application/json" }); res.write("{");
          setTimeout(() => res.destroy(), 50); return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: "odysseus-intake", receivedAt: Date.now(), dir: ".brain/inbox/odysseus-intake", text: "Penelope keeps the original loom plan.", files: scenario === "partial" ? [] : [{ name: "loom.pdf", path: ".brain/inbox/odysseus-intake/loom.pdf", mediaType: "application/pdf", bytes: 5 }] }));
      });
      return;
    }
    if (url.pathname.startsWith("/api")) { res.setHeader("content-type", "application/json"); res.end("{}"); return; }
    res.setHeader("content-type", "text/html"); res.end('<!doctype html><html><body><div id="app"></div><script src="/app.js"></script></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const context = await ctx.context.browser()!.newContext();
  context.setDefaultTimeout(8000);
  const egress: string[] = [];
  context.on("request", req => { if (new URL(req.url()).origin !== origin) egress.push(req.url()); });
  await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  try {
    const page = await context.newPage();
    await page.goto(origin); await ready(page);
    const landing = await action<string>(page, "stash");
    if (scenario === "transfer" || scenario === "transfer-signout") {
      const faulty = new URL(landing); faulty.searchParams.set("copyFailure", "yes");
      await page.goto(faulty.href); await ready(page); await page.waitForTimeout(1200);
      assert.deepEqual(await action(page, "queue"), [], "failed durable copy never admits memory-only review");
      await original(page);
      assert.equal((await action<{ shares: number }>(page, "loss")).shares, 1, "sign-out inventory includes the interrupted transfer");
      if (scenario === "transfer-signout") {
        await action(page, "clear");
        assert.deepEqual(await action(page, "cleared"), { originals: 0, account: true }, "intentional sign-out removes the transfer remnant as well as account work");
        assert.equal(uploads, 0); assert.deepEqual(egress, []); return "passed";
      }
      const other = await context.newPage(); await other.goto(`${origin}/?account=odysseus-sparta`); await ready(other); await other.waitForTimeout(1200);
      assert.deepEqual(await action(other, "queue"), [], "transfer journal prevents cross-account adoption after a failed copy");
      await other.close(); await page.goto(landing); await ready(page); await queue(page); await original(page);
      assert.equal(uploads, 0); assert.deepEqual(egress, [], "fixture has no external egress"); return "passed";
    }
    await page.goto(landing); await ready(page); await queue(page);
    await original(page);
    assert.equal(uploads, 0, "review admission never uploads before consent");
    assert.equal(await action(page, "chats"), 0, "review admission never starts chat before consent");
    if (scenario === "reload") {
      await page.reload(); await ready(page); await queue(page); await original(page);
      assert.equal(uploads, 0, "reload does not imply consent");
    } else if (scenario === "auth") {
      await action(page, "expire");
      assert.deepEqual(await action(page, "queue"), [], "auth lock drops the memory payload");
      const other = await context.newPage(); await other.goto(`${origin}/?account=odysseus-sparta`); await ready(other);
      await other.waitForTimeout(1500);
      assert.deepEqual(await action(other, "queue"), [], "another account cannot recover this original");
      assert.deepEqual(await action(other, "inventory"), [], "another account cannot read this original");
      await other.close();
      assert.equal(await action(page, "restore"), true, "real auth lock restores the same account");
      await queue(page); await original(page); assert.equal(uploads, 0);
    } else if (scenario === "race") {
      // Terminate the initial owner; two independent tabs then race recovery.
      await page.close();
      const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
      await Promise.all([first.goto(landing), second.goto(landing)]); await Promise.all([ready(first), ready(second)]);
      await first.waitForTimeout(1500);
      const counts = [(await action<string[]>(first, "queue")).length, (await action<string[]>(second, "queue")).length];
      assert.equal(counts[0]! + counts[1]!, 1, "native lock admits exactly one racing tab");
      const owner = counts[0] ? first : second; const survivor = counts[0] ? second : first;
      await owner.close(); await queue(survivor); await original(survivor);
      assert.equal(uploads, 0, "abandonment does not grant consent");
    } else if (scenario === "dismiss") {
      await action(page, "dismiss"); await page.waitForTimeout(100);
      assert.deepEqual(await action(page, "inventory"), [], "dismiss commits durable cleanup");
      await page.reload(); await ready(page); await page.waitForTimeout(1200);
      assert.deepEqual(await action(page, "queue"), []); assert.equal(uploads, 0);
    } else if (scenario === "signout") {
      assert.equal((await action<{ shares: number }>(page, "loss")).shares, 1, "sign-out warns about the retained original");
      await page.setViewportSize({ width: 320, height: 800 });
      await page.addStyleTag({ content: await readFile(resolve("../ui-react/dist/styles.css"), "utf8") });
      await page.getByRole("button", { name: "Sign out everywhere", exact: true }).click();
      await page.getByText("1 shared item kept on this device", { exact: true }).waitFor();
      const dialog = page.getByRole("dialog", { name: "Sign out of Brain?" });
      assert.equal(await dialog.evaluate(el => el.getBoundingClientRect().width <= 320 && el.scrollWidth <= el.clientWidth), true, "share loss warning fits at 320px");
      await page.addScriptTag({ content: await readFile(resolve("../../node_modules/axe-core/axe.min.js"), "utf8") });
      const violations = await page.evaluate(async () => (await (window as unknown as { axe: typeof import("axe-core") }).axe.run(document.querySelector("[data-local-work-dialog]")!, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } })).violations.map(v => v.id));
      assert.deepEqual(violations, [], "share loss warning remains accessible");
      await mkdir(resolve("../../tmp/share-review"), { recursive: true });
      await dialog.screenshot({ path: resolve("../../tmp/share-review/signout-320.png") });
      await page.getByRole("button", { name: "Keep working", exact: true }).click();
      await original(page);
      await action(page, "clear"); await page.close();
      const fresh = await context.newPage(); await fresh.goto(origin); await ready(fresh); await fresh.waitForTimeout(1200);
      assert.deepEqual(await action(fresh, "queue"), [], "account sign-out clear removes retained shares");
      assert.equal(uploads, 0);
    } else if (scenario === "ttl") {
      await action(page, "expireRecord"); await page.reload(); await ready(page); await page.waitForTimeout(1200);
      assert.deepEqual(await action(page, "queue"), [], "expired account reviews are not admitted");
      assert.deepEqual(await action(page, "inventory"), [], "existing TTL bounds retained originals");
      assert.equal(uploads, 0);
    } else if (scenario === "partial") {
      await action(page, "resume"); await action(page, "confirm");
      assert.equal(uploads, 1); await original(page);
      assert.equal(await action(page, "chats"), 0, "incomplete receipt never hands off or starts chat");
      await action(page, "dismiss"); await page.waitForTimeout(100);
      assert.deepEqual(await action(page, "inventory"), []);
    } else {
      if (scenario === "lost-response") await action(page, "resume");
      await action(page, "confirm");
      await original(page);
      assert.equal(uploads, scenario === "lost-response" ? 1 : 0, JSON.stringify(await action(page, "status")));
      await page.reload(); await ready(page); await queue(page); await original(page);
      await action(page, "resume");
      await page.waitForFunction(() => (window as unknown as { shareProof: { queue(): string[] } }).shareProof.queue().length === 0).catch(async error => { throw new Error(`${error}: ${JSON.stringify(await action(page, "status"))}`); });
      assert.deepEqual(await action(page, "inventory"), [], "successful server intake is the authoritative handoff");
      assert.equal(uploads, scenario === "lost-response" ? 2 : 1, "only previously confirmed work resumes");
      assert(contents.every(body => body.includes("Penelope keeps the original loom plan.") && body.includes(String.fromCharCode(0, 1, 2, 255, 17))), "upload retries carry the original bytes");
    }
    assert.deepEqual(egress, [], "fixture has no external egress");
    return "passed";
  } finally { await context.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
};
declare module "vitest/browser" { interface BrowserCommands { shareReview(scenario: Scenario): Promise<string> } }
