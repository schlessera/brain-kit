/** The standalone daily activity-digest job. Failures are deliberately loud. */
import { generateActivityDigest } from "../activity/digest.js";
import { createUiDb } from "../db/client.js";

interface TextSink {
  write(text: string): unknown;
}

export interface DigestOptions {
  dbPath: string;
  stdout?: TextSink;
  stderr?: TextSink;
}

export interface DigestDependencies {
  createDb?: typeof createUiDb;
  generateDigest?: typeof generateActivityDigest;
}

/** Generate and persist one digest, returning a process-compatible status. */
export function runDigest(
  options: DigestOptions,
  dependencies: DigestDependencies = {}
): number {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const openDb = dependencies.createDb ?? createUiDb;
  const generate = dependencies.generateDigest ?? generateActivityDigest;
  let db: ReturnType<typeof createUiDb> | undefined;

  try {
    db = openDb(options.dbPath);
    const digest = generate(db);
    stdout.write(
      `[brain-digest] generated: ${digest.runs} runs, ${digest.failures} failures, $${digest.costUsd.toFixed(2)}\n`
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`[brain-digest] failed: ${message}\n`);
    return 1;
  } finally {
    db?.close();
  }
}
