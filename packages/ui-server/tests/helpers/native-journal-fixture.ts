/** Test-only copied roots and synthetic native records; never a production fallback. */
import { createHash } from "node:crypto";
import { cpSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { NativeJournalCheckpoint, NativeJournalManager } from "../../src/brain/native-journal-observer.js";
import type { createNativeBrainManagerClient } from "../../../ui-sdk/src/server/native-brain-manager-client.js";
import { nativeManagerFrame, nativeManagerRequest, NATIVE_DATA_CHUNK_BYTES } from "../../../ui-sdk/src/server/native-brain-manager-protocol.js";

type Entry = { kind: "directory" | "file" | "symlink" | "other"; mode: number; bytes: number; identity: string; ino: bigint; target?: string };
const bytes = (text: string) => Buffer.from(text, "utf8");
const u64 = (value: bigint) => { const result = Buffer.alloc(8); result.writeBigUInt64LE(value); return result; };
// Independent lookup-table encoder; product parser verifies with bitwise CRC.
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0x82f63b78 : value >>> 1;
  return value >>> 0;
});
function command(kind: number, attributes: [number, Uint8Array][] = []): Buffer {
  const payload = Buffer.concat(attributes.map(([kind, value]) => {
    const header = Buffer.alloc(4); header.writeUInt16LE(kind); header.writeUInt16LE(value.byteLength, 2);
    return Buffer.concat([header, value]);
  }));
  const header = Buffer.alloc(10); header.writeUInt32LE(payload.byteLength); header.writeUInt16LE(kind, 4);
  const result = Buffer.concat([header, payload]); let crc = 0;
  for (const byte of result) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  result.writeUInt32LE(crc >>> 0, 6); return result;
}
function inventory(root: string): Map<string, Entry> {
  const result = new Map<string, Entry>();
  function walk(parent: string) {
    for (const name of readdirSync(join(root, parent)).sort()) {
      const path = parent ? `${parent}/${name}` : name, absolute = join(root, path), info = lstatSync(absolute, { bigint: true });
      const kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : info.isSymbolicLink() ? "symlink" : "other";
      const target = kind === "symlink" ? readlinkSync(absolute) : undefined;
      const content = kind === "file" ? createHash("sha256").update(readFileSync(absolute)).digest("hex") : target ?? "";
      const mode = Number(info.mode & 0o7777n), size = Number(info.size);
      result.set(path, { kind, mode, bytes: size, ino: info.ino,
        identity: JSON.stringify([kind, mode, kind === "directory" ? 0 : size, content]), ...(target !== undefined ? { target } : {}) });
      if (kind === "directory") walk(path);
    }
  }
  walk(""); return result;
}

