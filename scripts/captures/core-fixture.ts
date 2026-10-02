import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { notes } from "../../packages/ui-kit/fixtures/notes.ts";
import { REFERENCE_DATE } from "../../packages/ui-kit/fixtures/time.ts";
import { sha256 } from "./provenance.ts";

export async function createFixtureBrain(root: string, directory: string): Promise<void> {
  await mkdir(resolve(directory, "notes"), { recursive: true });
  await symlink(resolve(root, "node_modules"), resolve(directory, "node_modules"));
  await writeFile(resolve(directory, "brain.config.ts"), 'import {defineConfig} from "@schlessera/brain";\nexport default defineConfig({profile:{name:"Odysseus",cliTitle:"Odysseus’s notebook"}});\n');
  const raft = notes.find((note) => note.id === "note:raft");
  if (!raft?.excerpt) throw new Error("Shared Odysseus raft fixture is empty");
  await writeFile(resolve(directory, "notes/raft-reference.md"), `---\ntype: note\ntitle: The raft\nupdated: ${REFERENCE_DATE}\n---\n\n${raft.excerpt}\n`);
}

export async function captureSearchFixture(root: string, directory: string): Promise<Record<string, unknown>> {
  await createFixtureBrain(root, directory);
  const cli = async (args: string[]): Promise<unknown> => {
    const child = Bun.spawn([process.execPath, "--preload", resolve(root, "scripts/captures/clock.ts"), resolve(root, "packages/core/src/cli/brain.ts"), ...args, "--json"], {
      cwd: directory, env: { PATH: process.env.PATH ?? "", BRAIN_ROOT: directory, TZ: "Etc/GMT-2", XDG_BIN_HOME: resolve(directory, ".bin") },
      stdout: "pipe", stderr: "pipe", stdin: "ignore",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`capture-search-keyless: brain ${args[0]} failed (${code}): ${stderr}`);
    return JSON.parse(stdout);
  };
  const indexed = await cli(["index", "--force"]) as {total:number;chunks:number};
  if (!indexed.total || !indexed.chunks) throw new Error("capture-search-keyless: initial index has no documents or chunks");
  const content = "Raft supplies: timber, rope and fresh water for Odysseus’s crossing from Ogygia.";
  const added = await cli(["add", content, "--type", "note", "--title", "Raft supplies"]) as { path: string; indexed: boolean };
  if (!added.path || !added.indexed) throw new Error("capture-search-keyless: capture did not report a written and indexed note");
  if (added.path.startsWith("/") || added.path.split("/").includes("..")) throw new Error("capture-search-keyless: capture path escapes fixture brain");
  const markdown = await readFile(resolve(directory, added.path), "utf8");
  if (!markdown.includes(content)) throw new Error("capture-search-keyless: captured Markdown content is missing");
  const search = await cli(["search", "raft supplies", "--mode", "fts", "--rerank", "none"]) as { results: Array<{ path: string; snippet: string }> };
  const match = search.results.find((result) => result.path === added.path);
  if (!match?.snippet || !match.snippet.toLowerCase().includes("supplies")) throw new Error("capture-search-keyless: actual FTS result does not contain the captured note and matching text");
  return { index: indexed, add: added, search, markdown, markdown_sha256: sha256(markdown), mode: "fts", reference_date: REFERENCE_DATE };
}
