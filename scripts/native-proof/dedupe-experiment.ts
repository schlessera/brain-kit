/**
 * Dedupe experiment on the owned reference pool (#3514). Investigation only:
 * it records what the kernel and the real manager do, and asserts only that
 * content never changes. Results go to `dedupe-experiment.json`.
 *
 * Dedupe runs through FIDEDUPERANGE directly, as any deduper would, so the
 * pinned native image needs no extra tool. Cells:
 *  - cross-root: identical data in two roots, dedupe one onto the other, then
 *    release the first. Simple-quota attribution and observed reclamation.
 *  - sealed destination: dedupe into a sealed (read-only) root.
 *  - delta: dedupe inside a worktree between two checkpoints, then read the
 *    checkpoint delta the turn journal consumes.
 *  - metadata: metadata allocation before and after each dedupe.
 */
import { closeSync, openSync, readFileSync, writeFileSync, writeSync, mkdirSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { NativePoolRecord, NativePoolStatus } from "../../packages/ui-sdk/src/server/native-brain-manager-protocol.js";

const MIB = 1024 ** 2;
export interface DedupeContext {
  call: <T>(request: Record<string, unknown>) => Promise<T>;
  run: (request: Record<string, unknown>) => Promise<Response>;
  command: (argv: string[], permitFailure?: boolean) => string;
  note: (kind: string, facts: Record<string, unknown>) => void;
  sync: () => void;
  artifacts: string;
}

/** FIDEDUPERANGE of one whole file onto another; the destination opened read-only, as dedupers may. */
const DEDUPE = "import fcntl,os,struct,sys,errno,json\nsrc=os.open(sys.argv[1],os.O_RDONLY)\nmode=os.O_RDWR if sys.argv[3]=='rw' else os.O_RDONLY\n"
  + "try: dst=os.open(sys.argv[2],mode)\nexcept OSError as e: print(json.dumps({'open':errno.errorcode[e.errno]})); sys.exit(0)\n"
  + "length=os.fstat(src).st_size; done=0; status=0\n"
  + "while done<length and status==0:\n n=min(16*1024*1024,length-done)\n b=bytearray(struct.pack('=QQHHI',done,n,1,0,0)+struct.pack('=qQQiI',dst,done,0,0,0))\n"
  + " try: fcntl.ioctl(src,0xC0189436,b,True)\n except OSError as e: print(json.dumps({'ioctl':errno.errorcode[e.errno],'done':done})); sys.exit(0)\n"
  + " _,_,deduped,status,_=struct.unpack_from('=qQQiI',b,24); done+=deduped\n"
  + "print(json.dumps({'deduped':done,'status':status}))";

export async function runDedupeExperiment(context: DedupeContext): Promise<void> {
  const { call, run, command, note, sync, artifacts } = context;
  const report: Record<string, unknown> = { schema: 1, environment: { kernel: command(["uname", "-r"]).trim(), btrfsProgs: command(["btrfs", "--version"]).split("\n")[0]!.trim(),
    candidate: process.env.BRAIN_PROOF_CANDIDATE ?? "unrecorded" }, cells: {} };
  const cells = report.cells as Record<string, unknown>;
  const save = () => writeFileSync(join(artifacts, "dedupe-experiment.json"), JSON.stringify(report, null, 2));
  const status = () => call<NativePoolStatus>({ operation: "poolStatus" });
  const records = async () => (await call<{ records: NativePoolRecord[] }>({ operation: "listPoolRecovery", after: null })).records;
  const record = async (id: string) => (await records()).find(item => item.id === id) ?? null;
  const create = (purpose: string, from: string | null = null) => call<NativePoolRecord>({ operation: "poolCreate", id: randomUUID(), purpose, from, allowanceBytes: 32 * MIB });
  const seal = (id: string) => call<NativePoolRecord>({ operation: "poolSeal", id });
  const release = (id: string) => call<NativePoolRecord>({ operation: "poolRelease", id });
  const observe = async (label: string, ids: string[]) => {
    sync(); const current = await status();
    const roots = await Promise.all(ids.map(async id => { const item = await record(id); return { id, state: item?.state ?? "forgotten", ownerBytes: item?.ownerBytes ?? null }; }));
    const row = { label, refusal: current.refusal, chargedBytes: current.accounting?.chargedBytes ?? null, ownerBytes: current.accounting?.ownerBytes ?? null,
      metadata: current.accounting?.spaces.metadata.bytesUsed ?? null, data: current.accounting?.spaces.data.bytesUsed ?? null, roots };
    note("dedupe-observation", row); return row;
  };
  const dedupe = (src: string, dst: string, mode: "ro" | "rw" = "ro") => JSON.parse(command(["/usr/bin/python3", "-I", "-S", "-c", DEDUPE, src, dst, mode]).trim()) as Record<string, unknown>;
  const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const fill = (path: string, data: Buffer) => { const fd = openSync(path, "w"); try { for (let at = 0; at < data.length; at += MIB) writeSync(fd, data, at, Math.min(MIB, data.length - at)); } finally { closeSync(fd); } };
  const chart = randomBytes(8 * MIB);

  try {
    // Cross-root: two writable roots with identical independent data, dedupe B onto A, seal, release A first.
    {
      const a = await create("staging"), b = await create("staging");
      fill(join(a.path!, "aegean.bin"), chart); fill(join(b.path!, "aegean.bin"), chart);
      const before = await observe("cross-root-before", [a.id, b.id]);
      const result = dedupe(join(a.path!, "aegean.bin"), join(b.path!, "aegean.bin"));
      const content = hash(join(b.path!, "aegean.bin")) === hash(join(a.path!, "aegean.bin"));
      await seal(a.id); await seal(b.id);
      const deduped = await observe("cross-root-deduped-sealed", [a.id, b.id]);
      const releasedA = await release(a.id);
      const states: unknown[] = [];
      for (let attempt = 0; attempt < 10; attempt++) { await Bun.sleep(500); states.push(await observe(`cross-root-after-release-a-${attempt}`, [a.id, b.id])); }
      const readable = hash(join((await record(b.id))!.path!, "aegean.bin")) === createHash("sha256").update(chart).digest("hex");
      const releasedB = await release(b.id);
      const final = await observe("cross-root-after-release-b", [a.id, b.id]);
      cells.crossRoot = { result, content, readable, before, deduped, releasedA: releasedA.state, afterReleaseA: states.at(-1), releasedB: releasedB.state, final };
      save();
    }
    // Sealed destination: both copies sealed first, then dedupe into the read-only one.
    {
      const a = await create("staging"), b = await create("staging");
      fill(join(a.path!, "ithaca.bin"), chart); fill(join(b.path!, "ithaca.bin"), chart);
      await seal(a.id); await seal(b.id);
      const before = await observe("sealed-before", [a.id, b.id]);
      const pa = (await record(a.id))!.path!, pb = (await record(b.id))!.path!;
      const readOnly = dedupe(join(pa, "ithaca.bin"), join(pb, "ithaca.bin"), "ro");
      const writable = dedupe(join(pa, "ithaca.bin"), join(pb, "ithaca.bin"), "rw");
      const after = await observe("sealed-after", [a.id, b.id]);
      const verified = await call<NativePoolStatus>({ operation: "poolStatus" });
      cells.sealedDestination = { readOnly, writable, before, after, refusal: verified.refusal, content: hash(join(pb, "ithaca.bin")) === hash(join(pa, "ithaca.bin")) };
      for (const id of [b.id, a.id]) await release(id);
      save();
    }
    // Delta: a worktree holds an independent copy of its source's file; dedupe it between two checkpoints.
    {
      const { parseNativeBrainDelta } = await import("../../packages/ui-sdk/src/server/native-brain-delta.js");
      const { decodeNativeDelta } = await import("../../packages/ui-sdk/src/server/native-brain-manager-client.js");
      type Checkpoint = NativePoolRecord & { transaction: string };
      const base = await create("source");
      mkdirSync(join(base.path!, "charts")); fill(join(base.path!, "charts", "scheria.bin"), chart);
      await seal(base.id);
      const tree = await create("worktree", base.id);
      command(["cp", "--reflink=never", join(tree.path!, "charts", "scheria.bin"), join(tree.path!, "charts", "phaeacia.bin")]);
      const first = await call<Checkpoint>({ operation: "poolCheckpoint", id: randomUUID(), from: tree.id });
      const before = await observe("delta-before", [base.id, tree.id]);
      const result = dedupe(join((await record(base.id))!.path!, "charts", "scheria.bin"), join(tree.path!, "charts", "phaeacia.bin"));
      const second = await call<Checkpoint>({ operation: "poolCheckpoint", id: randomUUID(), from: tree.id });
      const after = await observe("delta-after", [base.id, tree.id]);
      const response = await run({ operation: "poolDelta", from: first.id, to: second.id });
      const framed = decodeNativeDelta(response.body!, 64 * MIB);
      const changed: string[] = [];
      for await (const candidate of parseNativeBrainDelta(framed.stream, { before: { uuid: first.root!.uuid, transaction: BigInt(first.transaction) },
        after: { uuid: second.root!.uuid, transaction: BigInt(second.transaction) } })) changed.push(...candidate.paths);
      await framed.completed;
      cells.delta = { result, before, after, changedPaths: changed, falseEdit: changed.includes("charts/phaeacia.bin"),
        content: hash(join(tree.path!, "charts", "phaeacia.bin")) === createHash("sha256").update(chart).digest("hex") };
      for (const id of [first.id, second.id, tree.id, base.id]) await release(id);
      save();
    }
  } finally { save(); note("dedupe-experiment", { cells: Object.keys(cells) }); }
}
