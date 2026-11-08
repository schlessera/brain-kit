/** Re-census and rule-based classification of real-time waits for #3332.
 *
 *   bun classify-waits.ts <source-sha> <baseline-files.tsv> > wait-census-<sha>.tsv
 *
 * Runs the docs/process/test-waits.md census expression at <source-sha>, keeps
 * only files that do not match at the #1849 inventory source (the baseline TSV's
 * `file` column), and gives every matching line a role and a verdict from its
 * own text plus a small window of the surrounding source. The rules are listed
 * in RULES below, in the order they are tried; the first match wins. */
const [sha, baselineTsv] = Bun.argv.slice(2);
if (!sha || !baselineTsv) throw new Error("usage: classify-waits.ts <sha> <baseline-files.tsv>");

const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString();
};
const PATTERN = "setTimeout|Bun.sleep|waitForTimeout|sleep\\(";
const grep = git("grep", "-n", "-E", PATTERN, sha, "--", "tests", "experiments", ":(glob)packages/*/tests/**");
const baseline = new Set((await Bun.file(baselineTsv).text()).trim().split("\n").slice(1).map(l => l.split("\t")[1]));

type Row = { file: string; line: number; text: string; via?: string };
const rows: Row[] = [];
for (const raw of grep.trim().split("\n")) {
  const m = raw.match(/^[^:]+:([^:]+):(\d+):(.*)$/);
  if (!m) throw new Error(`unparsed: ${raw}`);
  if (!baseline.has(m[1]!)) rows.push({ file: m[1]!, line: Number(m[2]), text: m[3]! });
}

const sources = new Map<string, string[]>();
const lines = (file: string) => {
  let s = sources.get(file);
  if (!s) { s = git("show", `${sha}:${file}`).split("\n"); sources.set(file, s); }
  return s;
};

// Follow timer aliases the census expression cannot see (`setTimeout as pause`)
// to their call sites, as test-waits.md requires for named aliases.
for (const r of [...rows]) {
  const alias = r.text.match(/\bsetTimeout\s+as\s+(\w+)/)?.[1];
  if (!alias) continue;
  lines(r.file).forEach((text, i) => {
    if (i + 1 !== r.line && new RegExp(`\\b${alias}\\(`).test(text)) rows.push({ file: r.file, line: i + 1, text, via: alias });
  });
}
rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

const domain = (file: string) =>
  file.startsWith("experiments/") ? "experiment"
  : /\/tests\/browser\/|\.offline\.tsx$|\.layout\.tsx$|\/tests\/visual\//.test(file) ? "browser"
  : /-runtime\.test\.ts$/.test(file) ? "runtime"
  : /\/fixtures\/|\/helpers\//.test(file) ? "fixture"
  : "default";

