// `scripts/sync-project.ts` end to end: `main()` with `runtime.gh` replaced by
// a fake GitHub that holds a board and a tracker in memory. Each test drives
// the real orchestration (arguments, scope check, enumeration, the sweep, the
// per-event path) and reads back the calls it made and the writes it did.

import { afterEach, describe, expect, test } from "bun:test";

import { REPOS, main, runtime } from "../scripts/sync-project.ts";

interface FakeIssue {
  repo: string;
  number: number;
  title?: string;
  body?: string;
  labels?: string[];
  state?: "open" | "closed";
  pr?: boolean;
}
interface FakeItem {
  id: string;
  url: string;
  Status?: string;
  Priority?: string;
  Track?: string;
}

const url = (repo: string, n: number) => `https://github.com/${repo}/issues/${n}`;
const option = (name: string) => ({ id: `opt-${name}`, name });
const FIELDS = [
  { id: "f-status", name: "Status", options: ["Backlog", "Ready", "In progress", "In review", "Done"].map(option) },
  { id: "f-priority", name: "Priority", options: ["P0", "P1", "P2", "P3"].map(option) },
  { id: "f-track", name: "Track", options: [option("Design system")] },
  { id: "f-size", name: "Size", options: ["XS", "S", "M", "L"].map(option) },
  { id: "f-start", name: "Start" },
  { id: "f-target", name: "Target" },
];

/** A board and a tracker behind the exact `gh` calls the script makes. */
class FakeGitHub {
  scopes = "project, read:org, repo";
  calls: string[][] = [];
  writes: string[] = [];
  comments = new Map<string, string[]>();
  constructor(
    public issues: FakeIssue[],
    public items: FakeItem[] = [],
    public prs: { repo: string; number: number; body: string }[] = [],
  ) {}

  private issue(repo: string, n: number) {
    return this.issues.find((i) => i.repo === repo && i.number === n);
  }
  private item(u: string) {
    return this.items.find((i) => i.url === u);
  }
  private open(repo: string) {
    return this.issues.filter((i) => i.repo === repo && (i.state ?? "open") === "open" && !i.pr);
  }
  private json(i: FakeIssue) {
    return { number: i.number, title: i.title ?? `#${i.number}`, url: url(i.repo, i.number), labels: (i.labels ?? []).map((name) => ({ name })), body: i.body ?? "" };
  }

