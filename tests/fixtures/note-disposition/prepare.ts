// A throwaway brain for tests/process-command-proposals.test.ts: one source
// note and, when a target is given, one project document it could merge into.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { brainConfigSchema } from "../../../packages/core/src/lib/config";
import { buildTaxonomy } from "../../../packages/core/src/lib/taxonomy";

export interface NoteFixture {
  id: string;
  group: string;
  source: string;
  target: string | null;
}

export function prepare(f: NoteFixture) {
  const root = mkdtempSync(join(tmpdir(), "brain-note-disposition-"));
  const config = brainConfigSchema.parse({
    reranker: { enabled: false },
    taxonomy: { types: { project: { dir: "projects/active" }, ritual: { dir: "rituals" } } },
  });
  const taxonomy = buildTaxonomy({ user: config });
  const document = (path: string, type: string, body: string) => {
    const raw = `---\ntitle: ${f.id}\ntype: ${type}\nstatus: active\ncreated: 2026-07-12\nupdated: 2026-07-12\ntags: []\n---\n${body}\n`;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), raw);
    return { path, raw };
  };
  const source = document(`notes/${f.id}.md`, "note", f.source);
  const targets = f.target === null ? [] : [document(`projects/active/${f.group}.md`, "project", f.target)];
  return { env: { root, source, targets, taxonomy }, config, close: () => rmSync(root, { recursive: true, force: true }) };
}
