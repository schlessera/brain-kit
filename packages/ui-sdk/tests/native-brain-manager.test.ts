import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeBrainManagerClient, decodeNativeDelta } from "../src/server/native-brain-manager-client";
import { createNativeBrainManager, nativeStoreMount, validateNativeBrainManagerConfig } from "../src/server/native-brain-manager";
import { nativeManagerFrame, nativeManagerRequest, type NativeBrainManagerError, type NativeManagerRequest } from "../src/server/native-brain-manager-protocol";

const ID = "11111111-1111-4111-8111-111111111790";
const SECOND = "22222222-2222-4222-8222-222222221790";
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function stream(...parts: Uint8Array[]) { return new ReadableStream<Uint8Array>({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } }); }
const collect = async (body: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(body).arrayBuffer());
const config = () => ({ storePath: "/mnt/odysseus", devicePath: "/dev/odysseus", socketPath: "/run/odysseus/native.sock", appGid: 1000,
  fsid: "11111111-1111-4111-8111-111111111790", brainUuid: "11111111111141118111111111111790", capacityBytes: 1024 ** 3,
  recoveryReserveBytes: 4096, operationTimeoutMs: 1000, maxDeltaBytes: 1024 ** 2 });

test("fixed operations reject caller paths, command arguments and unsafe identities", () => {
  for (const operation of [
    { operation: "checkpoint", id: ID, path: "/another/brain" },
    { operation: "checkpoint", id: "../brain" },
    { operation: "release", id: ID, recursive: true },
    { operation: "delta", from: null, to: ID },
    { operation: "delta", from: ID, to: SECOND, command: ["/bin/sh"] },
    { operation: "resize", bytes: 2 ** 40 },
  ]) expect(nativeManagerRequest.safeParse(operation).success, "NATIVE_BROKER_NO_CALLER_PATH_OR_EXECUTION").toBe(false);
  expect(nativeManagerRequest.parse({ operation: "delta", from: ID, to: SECOND })).toEqual({ operation: "delta", from: ID, to: SECOND });
});

test("capacity and recovery allocation are explicit finite operator values", () => {
  expect(() => validateNativeBrainManagerConfig(config())).not.toThrow();
  for (const input of [
    { ...config(), capacityBytes: Infinity }, { ...config(), capacityBytes: 0 },
    { ...config(), recoveryReserveBytes: undefined }, { ...config(), recoveryReserveBytes: 4097 },
    { ...config(), recoveryReserveBytes: config().capacityBytes }, { ...config(), maxDeltaBytes: -1 },
    { ...config(), storePath: "/mnt/odysseus/../other" },
  ]) expect(() => validateNativeBrainManagerConfig(input as never), "NATIVE_NO_IMPLICIT_OR_UNBOUNDED_CAPACITY").toThrow();
});

test("managed mount must be one Btrfs top-level tree without nested brain mounts", () => {
  const top = "41 25 0:38 / /mnt/odysseus rw,nosuid,nodev - btrfs /dev/odysseus rw,nodiscard,subvolid=5,subvol=/\n";
  expect(nativeStoreMount(top, "/mnt/odysseus", "/mnt/odysseus/brain").source).toBe("/dev/odysseus");
  for (const input of [top.replace("btrfs", "ext4"), top.replace(" / /mnt", " /brain /mnt"),
    top + "42 41 0:39 / /mnt/odysseus/brain/workspaces rw - ext4 /dev/other rw\n",
    top + "42 41 0:38 / /mnt/odysseus rw - btrfs /dev/odysseus rw\n"]) {
    expect(() => nativeStoreMount(input, "/mnt/odysseus", "/mnt/odysseus/brain"), "NATIVE_COMPLETE_SINGLE_SUBVOLUME_TOPOLOGY").toThrow();
  }
});

