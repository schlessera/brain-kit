/** Previous HTTP status fields remain compatible with the optional state proof. */
import { expect, test } from "bun:test";
import { z } from "zod";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostBoundary } from "../src/brain/host-boundary.js";

// The previous HTTP client used fetchJson<T>().json(). Keep its old closed
// TypeScript fields frozen here so proof modes cannot replace their values.
const previousGoverned = z.looseObject({
  hostExecution: z.enum(["worker", "host"]), available: z.boolean(),
  reason: z.enum(["server_cwd_in_brain", "database_in_brain", "private_state_in_brain", "worker_host_unavailable"]).optional(),
  profile: z.enum(["governed", "strict"]).optional(), configurationView: z.enum(["live", "startup"]).optional(),
  identity: z.enum(["shared_uid", "separate_uid"]).optional(),
  protectedPaths: z.array(z.looseObject({ path: z.string(), reason: z.string(), mode: z.enum(["read_only", "mask_file", "mask_directory", "absent"]) })).optional(),
});
for (const mode of ["walk", "filesystem_identity"] as const) test(`previous HTTP status fields accept the optional proof mode ${mode}`, () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-proof-compat-")), brain = join(root, "brain"), state = join(root, "state");
  mkdirSync(brain); mkdirSync(state);
  try {
    const boundary = createHostBoundary({ brainPath: brain, dbPath: join(state, "ui.db"), workerHost: () => ({ ok: true }) });
    const status = { ...boundary.status(), stateBoundary: { mode, cause: "Odysseus current boundary proof" } };
    const transported = JSON.parse(JSON.stringify(status));
    expect(previousGoverned.safeParse(transported).success, "PREVIOUS_STATUS_FIELDS_ACCEPT_OPTIONAL_PROOF").toBe(true);
    expect(transported.stateBoundary.mode).toBe(mode);
    expect(["strict", "governed"]).toContain(transported.profile);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
