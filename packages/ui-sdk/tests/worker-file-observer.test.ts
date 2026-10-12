import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkerFileObserver } from "../src/server/worker-file-observer";
import { NativeFileVersions } from "../src/server/native-file-versions";

const known = (text: string) => ({ status: "known" as const, hash: createHash("sha256").update(text).digest("hex") });
test("strict observations follow the actual frozen view and writable aliases rather than the newer canonical brain", () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-file-view-")), brain = join(root, "brain"), snapshot = join(root, "snapshot"), output = join(root, "output");
  for (const path of [brain, snapshot, output]) mkdirSync(path);
  try {
    writeFileSync(join(brain, "voyage.md"), "New canonical voyage.");
    writeFileSync(join(snapshot, "voyage.md"), "Frozen voyage.");
    symlinkSync(join(brain, "voyage.md"), join(snapshot, "absolute-link.md"));
    writeFileSync(join(output, "loom.md"), "Penelope weaves.");
    writeFileSync(join(snapshot, ".env"), "fictional-private-value");
    const observe = createWorkerFileObserver({ brain, configurationRoot: snapshot,
      areas: [{ worker: "/tmp/brain-worker-areas/loom", host: output, rel: "workspaces/loom" }], maskPaths: [join(brain, "masked")] });
    expect(observe("voyage.md")).toEqual({ key: "voyage.md", version: known("Frozen voyage.") });
    expect(observe("absolute-link.md")).toEqual({ key: "absolute-link.md", version: known("Frozen voyage.") });
    expect(observe("/tmp/brain-worker-areas/loom/loom.md")).toEqual({ key: "workspaces/loom/loom.md", version: known("Penelope weaves.") });
    writeFileSync(join(output, "loom.md"), "Penelope sleeps.");
    expect(observe("/tmp/brain-worker-areas/loom/loom.md")?.version).toEqual(known("Penelope sleeps."));
    expect(observe(".env")?.version).toEqual(known(""));
    expect(observe("masked/secret.json")?.version).toEqual(known(""));
    symlinkSync(join(root, "outside"), join(snapshot, "escape.md"));
    writeFileSync(join(root, "outside"), "Outside the view.");
    expect(observe("escape.md")).toBeUndefined();
    expect(observe("missing.md")?.version).toEqual({ status: "missing" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a changing or failed read never teaches a later writer an unobserved version", () => {
  const versions = new NativeFileVersions();
  const a = known("Penelope weaves.") as { status: "known"; hash: string }, b = known("Penelope sleeps.") as typeof a;
  expect(versions.check("loom.md", b)).toBeNull();
  versions.beginRead("read", "loom.md", a); versions.finishRead("read", b, true);
  expect(versions.check("loom.md", b)).toContain("changed since you read it");
  versions.beginRead("reread", "loom.md", b); versions.finishRead("reread", b, true);
  expect(versions.check("loom.md", b)).toBeNull();
  versions.beginRead("failed", "loom.md", a); versions.finishRead("failed", a, false);
  expect(versions.check("loom.md", a)).toContain("changed since you read it");
  expect(versions.check("loom.md", b)).toBeNull();
});
