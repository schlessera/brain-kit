import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, linkSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectMetadata } from "../src/storage/metadata";
import { storageTotals } from "../src/storage/collect";

test("server metadata stays within exact roots and does not follow descendants or sidecar redirects", async () => {
  const root = mkdtempSync(join(tmpdir(), "storage-odysseus-"));
  try {
    const store = join(root, "journal"); mkdirSync(store);
    writeFileSync(join(root, "credential"), "private fixture bytes");
    writeFileSync(join(store, "Troy.PDF"), "chart");
    symlinkSync(join(root, "credential"), join(store, "link"));
    symlinkSync(join(root, "credential"), join(root, "app.db-wal"));
    const result = await collectMetadata([{ id: "journal", path: store, recursive: true }, { id: "sidecar", path: join(root, "app.db-wal"), recursive: false }]);
    expect(result.entries.map(entry => entry.path).sort(), "STORAGE_EXACT_ROOTS").toEqual(["", "Troy.PDF", "link"]);
    expect(result.entries.find(entry => entry.path === "link")?.kind).toBe("symlink");
    expect(result.errors, "STORAGE_SIDECAR_REDIRECT_REFUSED").toContainEqual({ rootId: "sidecar", reason: "unsupported-root" });
    expect(result.capacities).toHaveLength(1);
    expect(result.capacities[0]?.rootId).toBe("journal");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("server metadata records hard-link identity once in the object union and preserves a partial budget", async () => {
  const root = mkdtempSync(join(tmpdir(), "storage-odysseus-"));
  try {
    writeFileSync(join(root, "Troy.pdf"), "12345"); linkSync(join(root, "Troy.pdf"), join(root, "Ithaca.pdf"));
    const result = await collectMetadata([{ id: "charts", path: root, recursive: true }]);
    const files = result.entries.filter(entry => entry.kind === "file");
    expect(files).toHaveLength(2); expect(files[0]!.object).toBe(files[1]!.object);
    const entries = files.map(entry => ({ kind: entry.kind, objectId: entry.object, logical: entry.logical, allocated: entry.allocated }));
    expect(storageTotals(entries).logical, "STORAGE_OBJECT_UNION").toBe(5);
    const partial = await collectMetadata([{ id: "charts", path: root, recursive: true }], { entries: 1 });
    expect(partial.entries).toHaveLength(1); expect(partial.errors).toContainEqual({ rootId: "charts", reason: "entry-budget" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("actual same-device bind descendants are not traversed by the server metadata worker", async () => {
  const root = mkdtempSync(join(tmpdir(), "storage-odysseus-"));
  try {
    mkdirSync(join(root, "source")); mkdirSync(join(root, "mounted"));
    writeFileSync(join(root, "source", "Troy.pdf"), "chart");
    const script = `import {collectMetadata} from ${JSON.stringify(import.meta.resolve("../src/storage/metadata.ts"))}; console.log(JSON.stringify(await collectMetadata([{id:"odysseus",path:${JSON.stringify(root)},recursive:true}])));`;
    const child = Bun.spawn(["bwrap", "--unshare-user", "--unshare-net", "--bind", "/", "/", "--bind", join(root, "source"), join(root, "mounted"), "--proc", "/proc", "--dev", "/dev", process.execPath, "--config=/dev/null", "--no-env-file", "-e", script], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, err).toBe(0);
    const result = JSON.parse(out);
    expect(result.errors, "STORAGE_BIND_MOUNT_REFUSED").toContainEqual({ rootId: "odysseus", reason: "mount-boundary" });
    expect(result.entries.some((entry: {path:string}) => entry.path === "mounted/Troy.pdf")).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
