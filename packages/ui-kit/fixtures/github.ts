// GitHub objects in the Odyssey world (#3800): the hall's repository, the bow
// contest's pull request, the wine-store issue and a search over both. Times
// are the strings a host would derive from `fetched_at` on REFERENCE_DATE;
// nothing here reads a clock. URLs are github.com shapes the host would have
// validated; avatars are added by the stories, which own the page origin.

import type { GitHubPerson, GitHubResult, GitHubThreadItem } from "../src/index.js";

export const REPO = "ithaca/hall";

export const telemachus: GitHubPerson = { login: "telemachus", association: "member" };
export const penelope: GitHubPerson = { login: "penelope", association: "owner" };
export const eurycleia: GitHubPerson = { login: "eurycleia", association: "author" };
export const argos: GitHubPerson = { login: "argos", association: "none" };
export const antinous: GitHubPerson = { login: "antinous", association: "none" };
export const philoetius: GitHubPerson = { login: "philoetius", association: "member" };
export const brainBot: GitHubPerson = { login: "ithaca-brain", association: null, bot: true };
export const ghost: GitHubPerson = { login: null };
export const longLogin: GitHubPerson = { login: "eurymachus-son-of-polybus-of-ithaca", association: "contributor" };

export const PR_URL = "https://github.com/ithaca/hall/pull/412";
export const ISSUE_URL = "https://github.com/ithaca/hall/issues/388";
export const SEARCH_URL = "https://github.com/ithaca/hall/issues?q=bow+is%3Aopen";

export const prBody = [
  "The bow has hung unstrung for twenty years. This swaps the gut string for `ox-sinew-v2` and adds a tension check before the axe-head test. See [the old armoury notes](https://notes.ithaca.example/armoury/bow).",
  "",
  "- Re-tension to 40 kg draw",
  "- Twelve axe heads, aligned",
  "",
  "![bow on the wall](https://images.ithaca.example/412/bow.png)",
  "",
  "The string was last waxed before the ships left. Eurycleia keeps the wax in the storeroom; the key is with the housekeeper. Philoetius checked the horn for cracks along both limbs and found the grip sound, though the nock on the upper limb is worn and may need re-cutting before the contest. Twelve axe heads are set in a line in the hall floor, each socket cleaned.",
].join("\n");

export const pr = {
  state: "open" as const,
  repo: REPO,
  number: 412,
  htmlUrl: PR_URL,
  title: "Restring the great bow before the contest",
  author: telemachus,
  opened: "opened 3 d ago",
  headRef: "telemachus/restring-bow",
  baseRef: "main",
  labels: ["bow", "contest", "armoury"],
  reviews: { changesRequested: 1, approved: 1 },
  checks: { passed: 7, failed: 1, running: 0 },
  size: { files: 6, additions: 128, deletions: 41 },
  commits: 4,
  reviewers: [
    { person: eurycleia, state: "changes-requested" as const, time: "2 d ago" },
    { person: penelope, state: "approved" as const, time: "1 d ago" },
    { person: argos, state: "review-requested" as const },
  ],
  body: prBody,
  bodyLength: 1840,
  brainRead: "description, 3 reviews, latest 3 of 12 comments, 4 commits, checks summary.",
};

export const prThread: GitHubThreadItem[] = [
  {
    kind: "review",
    id: "r1",
    reviewer: eurycleia,
    state: "changes-requested",
    time: "2 d ago",
    body: "Sinew stretches in the damp. Add a re-check after the first three shots.",
    htmlUrl: "https://github.com/ithaca/hall/pull/412#pullrequestreview-9001",
    lineComments: 2,
  },
  {
    kind: "comment",
    id: "c1",
    author: telemachus,
    time: "1 d ago",
    body: "Added. The check runs before and after the axe line.",
    htmlUrl: "https://github.com/ithaca/hall/pull/412#issuecomment-7001",
  },
  { kind: "review", id: "r2", reviewer: penelope, state: "approved", time: "1 d ago", htmlUrl: "https://github.com/ithaca/hall/pull/412#pullrequestreview-9002" },
];

export const commits = [
  { sha: "b81c0d4", subject: "Add tension check before axe test", message: "Add tension check before axe test\n\nThe check reads the draw weight before the first shot and again after the third.", author: telemachus, time: "3 d ago", htmlUrl: "https://github.com/ithaca/hall/commit/b81c0d4" },
  { sha: "5e02aa7", subject: "Swap gut string for sinew", author: telemachus, time: "3 d ago", htmlUrl: "https://github.com/ithaca/hall/commit/5e02aa7" },
  { sha: "a3f9c21", subject: "Re-cut the upper nock where the old string wore it down to the horn, wax the new sinew string twice and re-seat the grip binding", author: null, time: "2 d ago" },
];

