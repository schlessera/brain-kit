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

test("publication commit cannot replace a newer root while authority versions remain valid", () => {
  const expected = sourceAuthority(db, "public", repository, "main");
  for (const id of ["odysseus-old-root", "telemachus-new-root"]) writes.sourceStage(id, "public", repository, "main", at);
  writes.sourcePublish("/srv/fixtures/view", "public", repository, "main", repository, "ithaca", "telemachus-new-root", "c".repeat(40), "refs/heads/main", null, at);
  expect(sourceAuthorityCurrent(db, expected)).toBe(true);
  expect(writes.sourcePublish("/srv/fixtures/view", "public", repository, "main", repository, "ithaca", "odysseus-old-root", "a".repeat(40), "refs/heads/main", null, at, undefined, expected, { rootId: null }),
    "PUBLICATION_TRANSACTION_PRESERVES_NEWER_ROOT").toBe(false);
  expect(db.query("SELECT root_id, commit_id FROM reference_sources").get()).toEqual({ root_id: "telemachus-new-root", commit_id: "c".repeat(40) });
});

test("a discarded staging identity cannot commit publication after native withdrawal", () => {
  const id = "odysseus-retired-staging";
  writes.sourceStage(id, "public", repository, "main", at);
  writes.sourceDiscard(id);
  expect(writes.sourcePublish("/srv/fixtures/view", "public", repository, "main", repository, "ithaca", id, "a".repeat(40), "refs/heads/main", null, at),
    "RETIRED_STAGING_TRANSACTION_CANNOT_RESURRECT_PUBLICATION").toBe(false);
  expect(db.query("SELECT 1 FROM reference_sources").get()).toBeNull();
});

test("managed expiry retires its root without cancelling an independent acquisition", () => {
  const expected = sourceAuthority(db, "public", repository, "main");
  for (const id of ["odysseus-expired-root", "telemachus-staging"]) writes.sourceStage(id, "public", repository, "main", at);
  writes.sourcePublish("/srv/fixtures/view", "public", repository, "main", repository, "ithaca", "odysseus-expired-root", "a".repeat(40), "refs/heads/main", null, at);
  const roots = writes.sourceFenceCurrent("public", repository, "main", "odysseus-expiry", "odysseus-expired-root", at, at, true);
  expect(roots?.map(root => root.id)).toEqual(["odysseus-expired-root"]);
  expect(sourceAuthorityCurrent(db, expected)).toBe(true);
  expect(writes.sourceValidate(at + 1, at + 1, "refs/heads/main", "public", repository, "main", expected, "odysseus-expired-root"), "RETIRED_EXPIRY_CANNOT_RENEW_OLD_ROOT").toBe(false);
  expect(writes.sourcePublish("/srv/fixtures/view", "public", repository, "main", repository, "ithaca", "telemachus-staging", "c".repeat(40), "refs/heads/main", null, at + 1, undefined, expected, { rootId: "odysseus-expired-root" })).toBe(true);
});
