import { expect, test } from "bun:test";
import { closeSync, openSync, readFileSync } from "node:fs";
import { vanishedProcess } from "./helpers/vanished-process";

const errno = (code: string) => Object.assign(new Error(code), { code });

test("a procfs read of a process that is gone counts as absent, and any other error does not", () => {
  expect(vanishedProcess(errno("ENOENT")), "EXITED_BEFORE_OPEN_IS_ABSENT").toBe(true);
  expect(vanishedProcess(errno("ESRCH")), "REAPED_AFTER_OPEN_IS_ABSENT").toBe(true);
  expect(vanishedProcess(errno("EACCES")), "OTHER_READ_ERRORS_STAY_ERRORS").toBe(false);
  expect(vanishedProcess(new Error("no code")), "UNCODED_ERRORS_STAY_ERRORS").toBe(false);
});

test("the kernel answers ESRCH for an opened /proc/<pid>/cmdline or stat whose process was reaped", async () => {
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
  const files = ["cmdline", "stat"].map(name => openSync(`/proc/${child.pid}/${name}`, "r"));
  try {
    child.kill("SIGKILL");
    await child.exited;
    for (const file of files) {
      let failure: unknown;
      try { readFileSync(file, "utf8"); } catch (error) { failure = error; }
      expect(failure, "THE_KERNEL_SUPPLIES_THE_REAL_PROCFS_RACE").toMatchObject({ code: "ESRCH" });
      expect(vanishedProcess(failure), "A_REAPED_PROCESS_READ_IS_ABSENT").toBe(true);
    }
    let fresh: unknown;
    try { readFileSync(`/proc/${child.pid}/cmdline`, "utf8"); } catch (error) { fresh = error; }
    expect(fresh, "A_FRESH_OPEN_SEES_AN_ABSENT_PATH").toMatchObject({ code: "ENOENT" });
    expect(vanishedProcess(fresh), "AN_ABSENT_PATH_IS_ABSENT").toBe(true);
  } finally {
    for (const file of files) closeSync(file);
    child.kill("SIGKILL");
  }
});
