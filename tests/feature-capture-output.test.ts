import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { outputDirectory } from "../scripts/captures/provenance.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "brain-capture-output-"));
  roots.push(root);
  await mkdir(join(root, "packages/ui-kit/tests/visual/__screenshots__"), { recursive: true });
  return root;
}

test("capture output cannot write into an empty regression directory", async () => {
  const root = await fixture();
  await expect(outputDirectory(root, "packages/ui-kit/tests/visual/__screenshots__")).rejects.toThrow("outside the regression baselines");
  expect(await readdir(join(root, "packages/ui-kit/tests/visual/__screenshots__"))).toEqual([]);
});

test("a symlink does not disguise the regression directory", async () => {
  const root = await fixture();
  await symlink(join(root, "packages/ui-kit/tests/visual/__screenshots__"), join(root, "editorial"));
  await expect(outputDirectory(root, "editorial")).rejects.toThrow("outside the regression baselines");
  expect(await readdir(join(root, "packages/ui-kit/tests/visual/__screenshots__"))).toEqual([]);
});

test("an unrelated output directory retains its original files", async () => {
  const root = await fixture();
  await mkdir(join(root, "unrelated"));
  await writeFile(join(root, "unrelated/keep.txt"), "Odysseus keeps this note.");
  await expect(outputDirectory(root, "unrelated")).rejects.toThrow("already contains unrelated files");
  expect(await readdir(join(root, "unrelated"))).toEqual(["keep.txt"]);
});

test("selected captures can reuse only the managed output directory", async () => {
  const root = await fixture();
  const first = await outputDirectory(root, "tmp/feature-captures");
  await writeFile(join(first, "readme-chat-answer-dark.png"), "fixture artifact");
  expect(await outputDirectory(root, "tmp/feature-captures")).toBe(first);
  expect((await readdir(first)).sort()).toEqual([".brain-kit-feature-captures.json", "readme-chat-answer-dark.png"]);
});
