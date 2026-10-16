/** Real Storage HTTP, filesystem, writer gate and journal. The copied native
 * fixture proves UI/owner integration; it does not qualify a Btrfs host. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv } from "../../../ui-server/src/app-env.js";
import { storageRemovalFixture } from "../../../ui-server/tests/helpers/storage-removal-fixture.js";
import { testPrincipal } from "../../../ui-server/tests/helpers/principal.js";
import { createStorageRoutes } from "../../../ui-server/src/routes/storage.js";
import { createStorageRemovalRoutes } from "../../../ui-server/src/routes/storage-removal.js";
const fixture = storageRemovalFixture(),
  target = join(fixture.brain, "attachments/chart.pdf"),
  original = Buffer.alloc(5_100_000, 65);
original.set([37, 80, 68, 70, 0, 255, 13, 10]);
writeFileSync(target, original);
const digest = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex"),
  originalHash = digest(original);
fixture.storage.start("odysseus");
await fixture.storage.idle();
let drop = false,
  confirms = 0;
const app = new Hono<AppEnv>();
app.use("*", cors({ origin: (origin) => origin, credentials: true }));
app.use("*", async (c, next) => {
  c.set("principal", testPrincipal("odysseus"));
  const confirmation =
    c.req.path === "/api/storage/removals" && c.req.method === "POST";
  if (confirmation) confirms++;
  await next();
  if (confirmation && drop) {
    drop = false;
    await fixture.removal.idle();
    c.res = Response.json(
      { error: "Synthetic response loss after the real operation" },
      { status: 503 }
    );
  }
});
app.route("/api", createStorageRoutes(fixture.storage));
app.route("/api", createStorageRemovalRoutes(fixture.removal));
app.get("/api/storage/maintenance", (c) => c.json({ operations: [] }));
app.post("/fixture", async (c) => {
  const patch = await c.req.json();
  if (patch.drop) drop = true;
  if (patch.change)
    writeFileSync(target, Buffer.from("%PDF changed after review\n"));
  if (patch.revoke) fixture.revoke();
  return c.json({
    exists: existsSync(target),
    hash: existsSync(target) ? digest(readFileSync(target)) : null,
    originalHash,
    confirms,
    latest: fixture.removal.capability("odysseus").latest,
  });
});
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}` }));
process.on("SIGTERM", async () => {
  server.stop(true);
  await fixture.close();
  process.exit(0);
});
