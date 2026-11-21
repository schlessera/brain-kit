/**
 * The pin (plan §8, "An exact pin"; #4205): a fake gog stands in for the
 * release binary, with a test pin table that lists the fake's own hash, so
 * every refusal is proven against a binary that otherwise passes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GOG_PINS, gogPlatform, verifyGogBinary } from "@schlessera/brain-common/internal/google-gog";
import { gogInvocation } from "../src/google/gog/argv.ts";
import { gogEnvironment } from "../src/google/gog/environment.ts";
import { checkGogSchema, verifyGogBinaryWith, type GogPinParameters } from "../src/google/gog/pin.ts";
import { GOG_SCHEMA_SNAPSHOT } from "../src/google/gog/snapshot.ts";
import { createGogTransportInternals } from "../src/google/gog/transport.ts";
import { createFakeGog, type FakeGog, type FakeGogScenario } from "./support/fake-gog.ts";
import { schemaFromSnapshot } from "./support/gog-schema.ts";

const VERSION = { stdout: "v0.48.1 (44364d31 2026-11-16T05:55:59Z)\n" };
const labels = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/gog/labels-list.json"), "utf8"));
const sha256 = (path: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");

const fakes: FakeGog[] = [];
afterEach(() => {
  for (const fake of fakes.splice(0)) fake.dispose();
});

function setup(scenario: FakeGogScenario = {}, schema: unknown = schemaFromSnapshot(GOG_SCHEMA_SNAPSHOT)) {
  const fake = createFakeGog({ version: VERSION, schema: { stdout: schema }, ...scenario });
  fakes.push(fake);
  const built = gogEnvironment(fake.environment);
  if (!built.ok) throw new Error("fixture environment");
  const parameters: GogPinParameters = {
    pins: [{ version: "0.48.1", commit: "44364d31", sha256: { linux_amd64: sha256(fake.executable), darwin_arm64: sha256(fake.executable) } }],
    snapshot: GOG_SCHEMA_SNAPSHOT,
    platform: "linux_amd64",
    uid: process.getuid!(),
    timeoutMs: 20_000,
  };
  const verify = (overrides: Partial<GogPinParameters> = {}) => verifyGogBinaryWith(fake.executable, { env: built.environment }, { ...parameters, ...overrides });
  return { fake, parameters, verify, env: built.environment };
}

describe("the pin accepts the pinned binary", () => {
  test("a binary whose hash, version, commit and schema match passes, and the result names the file it hashed", async () => {
    const { fake, verify } = setup();
    const result = await verify();
    expect(result).toMatchObject({ ok: true, path: fake.executable, version: "0.48.1", commit: "44364d31", platform: "linux_amd64", sha256: sha256(fake.executable) });
    expect(fake.calls().map(call => call.argv)).toEqual([["version"], ["schema", "--json"]]);
  });

  test("the committed pins name 0.48.1 for all four release platforms, and an unlisted platform has none", () => {
    expect(GOG_PINS.map(pin => pin.version)).toEqual(["0.48.1"]);
    expect(Object.keys(GOG_PINS[0]!.sha256).sort()).toEqual(["darwin_amd64", "darwin_arm64", "linux_amd64", "linux_arm64"]);
    for (const hash of Object.values(GOG_PINS[0]!.sha256)) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(gogPlatform("linux", "x64")).toBe("linux_amd64");
    expect(gogPlatform("darwin", "arm64")).toBe("darwin_arm64");
    expect(gogPlatform("win32", "x64")).toBeNull();
    expect(gogPlatform("linux", "ia32")).toBeNull();
  });

  test("the production check refuses the fake: its hash is no release's", async () => {
    const { fake, env } = setup();
    const result = await verifyGogBinary(fake.executable, { env });
    expect(result.ok).toBe(false);
    expect(fake.calls()).toEqual([]);
  });
});

describe("the pin refuses, and runs nothing before the hash matches", () => {
  test("wrong hash", async () => {
    const { fake, verify, parameters } = setup();
    const pins = [{ ...parameters.pins[0]!, sha256: { linux_amd64: "0".repeat(64) } }];
    expect(await verify({ pins })).toMatchObject({ ok: false, reason: "hash_not_pinned" });
    expect(fake.calls()).toEqual([]);
  });

  test("unlisted version: the binary reports a version the list does not name", async () => {
    const { fake, verify } = setup({ version: { stdout: "v0.49.0 (5a5a5a5a 2026-12-01T00:00:00Z)\n" } });
    expect(await verify()).toMatchObject({ ok: false, reason: "version_not_pinned" });
    expect(fake.callsOf("schema")).toEqual([]);
  });

  test("a listed version under another hash, or another commit, is a mismatch", async () => {
    const { verify, parameters } = setup({ version: { stdout: "v0.47.0 (1b1b1b1b 2026-10-01T00:00:00Z)\n" } });
    const pins = [...parameters.pins, { version: "0.47.0", commit: "1b1b1b1b", sha256: { linux_amd64: "1".repeat(64) } }];
    expect(await verify({ pins })).toMatchObject({ ok: false, reason: "version_mismatch" });
    const other = setup({ version: { stdout: "v0.48.1 (deadbeef 2026-11-16T05:55:59Z)\n" } });
    expect(await other.verify()).toMatchObject({ ok: false, reason: "version_mismatch" });
    const garbled = setup({ version: { stdout: "gog version 0.48.1\n" } });
    expect(await garbled.verify()).toMatchObject({ ok: false, reason: "version_failed" });
  });

  test("missing flag: the binary's schema lacks a flag the catalog uses", async () => {
    const schema = schemaFromSnapshot(GOG_SCHEMA_SNAPSHOT);
    const thread = schema.command.subcommands!.find(node => node.name === "gmail")!.subcommands!.find(node => node.name === "search")!;
    thread.flags = thread.flags.filter(flag => flag.name !== "ids-only");
    const { verify } = setup({}, schema);
    expect(await verify()).toMatchObject({ ok: false, reason: "missing_flag" });
  });

  test("group-writable binary", async () => {
    const { fake, verify } = setup();
    chmodSync(fake.executable, 0o720);
    expect(await verify()).toMatchObject({ ok: false, reason: "binary_writable" });
    chmodSync(fake.executable, 0o702);
    expect(await verify()).toMatchObject({ ok: false, reason: "binary_writable" });
    expect(fake.calls()).toEqual([]);
  });

  test("a directory others can write, an owner that is neither root nor the host user, a file that is not executable", async () => {
    const { fake, verify } = setup();
    chmodSync(dirname(fake.executable), 0o770);
    expect(await verify()).toMatchObject({ ok: false, reason: "directory_writable" });
    chmodSync(dirname(fake.executable), 0o700);
    expect(await verify({ uid: process.getuid!() + 1 })).toMatchObject({ ok: false, reason: "binary_owner" });
    chmodSync(fake.executable, 0o600);
    expect(await verify()).toMatchObject({ ok: false, reason: "not_executable" });
    expect(fake.calls()).toEqual([]);
  });

  test("an unlisted platform, a relative path and a missing file", async () => {
    const { fake, verify, env, parameters } = setup();
    expect(await verify({ platform: null })).toMatchObject({ ok: false, reason: "platform_not_pinned" });
    expect(await verify({ platform: "darwin_amd64" })).toMatchObject({ ok: false, reason: "platform_not_pinned" });
    expect(await verifyGogBinaryWith("bin/gog", { env }, parameters)).toMatchObject({ ok: false, reason: "not_absolute" });
    expect(await verifyGogBinaryWith(join(fake.dir, "nowhere", "gog"), { env }, parameters)).toMatchObject({ ok: false, reason: "binary_missing" });
  });
});

describe("the schema check", () => {
  const good = () => schemaFromSnapshot(GOG_SCHEMA_SNAPSHOT);
  test("passes the snapshot's own schema and refuses each kind of drift", () => {
    expect(checkGogSchema(good(), GOG_SCHEMA_SNAPSHOT, "0.48.1")).toBeNull();
    expect(checkGogSchema({ ...good(), schema_version: 2 }, GOG_SCHEMA_SNAPSHOT, "0.48.1")).toBe("schema_version");
    expect(checkGogSchema({ ...good(), build: "v0.48.2 (abc)" }, GOG_SCHEMA_SNAPSHOT, "0.48.1")).toBe("schema_build");
    expect(checkGogSchema({ ...good(), automation: { exit_codes: { ...GOG_SCHEMA_SNAPSHOT.exit_codes, retryable: 9 } } }, GOG_SCHEMA_SNAPSHOT, "0.48.1")).toBe("exit_codes");
    const extraCode = good();
    extraCode.automation.exit_codes.throttled = 12;
    expect(checkGogSchema(extraCode, GOG_SCHEMA_SNAPSHOT, "0.48.1")).toBe("exit_codes");
    const noCommand = good();
    const gmail = noCommand.command.subcommands!.find(node => node.name === "gmail")!;
    gmail.subcommands = gmail.subcommands!.filter(node => node.name !== "drafts");
    expect(checkGogSchema(noCommand, GOG_SCHEMA_SNAPSHOT, "0.48.1")).toBe("missing_command");
    const retyped = good();
    const max = retyped.command.subcommands!.find(node => node.name === "gmail")!.subcommands!.find(node => node.name === "search")!.flags.find(flag => flag.name === "max")!;
    max.type = "string";
    expect(checkGogSchema(retyped, GOG_SCHEMA_SNAPSHOT, "0.48.1")).toBe("flag_type");
    const noRootFlag = good();
    noRootFlag.command.flags = noRootFlag.command.flags.filter(flag => flag.name !== "gmail-no-send");
    expect(checkGogSchema(noRootFlag, GOG_SCHEMA_SNAPSHOT, "0.48.1")).toBe("missing_flag");
    const noPositional = good();
    const thread = noPositional.command.subcommands!.find(node => node.name === "gmail")!.subcommands!.find(node => node.name === "thread")!.subcommands!.find(node => node.name === "get")!;
    thread.positionals = [];
    expect(checkGogSchema(noPositional, GOG_SCHEMA_SNAPSHOT, "0.48.1")).toBe("missing_positional");
    expect(checkGogSchema("not a schema", GOG_SCHEMA_SNAPSHOT, "0.48.1")).toBe("schema_unreadable");
  });

  test("a schema the binary cannot print is unreadable", async () => {
    const { verify } = setup({ schema: { stdout: "{ not json" } });
    expect(await verify()).toMatchObject({ ok: false, reason: "schema_unreadable" });
  });
});

describe("the transport re-checks the binary's identity", () => {
  const modify = gogInvocation("gmail.modify", { message_ids: ["19a0c3d2e4f50601"], remove_label_ids: ["INBOX"] });

  test("changed inode before a write: transport_incompatible, nothing runs, and the next call checks the new file", async () => {
    const { fake, parameters } = setup({ "gmail.labels.list": { stdout: labels }, "gmail.batch.modify": { stdout: {} } });
    const transport = createGogTransportInternals({
      binary: { kind: "pinned", path: fake.executable }, account: "ithaca-pin", environment: fake.environment, pinParameters: parameters,
    });
    expect((await transport.execute("gmail.labels.list", {})).ok).toBe(true);
    // Same bytes and mode, new inode: what replacing the file in place does.
    const copy = `${fake.executable}.new`;
    copyFileSync(fake.executable, copy);
    chmodSync(copy, 0o700);
    renameSync(copy, fake.executable);
    expect(await transport.invoke("gmail.modify", modify)).toEqual({
      ok: false, error: { code: "transport_incompatible", reason: "binary_changed", message: expect.any(String) },
    });
    expect(fake.callsOf("gmail.batch.modify")).toEqual([]);
    expect((await transport.invoke("gmail.modify", modify)).ok).toBe(true);
    expect(fake.callsOf("schema")).toHaveLength(2);
    expect(fake.callsOf("gmail.batch.modify")).toHaveLength(1);
  });

  test("a refused binary stays refused until the file changes, then recovers by itself", async () => {
    const { fake, parameters } = setup({ "gmail.labels.list": { stdout: labels } });
    const pinnedBytes = readFileSync(fake.executable);
    writeFileSync(fake.executable, Buffer.concat([pinnedBytes, Buffer.from("// tampered\n")]));
    const transport = createGogTransportInternals({
      binary: { kind: "pinned", path: fake.executable }, account: "ithaca-pin", environment: fake.environment, pinParameters: parameters,
    });
    expect(await transport.execute("gmail.labels.list", {})).toMatchObject({ ok: false, error: { code: "transport_incompatible", reason: "hash_not_pinned" } });
    expect(await transport.availability()).toMatchObject({ ok: false, error: { reason: "hash_not_pinned" } });
    expect(fake.calls()).toEqual([]);
    writeFileSync(fake.executable, pinnedBytes);
    expect(await transport.execute("gmail.labels.list", {})).toMatchObject({ ok: true });
    expect(await transport.availability()).toMatchObject({ ok: true, fake: false, pin: { version: "0.48.1" } });
  });

  test("a fake skips the pin: no version or schema call", async () => {
    const { fake } = setup({ "gmail.labels.list": { stdout: labels } });
    const transport = createGogTransportInternals({ binary: fake.binary, account: "ithaca-pin", environment: fake.environment });
    expect(await transport.availability()).toEqual({ ok: true, fake: true });
    expect((await transport.execute("gmail.labels.list", {})).ok).toBe(true);
    expect(fake.calls().map(call => call.command)).toEqual(["gmail.labels.list"]);
  });
});