test("broker framing preserves raw native bytes with fragmented headers and success only after EOF", async () => {
  const raw = Uint8Array.from([98, 116, 114, 102, 115, 0, 1, 255]);
  const bytes = nativeManagerFrame(1, raw), end = nativeManagerFrame(2, encode({ ok: true, exitCode: 0, bytes: raw.byteLength }));
  const decoded = decodeNativeDelta(stream(bytes.slice(0, 2), bytes.slice(2, 6), bytes.slice(6), end.slice(0, 4), end.slice(4)), 64);
  expect(await collect(decoded.stream), "NATIVE_DELTA_RAW_STREAM_UNCHANGED").toEqual(raw);
  expect(await decoded.completed).toEqual({ exitCode: 0, bytes: raw.byteLength });
});

test("native EOF alone never proves successful broker completion", async () => {
  const decoded = decodeNativeDelta(stream(nativeManagerFrame(1, Uint8Array.from([1, 2, 3]))), 64);
  await expect(collect(decoded.stream), "NATIVE_DELTA_REQUIRES_MANAGER_COMPLETION").rejects.toThrow("before its broker completion");
  await expect(decoded.completed).rejects.toThrow("before its broker completion");
});

test("failed, mismatched and trailing completion cannot be called a complete delta", async () => {
  const data = nativeManagerFrame(1, Uint8Array.from([1]));
  for (const parts of [
    [data, nativeManagerFrame(2, encode({ ok: true, exitCode: 1, bytes: 1 }))],
    [data, nativeManagerFrame(2, encode({ ok: true, exitCode: 0, bytes: 2 }))],
    [data, nativeManagerFrame(2, encode({ ok: true, exitCode: 0, bytes: 1 })), Uint8Array.from([0])],
  ]) {
    const decoded = decodeNativeDelta(stream(...parts), 64);
    await expect(collect(decoded.stream), "NATIVE_NO_FALSE_COMPLETE_OR_TRAILING_BYTES").rejects.toThrow();
    await expect(decoded.completed).rejects.toThrow();
  }
});

test("output bound and consumer cancellation reject completion", async () => {
  const over = decodeNativeDelta(stream(nativeManagerFrame(1, Uint8Array.from([1, 2]))), 1);
  await expect(collect(over.stream), "NATIVE_DELTA_OUTPUT_BOUND").rejects.toThrow("bound"); await expect(over.completed).rejects.toThrow();
  const cancelled = decodeNativeDelta(new ReadableStream({ start() {} }), 64);
  await cancelled.stream.cancel(new Error("Odysseus stopped"));
  await expect(cancelled.completed, "NATIVE_CANCEL_NEVER_SUCCESS").rejects.toThrow("Odysseus stopped");
});

test("unprivileged app cannot create the native management service", async () => {
  if (process.geteuid?.() === 0) return; // Native root service is qualified separately on its disposable managed store.
  await expect(createNativeBrainManager(config()), "NATIVE_APP_RECEIVES_NO_ADMINISTRATIVE_AUTHORITY").rejects.toThrow("trusted Linux x86-64 root service");
});

/** Actual Unix transport; this fixture is not a Btrfs qualification substitute. */
test("Unix client sends only fixed identities and returns raw delta plus completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-native-socket-")), socketPath = join(root, "manager.sock");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const requests: NativeManagerRequest[] = [], raw = Uint8Array.from([0, 1, 2, 3]);
  const service = Bun.serve({ unix: socketPath, async fetch(request) {
    const message = nativeManagerRequest.parse(await request.json()); requests.push(message);
    if (message.operation === "delta") return new Response(stream(nativeManagerFrame(1, raw), nativeManagerFrame(2, encode({ ok: true, exitCode: 0, bytes: raw.byteLength }))), { headers: { "content-type": "application/x-brain-native-delta" } });
    return Response.json({ id: ID, state: "deleted" });
  } });
  cleanups.push(() => service.stop(true));
  const client = createNativeBrainManagerClient({ socketPath, timeoutMs: 1000, maxDeltaBytes: 64 });
  const delta = await client.delta(ID, SECOND); expect(await collect(delta.stream)).toEqual(raw); expect(await delta.completed).toEqual({ exitCode: 0, bytes: 4 });
  expect(await client.release(ID)).toEqual({ id: ID, state: "deleted" });
  expect(requests).toEqual([{ operation: "delta", from: ID, to: SECOND }, { operation: "release", id: ID }]);
});

