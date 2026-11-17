import { afterEach, expect, test } from "bun:test";
import { createUiDb } from "../src/db/client";
import { sourceAuthority, sourceAuthorityCurrent } from "../src/brain/reference-source-authority";
import { sourceWrites } from "../src/brain/reference-source-writes";

const repository = "https://github.com/odysseus/ithaca", at = Date.parse("2026-07-12T12:00:00Z");
const db = createUiDb(":memory:"), writes = sourceWrites(db);
afterEach(() => { db.exec("DELETE FROM reference_acquisitions; DELETE FROM reference_roots; DELETE FROM reference_sources; DELETE FROM reference_authority_fences;"); });

test("a repository observation fences every revision in just its own sharing domain", () => {
  const main = sourceAuthority(db, "public", repository, "main"), other = sourceAuthority(db, "public", repository, "return-home");
  const privateSource = sourceAuthority(db, "private:penelope", repository, "main");
  writes.sourceFence("public", repository, "", "odysseus-first-observation");
  expect(sourceAuthorityCurrent(db, main), "SHARED_REPOSITORY_FENCE_INVALIDATES_MAIN").toBe(false);
  expect(sourceAuthorityCurrent(db, other), "SHARED_REPOSITORY_FENCE_INVALIDATES_OTHER_REVISION").toBe(false);
  expect(sourceAuthorityCurrent(db, privateSource), "SHARED_FENCE_PRESERVES_OTHER_DOMAIN").toBe(true);
  const fresh = sourceAuthority(db, "public", repository, "main");
  expect(sourceAuthorityCurrent(db, fresh)).toBe(true);
  writes.sourceFence("public", repository, "main", "odysseus-missing-ref");
  expect(sourceAuthorityCurrent(db, fresh)).toBe(false);
  expect(sourceAuthorityCurrent(db, sourceAuthority(db, "public", repository, "return-home"))).toBe(true);
});

test("a canonical literal suffix is separate from its neighbor in shared authority", () => {
  const suffix = `${repository}.git`, expected = sourceAuthority(db, "public", suffix, "main");
  writes.sourceFence("public", repository, "", "odysseus-neighbor-observation");
  expect(sourceAuthorityCurrent(db, expected), "SHARED_AUTHORITY_RETAINS_LITERAL_SUFFIX").toBe(true);
  writes.sourceFence("public", suffix, "", "odysseus-suffix-observation");
  expect(sourceAuthorityCurrent(db, expected)).toBe(false);
});

test("the publication transaction refuses authority invalidated after submission", () => {
  writes.sourceStage("odysseus-root", "public", repository, "main", at);
  const expected = sourceAuthority(db, "public", repository, "main");
  writes.sourceFence("public", repository, "", "odysseus-newer-private-observation");
  expect(writes.sourcePublish("/srv/fixtures/view", "public", repository, "main", `${repository}.git`, "ithaca", "odysseus-root", "a".repeat(40), "refs/heads/main", null, at, undefined, expected),
    "PUBLICATION_COMMIT_RECHECKS_SHARED_AUTHORITY").toBe(false);
  expect(db.query("SELECT 1 FROM reference_sources").get()).toBeNull();
  const current = sourceAuthority(db, "public", repository, "main");
  expect(writes.sourcePublish("/srv/fixtures/view", "public", repository, "main", `${repository}.git`, "ithaca", "odysseus-root", "a".repeat(40), "refs/heads/main", null, at, undefined, current)).toBe(true);
});

test("the validation transaction cannot renew a durably invalidated or replaced source", () => {
  writes.sourceStage("odysseus-root", "public", repository, "main", at);
  writes.sourcePublish("/srv/fixtures/view", "public", repository, "main", `${repository}.git`, "ithaca", "odysseus-root", "a".repeat(40), "refs/heads/main", null, at);
  const expected = sourceAuthority(db, "public", repository, "main");
  writes.sourceFence("public", repository, "", "odysseus-unknown-metadata"); writes.sourceSuspend("public", repository, "main");
  expect(writes.sourceValidate(at + 1, at + 1, "refs/heads/main", "public", repository, "main", expected, "odysseus-root"),
    "VALIDATION_COMMIT_RECHECKS_SHARED_AUTHORITY").toBe(false);
  expect(db.query("SELECT validated_at FROM reference_sources").get()).toEqual({ validated_at: 0 });
  const fresh = sourceAuthority(db, "public", repository, "main");
  expect(writes.sourceValidate(at + 1, at + 1, "refs/heads/main", "public", repository, "main", fresh, "telemachus-root"), "VALIDATION_COMMIT_RETAINS_ROOT_BINDING").toBe(false);
  expect(writes.sourceValidate(at + 1, at + 1, "refs/heads/main", "public", repository, "main", fresh, "odysseus-root")).toBe(true);
});


test("a committed fence atomically expires matching validation across aliases and revisions", () => {
  const cases = [["public", repository, "main"], ["public", "https://github.com/Odysseus/Ithaca", "return-home"],
    ["public", `${repository}.git`, "main"], ["private:penelope", repository, "main"]];
  for (const [domain, key, revision] of cases) {
    const id = `${domain}:${key}:${revision}`;
    writes.sourceStage(id!, domain!, key!, revision!, at);
    writes.sourcePublish("/srv/fixtures/view", domain!, key!, revision!, `${key}.git`, "ithaca", id, "a".repeat(40), `refs/heads/${revision}`, null, at);
  }
  writes.sourceFence("public", repository, "", "odysseus-crash-after-commit");
  const rows = db.query("SELECT domain, repository, validated_at FROM reference_sources").all() as { domain: string; repository: string; validated_at: number }[];
  for (const row of rows) expect(row.validated_at, "FENCE_COMMIT_CANNOT_LEAVE_OLD_POSITIVE_VALIDATION")
    .toBe(row.domain === "public" && row.repository !== `${repository}.git` ? 0 : at);
});