const NEGATIVE = /\.not\.|toBe\((false|0|null|undefined|"waiting"|"running"|"pending")\)|toBeNull\(\)|toBeUndefined\(\)|toBeFalse\(\)|toEqual\(\[\]\)|toHaveLength\(0\)|toBe\((frozen|ended|before|size|count|calls|sent|initial)\)/;
const WAIT_CALL = /Bun\.sleep\(|waitForTimeout\(|setTimeout\(\s*(resolve|r|res|done)\s*,|\bsleep\(/;
const ms = (text: string): number | null => {
  const m = text.match(/(?:Bun\.sleep|waitForTimeout|sleep)\(\s*([\d_]+)\s*\)|setTimeout\(\s*\w+\s*,\s*([\d_]+)\s*\)/);
  const v = m?.[1] ?? m?.[2];
  return v === undefined ? null : Number(v.replace(/_/g, ""));
};

/** Whether the first timer call on the line sits inside a string or template
 * literal that opens on the same line (embedded child source or fixture text). */
const insideString = (text: string): boolean => {
  const at = text.search(/Bun\.sleep|setTimeout|sleep\(/);
  let quote: string | null = null;
  for (let i = 0; i < at; i++) {
    const c = text[i]!;
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; }
    else if (c === "`" || c === "'" || c === '"') quote = c;
  }
  return quote !== null;
};

type Verdict = "not-a-wait" | "justified" | "replaceable";
interface Rule { role: string; verdict: Verdict; reason: string; test: (r: Row, ctx: { before: string; after: string; file: string[] }) => boolean }

/** Ordered rules; the first that matches classifies the line. */
const RULES: Rule[] = [
  { role: "timer-under-test", verdict: "justified", reason: "The file tests a clock or timer contract; its timers are the subject of the assertions, not waits (reviewed file).",
    test: r => r.file === "packages/core/tests/contract-clock.test.ts" },
  { role: "embedded-child-hold", verdict: "justified", reason: "Line of a multi-line embedded child program (reviewed); the child holds until released or killed (fixture hold).",
    test: r => r.file === "packages/ui-sdk/tests/helpers/identity-control-fixture.ts" && /time\.sleep/.test(r.text) },
  { role: "non-js-fixture", verdict: "justified", reason: "Native child program held until the test releases or kills it; the process boundary is the behaviour under test (fixture hold).",
    test: r => !/\.(ts|tsx|js|mjs)$/.test(r.file) },
  { role: "comment", verdict: "not-a-wait", reason: "Comment or prose; no executable wait.",
    test: r => /^\s*(\/\/|\*|\/\*)/.test(r.text) },
  { role: "fixture-delay", verdict: "replaceable", reason: "Test double schedules a delayed effect on real time; an explicit release barrier or controlled clock can trigger it deterministically.",
    test: r => /mockImplementation.*await\s+Bun\.sleep\(\s*\d|await\s+Bun\.sleep\(\s*\d[\d_]*\s*\)\s*;\s*throw/.test(r.text) },
  { role: "timer-under-test", verdict: "justified", reason: "The timer is the subject of the assertion (ownership, unref or cleanup accounting); it is cleared or unreferenced, never awaited.",
    test: r => /setTimeout\(.*\)\.unref\(\)/.test(r.text) },
  { role: "timer-instrumentation", verdict: "not-a-wait", reason: "Type reference, descriptor capture/restore, fake-timer installation or spy on the timer API; it controls time rather than spending it.",
    test: r => /typeof\s+(globalThis\.|window\.)?setTimeout|getOwnPropertyDescriptor\([^)]*setTimeout|defineProperty\([^)]*setTimeout|useFakeTimers|toFake|spyOn\([^)]*setTimeout|=\s*(globalThis|window)\.setTimeout\s*[;,]|(globalThis|window)\.setTimeout\s*=|\bas typeof\b|["']setTimeout["']\s*[:,\]]|\bsetTimeout\s*:\s*\(|mockImplementation|setTimeout\.bind|=\s*setTimeout\s*[;,]|\.setTimeout\s*;|=\s*Bun\.sleep\s*[;,]/.test(r.text) },
  { role: "production-timeout-config", verdict: "not-a-wait", reason: "Calls a production object's own setTimeout configuration (socket idle timeout), not the global timer.",
    test: r => /\b(?!globalThis\b|window\b|Bun\b)\w+(\[\d+\]!?)?\.setTimeout\(/.test(r.text) },
  { role: "timer-under-test", verdict: "justified", reason: "The timer is the subject of the assertion (ownership, unref or cleanup accounting); it is cleared or unreferenced, never awaited.",
    test: r => /setTimeout\(\s*original\w*\s*,/.test(r.text) },
  { role: "embedded-child-hold", verdict: "justified", reason: "Wait inside an embedded child program's source; the child holds until released or killed and the test measures actual lifetime (fixture hold).",
    test: r => insideString(r.text) || (r.text.match(/`/g)?.length ?? 0) % 2 === 1 || /\$\{JSON\.stringify/.test(r.text) || /while True|while\s*\(\s*true\s*\)\s*await|sleep\([^)]*\)`/.test(r.text) },
  { role: "worker-fixture-hold", verdict: "justified", reason: "A fixture worker or owner process holds for a long interval until the test cancels or kills it; the advertised sleep is a ceiling, not spent time (fixture hold).",
    test: r => /\/(fixtures|helpers)\//.test(r.file) && (ms(r.text) ?? 0) >= 5000 && /await\s+Bun\.sleep/.test(r.text) },
  { role: "event-loop-yield", verdict: "justified", reason: "Zero- or one-millisecond macrotask yield; no wall-clock observation window.",
    test: r => { const v = ms(r.text); return v !== null && v <= 1 && !/while|for\s*\(/.test(r.text); } },
  { role: "condition-poll", verdict: "justified", reason: "Polls a named condition and exits on it; the interval is latency granularity and any deadline is a failure maximum.",
    test: (r, c) => /\bwhile\b|\bfor\s*\(|\bdo\s*\{/.test(r.text) || (/\bwhile\b|\bfor\s*\(|\bdo\s*\{/.test(c.before.split("\n").slice(-2).join("\n")) && /break|return|deadline|Date\.now|performance\.now|existsSync|\}\s*while/.test(c.after + c.before)) },
  { role: "negative-race", verdict: "justified", reason: "Races a pending operation against a short window and asserts it is still pending; a real negative observation of native/admission work. Needs its reason stated next to the test.",
    test: (r, c) => /Promise\.race/.test(r.text) && /\.then\(\s*\(\)\s*=>\s*["'](waiting|running|pending|blocked|held|still)/.test(r.text) },
  { role: "auto-release-cap", verdict: "justified", reason: "Releases or stops a held fixture if the test never does; the cap is cleared on the normal path (failure maximum).",
    test: r => /setTimeout\(\s*[\w.]*\b(release|stop|kill)\w*\s*,/.test(r.text) },
  { role: "negative-race", verdict: "justified", reason: "A timer resolves a sentinel that the test asserts against a pending operation; a real negative observation. Needs its reason stated next to the test.",
    test: r => /setTimeout\(\s*\(\)\s*=>\s*(resolve|report)\(\s*["'](still|open|pending|waiting)/.test(r.text) },
  { role: "negative-window", verdict: "justified", reason: "Holds the child a short window after its stdio ends, to prove completion follows EOF rather than exit. Justified with that native opportunity stated next to the test.",
    test: r => /\.then\(\s*\(\)\s*=>\s*Bun\.sleep\(\s*\d+\s*\)\s*\)\.then\(\s*\w+\.release\s*\)/.test(r.text) },
  { role: "event-loop-liveness-window", verdict: "justified", reason: "Counts event-loop ticks during a real interval while a worker step runs; elapsed real time is the measured input (reviewed).",
    test: r => /ticksDuringRequests/.test(r.text) },
  { role: "failure-maximum", verdict: "justified", reason: "Deadline on an operation that should complete; the losing branch costs nothing on success (failure maximum).",
    test: r => /abort\(\)|\.kill\(|reject\(|Promise\.race|watchdog|deadline|timed out|did not|throw|\.unref\(\)|clearTimeout/.test(r.text) },
  { role: "alias-import", verdict: "not-a-wait", reason: "Imports a timer under another name; its call sites are added to the census as `via` rows and classified there.",
    test: r => /\bsetTimeout\s+as\s+\w+/.test(r.text) },
  { role: "helper-definition", verdict: "not-a-wait", reason: "Defines a sleep alias; its callers are classified at their call sites only when they match the census expression.",
    test: r => /(const|let|function)\s+\w+\s*=?\s*(async\s*)?\(?\s*\w*\s*(:\s*number)?\s*\)?\s*(=>|\{).*(setTimeout\(\s*\w+\s*,\s*\w+\s*\)|Bun\.sleep\(\s*[a-z]\w*\s*\))/.test(r.text) },
  { role: "timer-handle", verdict: "not-a-wait", reason: "Declares or stores a timer handle; the wait it belongs to is classified where it is armed.",
    test: r => /^\s*(let|const|var)?\s*\w+\??\s*:\s*[^=]*setTimeout[^=(]*;?\s*$|new Set<|Map</.test(r.text) },
  { role: "blocking-work-fixture", verdict: "justified", reason: "Synchronous sleep that simulates blocking work in a worker or fixture; the blocked event loop is the behaviour under test.",
    test: r => /sleepSync/.test(r.text) },
  { role: "fixture-delay", verdict: "replaceable", reason: "Test double schedules a delayed effect on real time; an explicit release barrier or controlled clock can trigger it deterministically.",
    test: r => /setTimeout\(\s*(\(\)|async\s*\(\)|function)/.test(r.text) && !/await new Promise/.test(r.text) },
  { role: "fixture-delay", verdict: "replaceable", reason: "A stub injects real latency inside its own body (conditional, counted or before returning); an explicit release barrier makes the ordering deterministic.",
    test: r => WAIT_CALL.test(r.text) && /^\s*(if\s*\(|.*\breturn\b|.*\+\+|.*\.push\()/.test(r.text) },
  { role: "timer-under-test", verdict: "justified", reason: "The timer is the subject of the assertion (ownership, unref or cleanup accounting); it is cleared or unreferenced, never awaited.",
    test: r => /setTimeout\(\s*\(\)\s*=>\s*\{\s*fired\+\+/.test(r.text) },
  { role: "negative-window", verdict: "justified", reason: "Unconditional window followed by an absence/unchanged assertion: a real negative observation. Justified only with its native opportunity stated next to the test; otherwise a causal completion barrier replaces it.",
    test: (r, c) => WAIT_CALL.test(r.text) && NEGATIVE.test(c.after + r.text.slice(r.text.search(WAIT_CALL))) },
  { role: "settling-sleep", verdict: "replaceable", reason: "Unconditional settling sleep; await the operation whose completion matters (acknowledgement, saved state, rendered state, event).",
    test: r => WAIT_CALL.test(r.text) || /setTimeout\(/.test(r.text) },
];

const reasonNearby = (file: string[], line: number) =>
  file.slice(Math.max(0, line - 4), line).some(l => /^\s*(\/\/|\*|\/\*)/.test(l) || /\/\/ /.test(l));

const out = ["source\tfile\tline\tvia\tdomain\tms\trole\tverdict\tcomment_nearby\treason\ttext"];
const counts = new Map<string, number>();
for (const original of rows) {
  const r = original.via ? { ...original, text: original.text.replace(new RegExp(`\\b${original.via}\\(`, "g"), "sleep(") } : original;
  const file = lines(r.file);
  const ctx = { before: file.slice(Math.max(0, r.line - 4), r.line - 1).join("\n"), after: file.slice(r.line, r.line + 3).join("\n"), file };
  const rule = RULES.find(rule => rule.test(r, ctx));
  if (!rule) { console.error(`UNCLASSIFIED ${r.file}:${r.line}: ${r.text}`); continue; }
  const key = `${rule.verdict}\t${rule.role}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
  const text = original.text.trim().replace(/\t/g, " ").slice(0, 240);
  out.push([sha, r.file, r.line, original.via ?? "", domain(r.file), ms(r.text) ?? "", rule.role, rule.verdict, reasonNearby(file, r.line) ? "yes" : "no", rule.reason, text].join("\t"));
}
console.log(out.join("\n"));
for (const [k, v] of [...counts].sort()) console.error(`${v}\t${k}`);
console.error(`${rows.length} lines in ${new Set(rows.map(r => r.file)).size} files`);