  gh = async (args: string[]): Promise<string> => {
    this.calls.push(args);
    const [a, b] = args;
    const at = (flag: string) => args[args.indexOf(flag) + 1]!;
    if (a === "api" && b === "--include") return `HTTP/2.0 200 OK\r\nX-Oauth-Scopes: ${this.scopes}\r\n\r\n{}`;
    if (a === "project" && b === "list") return JSON.stringify({ projects: [{ number: 1, id: "P1", title: "brain-kit roadmap", url: "u" }] });
    if (a === "project" && b === "link") return "";
    if (a === "project" && b === "field-list") return JSON.stringify({ fields: FIELDS });
    if (a === "project" && b === "item-list") {
      return JSON.stringify({
        items: this.items.map((i) => ({ id: i.id, status: i.Status, priority: i.Priority, track: i.Track, content: { url: i.url } })),
      });
    }
    if (a === "project" && b === "item-add") {
      const u = at("--url");
      const item = { id: `item-${this.items.length + 1}`, url: u };
      this.items.push(item);
      this.writes.push(`add ${u}`);
      return JSON.stringify({ id: item.id });
    }
    if (a === "project" && b === "item-edit") {
      const item = this.items.find((i) => i.id === at("--id"))!;
      const field = FIELDS.find((f) => f.id === at("--field-id"))!;
      const value = field.options!.find((o) => o.id === at("--single-select-option-id"))!.name;
      (item as unknown as Record<string, string>)[field.name] = value;
      this.writes.push(`set ${item.url} ${field.name}=${value}`);
      return "";
    }
    if (a === "issue" && b === "list") return JSON.stringify(this.open(at("--repo")).map((i) => this.json(i)));
    if (a === "pr" && b === "list") return JSON.stringify(this.prs.filter((p) => p.repo === at("--repo")).map((p) => ({ number: p.number, body: p.body })));
    if (a === "issue" && b === "edit") {
      const i = this.issue(at("--repo"), Number(args[2]))!;
      i.labels = (i.labels ?? []).filter((l) => l !== at("--remove-label"));
      this.writes.push(`unlabel ${at("--repo")}#${args[2]}`);
      return "";
    }
    if (a === "issue" && b === "comment") {
      const key = `${at("--repo")}#${args[2]}`;
      this.comments.set(key, [...(this.comments.get(key) ?? []), at("--body")]);
      this.writes.push(`comment ${key}`);
      return "";
    }
    if (a === "api" && b === "graphql") {
      const node = args.find((x) => x.startsWith("node="))!.slice(5);
      const [repo, n] = node.slice(2).split("#") as [string, string];
      const item = this.item(url(repo, Number(n)));
      const value = (name?: string) => (name ? { name } : null);
      return JSON.stringify({
        data: {
          user: { projectsV2: { nodes: [{ id: "P1", number: 1, title: "brain-kit roadmap", url: "u", fields: { nodes: FIELDS } }] } },
          node: {
            projectItems: {
              nodes: item ? [{ id: item.id, project: { id: "P1" }, status: value(item.Status), priority: value(item.Priority), track: value(item.Track) }] : [],
            },
          },
        },
      });
    }
    if (a === "api" && b === "--paginate") {
      const path = args[2]!;
      const blocked = /^repos\/(.+)\/issues\?state=open&labels=blocked/.exec(path);
      if (blocked) {
        return this.open(blocked[1]!)
          .filter((i) => i.labels?.includes("blocked"))
          .map((i) => JSON.stringify({ number: i.number, body: i.body ?? "" }))
          .join("\n");
      }
      const comments = /^repos\/(.+)\/issues\/(\d+)\/comments$/.exec(path);
      if (comments) return (this.comments.get(`${comments[1]}#${comments[2]}`) ?? []).map((c) => JSON.stringify(c)).join("\n");
    }
    if (a === "api" && b) {
      const sub = /^repos\/(.+)\/issues\/(\d+)\/sub_issues$/.exec(b);
      if (sub) return "";
      const pull = /^repos\/(.+)\/pulls\/(\d+)$/.exec(b);
      if (pull) return this.prs.find((p) => p.repo === pull[1] && p.number === Number(pull[2]))?.body ?? "";
      const one = /^repos\/(.+)\/issues\/(\d+)$/.exec(b);
      if (one) {
        const i = this.issue(one[1]!, Number(one[2]));
        if (!i) throw new Error(`gh: no issue ${b}`);
        if (args.includes("--jq")) return `${i.state ?? "open"}\n`;
        return JSON.stringify({
          ...this.json(i),
          html_url: url(i.repo, i.number),
          state: i.state ?? "open",
          node_id: `N_${i.repo}#${i.number}`,
          ...(i.pr ? { pull_request: {} } : {}),
        });
      }
    }
    throw new Error(`fake gh does not know: gh ${args.join(" ")}`);
  };
}

const KIT = "schlessera/brain-kit";
const saved = { ...runtime };
afterEach(() => Object.assign(runtime, saved));

/** Runs `main()` against a fake, capturing everything it printed. */
async function run(fake: FakeGitHub, argv: string[]) {
  const out: string[] = [];
  Object.assign(runtime, { gh: fake.gh, log: (l: string) => out.push(l), error: (l: string) => out.push(l) });
  const code = await main(["bun", "sync-project.ts", ...argv]);
  return { code, out };
}

