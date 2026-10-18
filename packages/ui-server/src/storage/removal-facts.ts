import { subprocessEnv } from "../config/env.js";
/** Repository evaluation stays in a disposable worker; even incidental Git writes are discarded. */
import { z } from "zod";
import type { StorageAttachmentFacts } from "@schlessera/brain/storage";
import { MAINTENANCE_ENTRY, type HostBoundary } from "../brain/host-boundary.js";
const relative = z.string().min(1).max(4096).refine(value => !value.startsWith("/") && !/[\\\u0000-\u001f\u007f]/u.test(value) && value.split("/").every(part => part && part !== "." && part !== ".."));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const schema = z.object({ fingerprint: hash, complete: z.boolean(), scannedFiles: z.number().int().min(0).max(2000), unchecked: z.array(z.string().max(160)).max(16),
  files: z.array(z.object({ path: relative, git: z.enum(["tracked", "untracked", "ignored", "no-repository", "unknown"]), truncated: z.boolean(),
    references: z.array(z.object({ source: relative, hash, certainty: z.enum(["resolved", "possible"]) }).strict()).max(200) }).strict()).max(32) }).strict();
export async function readRemovalFacts(boundary: Pick<HostBoundary, "isolated" | "run">, root: string, paths: string[], signal: AbortSignal, assertAuthorized: () => void): Promise<StorageAttachmentFacts> {
  if (!boundary.isolated()) throw Error("Attachment review requires the qualified worker boundary.");
  const result = await boundary.run({ argv: [process.execPath, "--config=/dev/null", "--no-env-file", MAINTENANCE_ENTRY], env: subprocessEnv("brainCli", { NO_COLOR: "1" }),
    credentials: false, gate: "none", purpose: "storage-removal-review", publish: false, outputBytes: 262144, timeoutMs: 30_000,
    stdin: JSON.stringify({ op: "storage-facts", root, paths }), signal, assertAuthorized });
  if (result.exitCode !== 0 || result.timedOut) throw Error("Attachment consequences unavailable.");
  const response = JSON.parse(result.stdout) as { ok?: boolean; facts?: unknown };
  const facts = schema.parse(response.facts);
  if (!response.ok || facts.files.length !== paths.length || facts.files.some((file, index) => file.path !== paths[index])) throw Error("Attachment selection changed in review.");
  return facts;
}
