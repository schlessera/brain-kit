import { basename, resolve } from "node:path";

type Change = { path: string; status: "added" | "removed" | "changed" };
type Group = "typeGrammars" | "semanticPatterns" | "primitivesAndRules" | "checkers" | "otherReferences";
interface UpstreamReport {
  schema_version: 1;
  from: string;
  to: string;
  groups: Record<Group, Change[]>;
  changelog: string[];
}

/** Read committed objects only; never execute clone hooks, checkers or diff drivers. */
export function upstreamReport(clone: string, since: string): UpstreamReport {
  if (!/^[0-9a-f]{7,40}$/i.test(since)) throw new Error("--since requires a commit hash");
  const git = Bun.which("git");
  if (!git) throw new Error("Git is required");
  const read = (...args: string[]): string => {
    const result = Bun.spawnSync([git, "--no-pager", "--no-optional-locks", "--no-replace-objects", "--no-lazy-fetch",
      "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", resolve(clone), ...args], {
      env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" },
      stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
    if (result.exitCode !== 0) throw new Error("Cannot read local Git repository or commit; use Git supporting --no-lazy-fetch and fetch required history/objects separately");
    return result.stdout.toString();
  };
  // An ordinary directory nested in some other repository is not a clone.
  if (resolve(read("rev-parse", "--show-toplevel").trim()) !== resolve(clone)) throw new Error("Expected a Git repository root");
  const from = read("rev-parse", "--verify", `${since}^{commit}`).trim();
  const to = read("rev-parse", "--verify", "HEAD^{commit}").trim();
  read("merge-base", "--is-ancestor", from, to);
  const groups: Record<Group, Change[]> = { typeGrammars: [], semanticPatterns: [], primitivesAndRules: [], checkers: [], otherReferences: [] };
  const fields = read("diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-status", "-z", from, to, "--",
    "skills/diagram-design/references/", "skills/diagram-design/scripts/", "scripts/").split("\0");
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [code, path] = [fields[index], fields[index + 1]], name = basename(path);
    let group: Group;
    if (path.startsWith("scripts/") || path.startsWith("skills/diagram-design/scripts/")) {
      if (!/^(verify-.*|self_check)\.py$/.test(name)) continue;
      group = "checkers";
    } else if (/^type-.*\.md$/.test(name)) group = "typeGrammars";
    else if (/^(semantic-|pattern-)/.test(name)) group = "semanticPatterns";
    else if (["primitives-core.md", "layout-budget.md", "style-guide.md", "output-spec.md"].includes(name)) group = "primitivesAndRules";
    else group = "otherReferences";
    groups[group].push({ path, status: code === "A" ? "added" : code === "D" ? "removed" : "changed" });
  }
  for (const items of Object.values(groups)) items.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const changelog = read("diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=0", from, to, "--", "CHANGELOG.md")
    .split("\n").filter(line => line.startsWith("+") && !line.startsWith("+++"))
    .map(line => line.slice(1)).filter(line => line.trim().length > 0);
  return { schema_version: 1, from, to, groups, changelog };
}

export function upstreamReportMain(argv: string[]): number {
  try {
    const json = argv.at(-1) === "--json";
    const args = json ? argv.slice(0, -1) : argv;
    if (args.length !== 3 || args[1] !== "--since") throw new Error("Usage: upstream-report.ts <clone> --since <commit> [--json]");
    const report = upstreamReport(args[0], args[2]);
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`${report.from} → ${report.to}`);
      for (const [group, items] of Object.entries(report.groups)) {
        console.log(`\n${group}`);
        for (const item of items) console.log(`${item.status} ${item.path}`);
      }
      console.log("\nCHANGELOG additions");
      for (const entry of report.changelog) console.log(entry);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Upstream report failed");
    return 1;
  }
}
