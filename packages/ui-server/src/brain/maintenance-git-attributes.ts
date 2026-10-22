/**
 * Fixed attributes freeze, run once inside the credential-free maintenance
 * worker. It writes the empty tree and every attributes blob and tree through
 * the same frozen Git adapter the host used to ask for one launch per object.
 * The caller supplies only the adapter entry; stdin holds the collected
 * `.gitattributes` paths and bytes. Prints the root tree's object name.
 */
export {};
type AttributeTree = { data?: string; children: Map<string, AttributeTree> };
const entry = process.argv[2];
if (!entry || process.argv.length !== 3) throw Error("Git attributes freeze needs only the frozen adapter entry");
const input: unknown = JSON.parse(await Bun.stdin.text());
if (!Array.isArray(input) || input.some(item => !item || typeof item !== "object" || Object.keys(item).sort().join(",") !== "data,path"
  || typeof item.path !== "string" || typeof item.data !== "string")) throw Error("Malformed Git attributes freeze input");
function git(args: string[], stdin: string): string {
  const child = Bun.spawnSync([process.execPath, "--config=/dev/null", "--no-env-file", entry!, ...args], { stdin: Buffer.from(stdin), stdout: "pipe", stderr: "pipe" });
  const oid = child.stdout.toString();
  if (child.exitCode !== 0 || !/^[a-f0-9]{40,64}\n?$/.test(oid)) {
    process.stderr.write(child.stderr);
    process.exit(child.exitCode || 1);
  }
  return oid.trim();
}
const root: AttributeTree = { children: new Map() };
for (const attribute of input as { path: string; data: string }[]) {
  let node = root;
  for (const part of attribute.path.split("/").slice(0, -1)) {
    if (!node.children.has(part)) node.children.set(part, { children: new Map() });
    node = node.children.get(part)!;
  }
  node.data = attribute.data;
}
const EMPTY_TREE = git(["mktree", "-z"], "");
function freeze(node: AttributeTree): string {
  const rows: string[] = [];
  if (node.data !== undefined) rows.push(`100644 blob ${git(["hash-object", "-w", "--stdin", "--no-filters"], node.data)}\t.gitattributes\0`);
  for (const [name, child] of node.children) { const oid = freeze(child); if (oid !== EMPTY_TREE) rows.push(`040000 tree ${oid}\t${name}\0`); }
  return rows.length ? git(["mktree", "-z"], rows.join("")) : EMPTY_TREE;
}
process.stdout.write(`${freeze(root)}\n`);