export function createNativeJournalFixture(brain: string, root: string) {
  const snapshots = join(root, "native-test-checkpoints"); mkdirSync(snapshots, { recursive: true });
  const inodePins = join(root, "native-test-inode-pins"); mkdirSync(inodePins, { mode: 0o700 });
  let pinSequence = 0;
  const retained = new Map<string, { checkpoint: NativeJournalCheckpoint; entries: Map<string, Entry> }>();
  const deleted = new Set<string>(); let sequence = 0, checkpointFailure: Error | undefined;
  const manager: NativeJournalManager = {
    async checkpoint(id, signal) {
      signal?.throwIfAborted();
      if (checkpointFailure) { const error = checkpointFailure; checkpointFailure = undefined; throw error; }
      if (deleted.has(id)) throw Error("Fixture checkpoint identity already released");
      const old = retained.get(id); if (old) return old.checkpoint;
      const path = join(snapshots, id), entries = inventory(brain);
      cpSync(brain, path, { recursive: true, dereference: false, preserveTimestamps: true });
      // Copies lack Btrfs inode lineage. The observer can retain metadata from
      // an older released copy; reserve its file inodes so later copies cannot
      // reuse one for an unrelated path and manufacture a hardlink candidate.
      // These private test-only links disappear when this fixture closes.
      for (const [relative, entry] of entries) if (entry.kind === "file") {
        linkSync(join(path, relative), join(inodePins, String(++pinSequence)));
      }
      const checkpoint: NativeJournalCheckpoint = { id, path, uuid: createHash("sha256").update(id).digest("hex").slice(0, 32), transaction: String(++sequence), readOnly: true };
      retained.set(id, { checkpoint, entries }); signal?.throwIfAborted(); return checkpoint;
    },
    async delta(from, to, signal) {
      signal?.throwIfAborted(); const before = retained.get(from), after = retained.get(to);
      if (!before || !after) throw Error("Fixture delta requires retained roots");
      const records: Buffer[] = [command(2, [[15, bytes(to)], [1, Buffer.from(after.checkpoint.uuid, "hex")], [2, u64(BigInt(after.checkpoint.transaction))],
        [20, Buffer.from(before.checkpoint.uuid, "hex")], [21, u64(BigInt(before.checkpoint.transaction))]])];
      for (const path of [...new Set([...before.entries.keys(), ...after.entries.keys()])].sort()) {
        const old = before.entries.get(path), current = after.entries.get(path);
        if (old?.identity === current?.identity) continue;
        if (!current) records.push(command(old?.kind === "directory" ? 12 : 11, [[15, bytes(path)]]));
        else if (!old) {
          records.push(command(current.kind === "directory" ? 4 : current.kind === "symlink" ? 8 : 3,
            [[15, bytes(path)], [3, u64(current.ino)], ...(current.kind === "symlink" ? [[17, bytes(current.target!)] as [number, Uint8Array]] : [])]));
        } else if (old.mode !== current.mode) records.push(command(18, [[15, bytes(path)], [5, u64(BigInt(current.mode))]]));
        else records.push(command(22, [[15, bytes(path)], [18, u64(0n)], [4, u64(BigInt(current.bytes))]]));
      }
      const raw = Buffer.concat([bytes("btrfs-stream\0"), Buffer.from([1, 0, 0, 0]), ...records, command(21)]);
      const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(raw); controller.close(); } });
      return { stream, completed: Promise.resolve({ exitCode: 0 as const, bytes: raw.byteLength }) };
    },
    async release(id) { const item = retained.get(id); if (item) rmSync(item.checkpoint.path, { recursive: true, force: true }); retained.delete(id); deleted.add(id); },
  };
  const client: ReturnType<typeof createNativeBrainManagerClient> = {
    ...manager,
    async readStage() { throw Error("Copied native fixture cannot qualify private stage reads"); },
    async statStage() { throw Error("Copied native fixture cannot qualify private stage metadata"); },
    async listStage() { throw Error("Copied native fixture cannot qualify private stage inventory"); },
    async attestStage() { throw Error("Copied native fixture cannot qualify stage identity authority"); },
    async readCheckpoint() { throw Error("Copied native fixture cannot qualify fixed-UID checkpoint reads."); },
    async statCheckpoint() { throw Error("Copied native fixture cannot qualify fixed-UID checkpoint metadata."); },
    async listCheckpoint() { throw Error("Copied native fixture cannot qualify fixed-UID checkpoint inventory."); },
    async prepareStage() { throw Error("Copied native fixture does not qualify output-stage runtime; provide explicit prepared worker test output."); },
    async inspectStage() { throw Error("Copied native fixture has no output stage to inspect."); },
    async releaseStage(id) { return { id, state: "deleted" }; },
    async ready() { return { brainPath: brain, brainUuid: "11".repeat(16), brainRootId: "256", privatePaths: [snapshots],
      fsid: "11111111-1111-4111-8111-111111111790", capacityBytes: 1024 ** 3, availableBytes: 1024 ** 3, recoveryReserveBytes: 4096, reserveAllocatedBytes: 4096 }; },
    async checkpoint(id, signal) { return { ...await manager.checkpoint(id, signal), sourceUuid: "11".repeat(16), fsid: "11111111-1111-4111-8111-111111111790", rootId: "257" }; },
    async release(id, signal) { await manager.release(id, signal); return { id, state: "deleted" }; },
    async listRecovery() { return { records: [...retained.values()].map(item => ({ id: item.checkpoint.id, state: "sealed" as const,
      checkpoint: { ...item.checkpoint, sourceUuid: "11".repeat(16), fsid: "11111111-1111-4111-8111-111111111790", rootId: "257" } })), next: null }; },
  };
  return { manager, client, failNextCheckpoint(error: Error) { checkpointFailure = error; },
    /** Offline Unix wire fixture; real client framing and hosted paths stay exercised. */
    serve() {
      const socketPath = join(root, "native-test-manager.sock");
      const server = Bun.serve({ unix: socketPath, async fetch(request) {
        try {
        const message = nativeManagerRequest.parse(await request.json());
        if (message.operation === "ready") return Response.json(await client.ready());
        if (message.operation === "checkpoint") return Response.json(await client.checkpoint(message.id, request.signal));
        if (message.operation === "release") return Response.json(await client.release(message.id, request.signal));
        if (message.operation === "listRecovery") return Response.json(await client.listRecovery());
        if (message.operation === "prepareStage") return Response.json(await client.prepareStage(message.id,message.checkpointId,message.allowanceBytes,request.signal));
        if (message.operation === "releaseStage") return Response.json(await client.releaseStage(message.id,request.signal));
        if (message.operation === "inspectStage") throw Error("Copied native fixture cannot qualify stage inspection.");
        if (message.operation !== "delta") throw Error("Copied native fixture cannot qualify private native operations.");
        const result = await client.delta(message.from, message.to, request.signal);
        const raw = new Uint8Array(await new Response(result.stream).arrayBuffer()), completed = await result.completed;
        const frames: Uint8Array[] = [];
        for (let offset=0;offset<raw.length;offset+=NATIVE_DATA_CHUNK_BYTES) frames.push(nativeManagerFrame(1,raw.subarray(offset,offset+NATIVE_DATA_CHUNK_BYTES)));
        return new Response(Buffer.concat([...frames, nativeManagerFrame(2, bytes(JSON.stringify({ ok: true, ...completed })))]),
          { headers: { "content-type": "application/x-brain-native-delta" } });
        } catch (error) { return Response.json({ code: "unknown", message: error instanceof Error ? error.message : String(error) }, { status: 503 }); }
      } });
      return { socketPath, close() { server.stop(true); } };
    },
    async close() {
      for (const id of [...retained.keys()]) await manager.release(id);
      rmSync(snapshots, { recursive: true, force: true });
      rmSync(inodePins, { recursive: true, force: true });
    } };
}