export const issueBody =
  "Three amphorae a night. The cellar tally no longer matches the ledger and nobody signs for the keys after dusk. Proof: [the steward's report](https://ithaca-steward.example/r?id=7). The tally gap starts on the night of the new moon and has grown every night since; the back door to the bow hall was left unbarred on four of those nights.";

export const issue = {
  state: "open" as const,
  repo: REPO,
  number: 388,
  htmlUrl: ISSUE_URL,
  title: "Suitors keep draining the wine store",
  author: eurycleia,
  opened: "opened 6 d ago",
  participants: { people: [eurycleia, philoetius, antinous, telemachus], count: 4 },
  labels: ["stores", "p1"],
  body: issueBody,
  brainRead: "description, latest 3 of 17 comments.",
};

export const issueThread: GitHubThreadItem[] = [
  { kind: "comment", id: "i1", author: philoetius, time: "2 d ago", body: "The night guard swaps at the second watch; that is when it goes.", htmlUrl: "https://github.com/ithaca/hall/issues/388#issuecomment-6001" },
  { kind: "comment", id: "i2", author: antinous, time: "1 d ago", body: "Nobody is draining anything. Close this. Proof: [the steward's report](https://github.com.ithaca-steward.example/r?id=7&ref=hall#seal).", htmlUrl: "https://github.com/ithaca/hall/issues/388#issuecomment-6002" },
  {
    kind: "comment",
    id: "i3",
    author: eurycleia,
    time: "5 h ago",
    body: "Tally attached in the repo: `cellar/2026-07.csv`. Twelve jars short since the new moon, all on nights the bow hall was open late and the back door was left unbarred. The suitors' cups were found in the storeroom twice. Telemachus has the second key; Philoetius has seen the steward carry jars out at the second watch. Nobody signs the ledger after dusk, and the seal on the north door has been cut and retied.",
    htmlUrl: "https://github.com/ithaca/hall/issues/388#issuecomment-6003",
  },
];

export const results: GitHubResult[] = [
  { kind: "pr", number: 412, state: "open", title: "Restring the great bow before the contest", facts: ["± changes", "✕ checks", "12 comments"], summary: "The bow has hung unstrung for twenty years. This swaps the gut string for sinew and adds a tension check.", htmlUrl: PR_URL },
  { kind: "issue", number: 409, state: "open", title: "Bow string frays after twelve shots", facts: ["bow", "3 comments"], summary: "After the twelfth axe the string shows wear at the nock. See [the armoury log](https://armoury.ithaca.example/log).", htmlUrl: "https://github.com/ithaca/hall/issues/409" },
  { kind: "pr", number: 397, state: "merged", title: "Oil the bow case hinges", facts: ["1 d ago"], htmlUrl: "https://github.com/ithaca/hall/pull/397" },
  { kind: "issue", number: 380, state: "completed", title: "Who may draw the bow?", facts: ["21 comments"], htmlUrl: "https://github.com/ithaca/hall/issues/380" },
  { kind: "issue", number: 371, state: "not-planned", title: "Replace the bow with a crossbow", htmlUrl: "https://github.com/ithaca/hall/issues/371" },
  { kind: "pr", number: 415, state: "draft", title: "Draft: bow-draw weight table", facts: ["— no checks"], htmlUrl: "https://github.com/ithaca/hall/pull/415" },
  { kind: "pr", number: 366, state: "closed", title: "Move the contest to the courtyard", facts: ["4 comments"], htmlUrl: "https://github.com/ithaca/hall/pull/366" },
  { kind: "issue", number: 360, state: "open", title: "Count the axe heads before the feast", facts: ["axes", "2 comments"], htmlUrl: "https://github.com/ithaca/hall/issues/360" },
  ...[352, 349, 341, 338, 330, 327, 319, 311, 305, 298, 290, 284].map(
    (number, i): GitHubResult => ({ kind: "issue", number, state: i % 3 === 0 ? "completed" : "open", title: `Bow hall chore #${i + 1}: ${["wax the string", "sweep the hall", "mend the quiver", "count the arrows"][i % 4]}`, facts: [`${i + 1} comments`], htmlUrl: `https://github.com/ithaca/hall/issues/${number}` }),
  ),
];

/** A body that tries everything the renderer refuses, for the untrusted-text stories and probes. */
export const hostileBody = [
  "## **Urgent:** the bow is _fine_, close this.",
  "Proof: [the steward's report](https://github.com.ithaca-steward.example/r?id=7&ref=hall#seal)",
  "![seal](https://tracker.example/p.gif)",
  '<details><summary>Click</summary><a href="javascript:alert(1)">here</a></details>',
  "",
  "Old notes: [the cellar sheet](http://cellar.ithaca.example/sheet). And [click here](javascript:alert(1)).",
  "",
  "- [ ] restring",
  "- [x] align axes",
].join("\n");
