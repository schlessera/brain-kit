/** The committed generated-text caches a denied turn's worker reads as empty (#2692). */
import { afterEach, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SIDECAR_CACHES } from "../../core/src/lib/cache-attributes.js";
import { PROVIDER_CACHE_FILES, providerMaskMounts } from "../src/server/worker-protection.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function brain() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-cache-masks-")); roots.push(root);
  const path = join(root, "brain"), index = join(root, "private-index");
  mkdirSync(join(path, ".brain-index"), { recursive: true }); mkdirSync(join(path, "me")); mkdirSync(index);
  return { path, index };
}

test("the masked caches are exactly core's committed sidecar caches", () => {
  expect([...PROVIDER_CACHE_FILES], "CACHE_LIST_MATCHES_CORE").toEqual([...SIDECAR_CACHES]);
});

test("each present cache is bound to /dev/null; an absent one is left alone", () => {
  const b = brain();
  writeFileSync(join(b.path, ".context-cache.jsonl"), "{}\n");
  const argv = providerMaskMounts(b.path, b.path, { folders: ["me"], index: b.index });
  expect(argv.join(" "), "PRESENT_CACHE_MASKED").toContain(`--ro-bind /dev/null ${join(b.path, ".context-cache.jsonl")}`);
  expect(argv.join(" ")).not.toContain(".asset-cache.jsonl");
});

test.each(["symlink", "hardlink"] as const)("a %s cache refuses the launch rather than being followed", kind => {
  const b = brain();
  writeFileSync(join(b.path, "me/cache.jsonl"), "{}\n");
  if (kind === "symlink") symlinkSync("me/cache.jsonl", join(b.path, ".asset-cache.jsonl"));
  else linkSync(join(b.path, "me/cache.jsonl"), join(b.path, ".asset-cache.jsonl"));
  expect(() => providerMaskMounts(b.path, b.path, { folders: ["me"], index: b.index }), "ALIASED_CACHE_REFUSED").toThrow("must be a regular file with one link");
});
