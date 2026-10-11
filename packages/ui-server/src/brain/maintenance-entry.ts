/**
 * The program a credential-free maintenance worker runs for the application
 * route (#1648): capture planning and the index refresh after an applied
 * change. Both evaluate the brain's config and whatever it imports, so they
 * run here, inside the worker, never in the server.
 *
 * One JSON request arrives on stdin; one JSON line answers on stdout. The
 * server treats the answer as untrusted data: code the brain supplies runs in
 * this process too (a config import, a `bunfig.toml` preload), so it could
 * have written anything. The server re-validates every path, bound and base
 * it uses from here.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

interface PlanRequest { op: "plan-add"; root: string; input: Record<string, unknown> }
interface IndexRequest { op: "index"; root: string }

const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

/** Reads a brain document for the planner without following a final link; null when absent. */
function readDocument(root: string, path: string): string | null {
  const parts = path.split("/");
  if (parts.some(part => !part || part === "." || part === "..") || !path.endsWith(".md")) throw new Error("invalid document path");
  let fd: number;
  try { fd = openSync(`${root}/${path}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_DOCUMENT_BYTES) throw new Error("not a readable document");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

async function main(): Promise<unknown> {
  const request = JSON.parse(await Bun.stdin.text()) as PlanRequest | IndexRequest;
  const core = await import("@schlessera/brain/internal");
  const context = await core.initContext({ root: request.root });
  const db = core.openDatabase(context.dbPath);
  try {
    if (request.op === "plan-add") {
      const plan = core.prepareIngest(request.input as unknown as Parameters<typeof core.prepareIngest>[0], db,
        { root: request.root, taxonomy: context.taxonomy, readDocument: path => readDocument(request.root, path) });
      return { ok: true, plan: { path: plan.path, content: plan.content, baseContent: plan.baseContent, outcome: plan.outcome } };
    }
    await core.indexAll(db, { root: request.root, taxonomy: context.taxonomy, quiet: true, force: false });
    return { ok: true };
  } finally { db.close(); }
}

try {
  process.stdout.write(`${JSON.stringify(await main())}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
}
