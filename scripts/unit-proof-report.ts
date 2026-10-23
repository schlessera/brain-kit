/** Verify Bun's actual reports against the independently discovered unit partition. */
const attribute = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

export function validateUnitReports(expected: readonly string[], xml: string, timings: unknown, allowEmpty = false) {
  const root = /<testsuites\b[^>]*>/.exec(xml)?.[0];
  if (!root) throw new Error("Unit proof wrote no JUnit totals");
  const count = (name: string) => {
    const raw = attribute(root, name);
    const value = Number(raw);
    if (raw === undefined || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid unit ${name} total`);
    return value;
  };
  const files: string[] = [];
  for (const [tag] of xml.matchAll(/<testsuite\b[^>]*>/g)) {
    const file = attribute(tag, "file");
    if (file !== undefined && attribute(tag, "name") === file && attribute(tag, "line") === undefined) files.push(file);
  }
  const compare = (label: string, actual: string[]) => {
    if (new Set(actual).size !== actual.length) throw new Error(`${label}: duplicate unit file`);
    const missing = expected.filter(file => !actual.includes(file));
    const unexpected = actual.filter(file => !expected.includes(file));
    if (missing.length || unexpected.length) throw new Error(`${label}: unit file coverage differs; missing=${missing.join(",")} unexpected=${unexpected.join(",")}`);
  };
  compare("JUnit", files);
  const timing = timings as { version?: unknown; files?: Record<string, unknown> } | null;
  if (timing?.version !== 1 || !timing.files || typeof timing.files !== "object" || Array.isArray(timing.files)) throw new Error("Invalid unit timing report");
  compare("timings", Object.keys(timing.files));
  if (Object.values(timing.files).some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new Error("Invalid unit file timing");
  const tests = count("tests"), failures = count("failures"), skippedAndTodo = count("skipped");
  // Bun marks todo explicitly, while the root skipped total includes both.
  const todo = [...xml.matchAll(/<skipped\b[^>]*\bmessage="TODO"[^>]*\/?\s*>/g)].length;
  if ((tests === 0 && (!allowEmpty || expected.length > 0)) || failures !== 0 || failures + skippedAndTodo > tests || todo > skippedAndTodo) throw new Error("Unit totals do not describe a passing execution");
  return { files: [...files].sort(), tests, pass: tests - failures - skippedAndTodo, skip: skippedAndTodo - todo, todo, failures };
}

/** Bun selects before sharding; counts plus distinct reconciled paths prove its union. */
export function validateChangedUnitReports(reports: readonly { xml: string; timings: unknown; selection: unknown }[]): string[] {
  if (!reports.length) throw new Error("Changed unit workers wrote no reports");
  let selected: number | undefined;
  const files = reports.flatMap(report => {
    const selection = report.selection as { selected?: number; assigned?: number } | null;
    if (!selection || !Number.isSafeInteger(selection.selected) || !Number.isSafeInteger(selection.assigned) ||
        selection.assigned! < 0 || selection.selected! < selection.assigned!) throw new Error("Invalid changed selection receipt");
    if (selected !== undefined && selection.selected !== selected) throw new Error("Unit workers disagree on Bun's changed-file selection");
    selected = selection.selected;
    const timings = report.timings as { files?: Record<string, unknown> } | null;
    const paths = Object.keys(timings?.files ?? {});
    if (paths.length !== selection.assigned) throw new Error("Unit shard report omits selected files");
    validateUnitReports(paths, report.xml, report.timings, true);
    return paths;
  });
  if (new Set(files).size !== files.length || files.length !== selected) throw new Error("Changed unit shards must cover Bun's selected files exactly once");
  return files.sort();
}
