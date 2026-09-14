import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrainRoutes } from "../src/routes/brain";
import type { BrainClient } from "../src/brain/client";
import type { KeytermSettings } from "../src/voice/keyterm-builder";

async function until(check: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Child did not reach expected state");
    await Bun.sleep(10);
  }
}

describe("sync reservation", () => {
  test("reserves canonical roots across routes and disconnects, and releases after exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "sync-reservation-"));
    const link = root + "-link";
    const events = join(root, "events.txt");
    const release = join(root, "release");
    const script = join(root, "sync.ts");
    writeFileSync(script, `import { appendFileSync, existsSync } from 'node:fs';
      appendFileSync(${JSON.stringify(events)}, 'start\\n'); console.log('working');
      while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(10);
      appendFileSync(${JSON.stringify(events)}, 'end\\n'); process.exit(1);`);
    symlinkSync(root, link);
    const route = (brainPath: string) => createBrainRoutes({
      brainPath, brain: { cliCommand: () => [process.execPath, script] } as BrainClient,
      keyterms: { brainPath } as KeytermSettings,
    });
    const first = route(root);
    const second = route(link);
    try {
      const response = await first.request("/brain/sync", { method: "POST" });
      await until(() => existsSync(events));
      const busy = await second.request("/brain/sync", { method: "POST" });
      expect(busy.status).toBe(409);
      expect((await busy.json()).error).toContain("already running");
      await response.body!.cancel();
      expect((await second.request("/brain/sync", { method: "POST" })).status).toBe(409);
      writeFileSync(release, "go");
      await until(() => readFileSync(events, "utf8").includes("end"));
      // Wait for the server to observe the process exit, then retry.
      let retry: Response;
      const deadline = Date.now() + 5_000;
      do {
        await Bun.sleep(10);
        retry = await second.request("/brain/sync", { method: "POST" });
      } while (retry.status === 409 && Date.now() < deadline);
      expect(retry.status).toBe(200);
      expect(await retry.text()).toContain('"success":false');
      expect(readFileSync(events, "utf8").match(/start/g)).toHaveLength(2);
    } finally {
      writeFileSync(release, "go");
      await Bun.sleep(50);
      rmSync(link, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("startup failure releases the reservation for a retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "sync-startup-"));
    let calls = 0;
    const app = createBrainRoutes({ brainPath: root, brain: { cliCommand() { calls++; throw new Error("fixture startup failure"); } } as unknown as BrainClient, keyterms: { brainPath: root } as KeytermSettings });
    try {
      for (let i = 0; i < 2; i++) {
        const response = await app.request("/brain/sync", { method: "POST" });
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("fixture startup failure");
      }
      expect(calls).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
