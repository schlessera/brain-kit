/**
 * A minimal `gog schema --json` built from the committed snapshot, for the
 * fake gog's pin answers and the snapshot round trip: the real document is
 * 6 MB and comes from a real binary, which no test runs.
 */
import type { GogSchemaSnapshot } from "../../src/google/gog/commands.ts";

interface Node {
  type: string;
  name: string;
  flags: { name: string; type: string }[];
  positionals?: { name: string; type: string }[];
  subcommands?: Node[];
}

const flagList = (flags: Readonly<Record<string, string>>) => Object.entries(flags).map(([name, type]) => ({ name, type }));

export function schemaFromSnapshot(snapshot: GogSchemaSnapshot): {
  schema_version: number; build: string; automation: { exit_codes: Record<string, number> }; command: Node;
} {
  const root: Node = { type: "application", name: "gog", flags: flagList(snapshot.root_flags), subcommands: [] };
  for (const spec of Object.values(snapshot.commands)) {
    let node = root;
    for (const name of spec.path) {
      let next = node.subcommands?.find(child => child.name === name);
      if (!next) {
        next = { type: "command", name, flags: flagList(snapshot.root_flags), subcommands: [] };
        (node.subcommands ??= []).push(next);
      }
      node = next;
    }
    node.flags = [...flagList(snapshot.root_flags), ...flagList(spec.flags)];
    node.positionals = flagList(spec.positionals);
  }
  return { schema_version: snapshot.schema_version, build: snapshot.gog, automation: { exit_codes: { ...snapshot.exit_codes } }, command: root };
}