describe("the full sweep", () => {
  test("never writes over a Status a person set, and still writes a derived one", async () => {
    const fake = new FakeGitHub(
      [
        { repo: KIT, number: 1, labels: ["agent-ready"] },
        { repo: KIT, number: 2, labels: ["agent-ready"] },
        { repo: KIT, number: 3, labels: ["agent-ready"] },
      ],
      [
        { id: "i1", url: url(KIT, 1), Status: "In progress" },
        { id: "i2", url: url(KIT, 2), Status: "Done" },
        { id: "i3", url: url(KIT, 3), Status: "Backlog" },
      ],
    );
    const { code } = await run(fake, ["--apply"]);
    expect(code).toBe(0);
    // #3 proves the run writes Status at all; #1 and #2 keep theirs.
    expect(fake.writes.filter((w) => w.includes(" Status="))).toEqual([`set ${url(KIT, 3)} Status=Ready`]);
  });

  test("lists issues and open PRs in exactly the three board repositories", async () => {
    const fake = new FakeGitHub([]);
    await run(fake, []);
    const listed = (verb: string) =>
      fake.calls.filter((c) => c[0] === verb && c[1] === "list").map((c) => c[c.indexOf("--repo") + 1]).sort();
    expect(listed("issue")).toEqual([...REPOS].sort());
    expect(listed("pr")).toEqual([...REPOS].sort());
    expect(listed("issue")).toHaveLength(3);
  });

  test("stops before any write, or any other call, when the token lacks read:org", async () => {
    const fake = new FakeGitHub([{ repo: KIT, number: 1, labels: ["agent-ready"] }], [{ id: "i1", url: url(KIT, 1), Status: "Backlog" }]);
    fake.scopes = "project, repo";
    const { code, out } = await run(fake, ["--apply"]);
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("`read:org`");
    expect(fake.calls).toEqual([["api", "--include", "user"]]);
    expect(fake.writes).toEqual([]);
  });
});

describe("the per-event path", () => {
  test("an open issue is swept", async () => {
    const fake = new FakeGitHub([{ repo: KIT, number: 5, labels: ["agent-ready"] }], [{ id: "i5", url: url(KIT, 5), Status: "Backlog" }]);
    const { code } = await run(fake, ["--apply", "--issue", `${KIT}#5`]);
    expect(code).toBe(0);
    expect(fake.writes).toEqual([`set ${url(KIT, 5)} Status=Ready`]);
  });

  test("a closed issue sweeps the issues it was blocking, which unblock", async () => {
    const fake = new FakeGitHub(
      [
        { repo: KIT, number: 9, state: "closed" },
        { repo: KIT, number: 10, labels: ["agent-ready", "blocked"], body: "Blocked by #9" },
      ],
      [{ id: "i10", url: url(KIT, 10), Status: "Backlog" }],
    );
    const { out } = await run(fake, ["--apply", "--issue", `${KIT}#9`]);
    expect(out).toContain(`skip ${KIT}#9: closed; syncing what it blocked: ${KIT}#10`);
    expect(fake.writes).toEqual([`comment ${KIT}#10`, `unlabel ${KIT}#10`, `set ${url(KIT, 10)} Status=Ready`]);
  });

  test("a target outside the board's repositories, or a pull request, is skipped without a write", async () => {
    const fake = new FakeGitHub([{ repo: KIT, number: 7, pr: true, labels: ["agent-ready"] }]);
    const outside = await run(fake, ["--apply", "--issue", "schlessera/brain-ui#29"]);
    expect(outside.out).toContain("skip schlessera/brain-ui#29: not an issue in the board's repositories");
    const pr = await run(fake, ["--apply", "--issue", `${KIT}#7`]);
    expect(pr.out).toContain(`skip ${KIT}#7: not an issue`);
    expect(fake.writes).toEqual([]);
    // Nothing was even read about the private repository.
    expect(fake.calls.some((c) => c.join(" ").includes("brain-ui"))).toBe(false);
  });

  test("a PR event sweeps the issues the PR closes, into In review", async () => {
    const fake = new FakeGitHub(
      [{ repo: KIT, number: 11, labels: ["agent-ready"] }],
      [{ id: "i11", url: url(KIT, 11), Status: "Ready" }],
      [{ repo: KIT, number: 40, body: "Closes #11" }],
    );
    await run(fake, ["--apply", "--pr", `${KIT}#40`]);
    expect(fake.writes).toEqual([`set ${url(KIT, 11)} Status=In review`]);
  });
});
