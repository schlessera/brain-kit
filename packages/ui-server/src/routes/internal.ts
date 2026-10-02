import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, fchmodSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { BlockList, isIP } from "node:net";
import { Hono } from "hono";
import { clientIp } from "../middleware/tailscale.js";
import type { createInboxRuntime } from "../inbox/runtime.js";

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

/** Mint once per app boot. The host provisions the containing runtime directory. */
export function createInboxPokeAuth(tokenFile: string | null) {
  if (tokenFile === null) return null;
  if (!isAbsolute(tokenFile)) throw new Error("BRAIN_UI_INBOX_POKE_TOKEN_FILE must be an absolute runtime file path");
  const token = randomBytes(32).toString("hex");
  const temporary = join(dirname(tokenFile), `.inbox-poke-${randomBytes(16).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, token + "\n");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, tokenFile);
  } catch {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* no temporary file was created */ }
    throw new Error("Unable to write the inbox poke runtime token file");
  }
  return {
    accepts(header: string | undefined): boolean {
      const supplied = /^Bearer ([0-9a-f]{64})$/.exec(header ?? "")?.[1];
      return supplied !== undefined && timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(token, "hex"));
    },
  };
}

export function createInternalRoutes(deps: {
  auth: ReturnType<typeof createInboxPokeAuth>;
  runtime: ReturnType<typeof createInboxRuntime>;
}) {
  const app = new Hono();
  app.post("/internal/inbox/poke", async (c) => {
    if (!deps.auth) return c.json({ error: "inbox_poke_unconfigured" }, 503);
    const address = clientIp(c, false); // Always the actual socket, even with TRUST_PROXY.
    const family = isIP(address);
    const local = family !== 0 && loopback.check(address, family === 4 ? "ipv4" : "ipv6");
    if (!deps.auth.accepts(c.req.header("authorization")) || !local) {
      return c.json({ error: "inbox_poke_forbidden" }, 403);
    }
    try {
      const { closed, failed, ...result } = await deps.runtime.poke();
      if (closed) return c.json({ error: "inbox_runtime_closed" }, 503);
      if (failed) return c.json({ error: "inbox_drain_failed" }, 503);
      return c.json({ ok: true, ...result });
    } catch {
      return c.json({ error: "inbox_drain_failed" }, 503);
    }
  });
  app.all("/internal/inbox/poke", (c) => c.json({ error: "method_not_allowed" }, 405, { Allow: "POST" }));
  return app;
}
