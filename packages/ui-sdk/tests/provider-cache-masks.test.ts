/**
 * The committed generated-text caches a masked turn's worker reads as empty:
 * `.brain-cache/` as one directory while any folder is masked (#2725), and a
 * legacy root-level cache as a file on every turn under a provider rule (#2692).
 */
import { afterEach, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEGACY_SIDECAR_CACHES } from "@schlessera/brain-common/internal/cache-location";
import { SIDECAR_CACHES } from "../../core/src/lib/cache-attributes.js";
import { PROVIDER_CACHE_DIR, PROVIDER_CACHE_FILES, providerMaskMounts } from "../src/server/worker-protection.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function brain() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-cache-masks-")); roots.push(root);
  const path = join(root, "brain"), index = join(root, "private-index");
  mkdirSync(join(path, ".brain-index"), { recursive: true }); mkdirSync(join(path, "me")); mkdirSync(index);
  return { path, index };
}

test("the masked cache directory holds core's committed caches, and the masked files are core's legacy names", () => {
  expect(SIDECAR_CACHES.every(path => path.startsWith(`${PROVIDER_CACHE_DIR}/`)), "CORE_WRITES_INTO_THE_MASKED_DIRECTORY").toBe(true);
  expect([...PROVIDER_CACHE_FILES], "LEGACY_LIST_MATCHES_CORE").toEqual(LEGACY_SIDECAR_CACHES.map(pair => pair.legacy));
});

test("a masked turn sees an empty read-only tmpfs over .brain-cache/; a turn allowed every folder sees the real one", () => {
  const b = brain();
  mkdirSync(join(b.path, ".brain-cache")); writeFileSync(join(b.path, ".brain-cache/contexts.jsonl"), "{}\n");
  const masked = providerMaskMounts(b.path, b.path, { folders: ["me"], index: b.index });
  expect(masked.join(" "), "CACHE_DIRECTORY_MASKED").toContain(`--tmpfs ${join(b.path, ".brain-cache")} --remount-ro ${join(b.path, ".brain-cache")}`);
  expect(masked.join(" "), "NO_FILE_MASK_INSIDE_THE_DIRECTORY").not.toContain("contexts.jsonl");
  expect(providerMaskMounts(b.path, b.path, { folders: [] }), "ALLOWED_TURN_KEEPS_THE_CACHES").toEqual([]);
  rmSync(join(b.path, ".brain-cache"), { recursive: true });
  expect(providerMaskMounts(b.path, b.path, { folders: ["me"], index: b.index }).join(" "), "ABSENT_DIRECTORY_LEFT_ALONE").not.toContain(".brain-cache");
});

test.each(["symlink", "file"] as const)("a .brain-cache that is a %s refuses the launch rather than being followed", kind => {
  const b = brain();
  if (kind === "symlink") symlinkSync("me", join(b.path, ".brain-cache"));
  else writeFileSync(join(b.path, ".brain-cache"), "{}\n");
  expect(() => providerMaskMounts(b.path, b.path, { folders: ["me"], index: b.index }), "ALIASED_CACHE_DIRECTORY_REFUSED").toThrow(".brain-cache must be a directory to be masked");
});

test("each present legacy cache is bound to /dev/null on every provider-rule turn; an absent one is left alone", () => {
  const b = brain();
  writeFileSync(join(b.path, ".context-cache.jsonl"), "{}\n");
  for (const masks of [{ folders: ["me"], index: b.index }, { folders: [] }]) {
    const argv = providerMaskMounts(b.path, b.path, masks);
    expect(argv.join(" "), `PRESENT_LEGACY_CACHE_MASKED ${masks.folders.length}`).toContain(`--ro-bind /dev/null ${join(b.path, ".context-cache.jsonl")}`);
    expect(argv.join(" ")).not.toContain(".asset-cache.jsonl");
  }
});

test.each(["symlink", "hardlink"] as const)("a %s legacy cache refuses the launch rather than being followed", kind => {
  const b = brain();
  writeFileSync(join(b.path, "me/cache.jsonl"), "{}\n");
  if (kind === "symlink") symlinkSync("me/cache.jsonl", join(b.path, ".asset-cache.jsonl"));
  else linkSync(join(b.path, "me/cache.jsonl"), join(b.path, ".asset-cache.jsonl"));
  expect(() => providerMaskMounts(b.path, b.path, { folders: ["me"], index: b.index }), "ALIASED_CACHE_REFUSED").toThrow("must be a regular file with one link");
});
