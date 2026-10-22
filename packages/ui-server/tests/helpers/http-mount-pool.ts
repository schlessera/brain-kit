import { globalAgent } from "node:http";
import type { HttpContractApp } from "./http-contract-app";

/** Join only this fixture's native HTTP sockets; never destroy the global agent. */
export async function closeHttpMountFixture(fixture: HttpContractApp) {
  const key = globalAgent.getName({ socketPath: fixture.app.config.nativeBrain!.socketPath });
  const sockets = [...(globalAgent.sockets[key] ?? []), ...(globalAgent.freeSockets[key] ?? [])];
  const stopped = sockets.filter(socket => !socket.destroyed).map(socket => new Promise<void>(resolve => socket.once("close", () => resolve())));
  const failures: unknown[] = [];
  try { await fixture.close(); } catch (error) { failures.push(error); }
  try {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(stopped),
        new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("HTTP mount fixture native sockets did not close within 5 seconds")), 5_000); }),
      ]);
    } finally { clearTimeout(deadline); }
  } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Mount fixture cleanup failed");
}

/**
 * Only the explicitly audited immutable readers may use this pool. Each call
 * mints its own principal in the caller; no DB rollback or private cache reset.
 * Cap each environment's retained principals/telemetry and destroy on failure.
 * The caller must await close before starting another native app fixture.
 */
export function createHttpMountPool(prepare: () => Promise<HttpContractApp>) {
  let fixture: HttpContractApp | undefined;
  let uses = 0;
  let busy = false;
  async function close() {
    const closing = fixture;
    fixture = undefined;
    uses = 0;
    if (closing) await closeHttpMountFixture(closing);
  }
  return {
    close,
    async run(action: (fixture: HttpContractApp) => Promise<void>) {
      if (busy) throw new Error("Mount readers must run sequentially");
      busy = true;
      try {
        if (uses === 32) await close();
        fixture ??= await prepare();
        uses++;
        await action(fixture);
      } catch (error) {
        // A broken assertion might follow arbitrary mutations. Rebuilding the
        // entire app also discards challenges, caches, timers and native state.
        try { await close(); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], "Mount case and disposal failed"); }
        throw error;
      } finally { busy = false; }
    },
  };
}