test("lost Unix response is unknown and never an inferred absence or automatic retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-native-lost-")), socketPath = join(root, "manager.sock");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  let requests = 0;
  const service = Bun.serve({ unix: socketPath, async fetch() { requests++; await Bun.sleep(100); return Response.json({ id: ID }); } });
  cleanups.push(() => service.stop(true));
  const client = createNativeBrainManagerClient({ socketPath, timeoutMs: 20, maxDeltaBytes: 64 });
  const error = await client.checkpoint(ID).then(() => { throw Error("Expected a lost response"); }, error => error as NativeBrainManagerError);
  expect(error.code, "NATIVE_INTERRUPTED_MUTATION_OUTCOME_UNKNOWN").toBe("unknown");
  expect(requests, "NATIVE_NO_BLIND_CHECKPOINT_RETRY").toBe(1);
});

test("unreadable successful response does not erase mutation uncertainty", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-native-receipt-")), socketPath = join(root, "manager.sock");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const service = Bun.serve({ unix: socketPath, fetch() { return new Response("{", { headers: { "content-type": "application/json" } }); } });
  cleanups.push(() => service.stop(true));
  const client = createNativeBrainManagerClient({ socketPath });
  const error = await client.checkpoint(ID).then(() => { throw Error("Expected unreadable receipt"); }, error => error as NativeBrainManagerError);
  expect(error.code, "NATIVE_UNREADABLE_RECEIPT_RETAINS_UNKNOWN_OWNERSHIP").toBe("unknown");
});

test("stage authority has a fixed app owner and finite allowance/aggregate budget", () => {
  const stage = { ...config(), appUid: 1000, stageAllowanceBytes: 4096, stageBudgetBytes: 8192 };
  expect(() => validateNativeBrainManagerConfig(stage)).not.toThrow();
  expect(() => validateNativeBrainManagerConfig({ ...stage, appUid: 0 }), "NATIVE_ROOT_APP_KEEPS_WARNING_POLICY").not.toThrow();
  for (const bad of [{ ...stage, appUid: -1 }, { ...stage, appUid: 0xffffffff }, { ...stage, appUid: undefined }, { ...stage, stageBudgetBytes: Infinity },
    { ...stage, stageAllowanceBytes: 4097 }, { ...stage, stageBudgetBytes: 4096, stageAllowanceBytes: 8192 }]) {
    expect(() => validateNativeBrainManagerConfig(bad as never), "NATIVE_STAGE_FIXED_FINITE_AUTHORITY").toThrow();
  }
  for (const extra of [{ uid: 0 }, { path: "/another/stage" }, { command: ["/bin/sh"] }]) {
    expect(nativeManagerRequest.safeParse({ operation: "prepareStage", id: ID, checkpointId: SECOND, allowanceBytes: 4096, ...extra }).success).toBe(false);
  }
});

test("stage metadata binds its lower checkpoint and requires framed completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-native-stage-")), socketPath = join(root,"manager.sock"), seen: unknown[] = [];
  cleanups.push(() => rmSync(root,{recursive:true,force:true}));
  const row = new TextEncoder().encode(JSON.stringify({pathHex:Buffer.from("notes/odysseus.md").toString("hex"),kind:"entry"})+"\n");
  const service = Bun.serve({unix:socketPath, async fetch(request) { seen.push(await request.json()); return new Response(stream(
    nativeManagerFrame(1,row),nativeManagerFrame(2,encode({ok:true,exitCode:0,bytes:row.length}))),{headers:{"content-type":"application/x-brain-native-stage","x-brain-stage-id":ID,"x-brain-stage-checkpoint":SECOND,"x-brain-stage-lower":"11111111111141118111111111111790"}}); }});
  cleanups.push(() => service.stop(true));
  const client=createNativeBrainManagerClient({socketPath}), receipt=await client.inspectStage(ID), changes=[];
  for await (const change of receipt.changes) changes.push(change);
  expect(changes).toEqual([{pathHex:Buffer.from("notes/odysseus.md").toString("hex"),kind:"entry"}]);
  expect(receipt.checkpointId).toBe(SECOND);expect(await receipt.completed).toEqual({exitCode:0,bytes:row.length});
  expect(seen).toEqual([{operation:"inspectStage",id:ID}]);
});
