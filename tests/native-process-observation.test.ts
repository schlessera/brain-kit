import { expect, test } from "bun:test";
import { readlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { selectedNativePid } from "../packages/ui-backend-claude/tests/helpers/native-process-observation";

test("selected executable observations follow the owned wrapper's actual descendant", async () => {
  const expected = readlinkSync("/proc/self/exe");
  const wrapper = Bun.spawn(["/bin/sh", "-c", '"$1" -e "console.log(123); await Bun.sleep(30000)" & wait', "odysseus-wrapper", process.execPath], { stdout: "pipe", stderr: "pipe" });
  let target: number | undefined;
  try {
    const reader = wrapper.stdout.getReader();await reader.read();reader.releaseLock();
    target = selectedNativePid(wrapper.pid, expected);
    expect(target, "WRAPPER_IS_NOT_THE_SELECTED_PAYLOAD").not.toBe(wrapper.pid);
    expect(readlinkSync(`/proc/${target}/exe`)).toBe(expected);
    expect(() => selectedNativePid(wrapper.pid, "/synthetic/unselected/runtime"), "UNSELECTED_RUNTIME_REFUSED").toThrow("did not contain");
    const source=readFileSync(join(import.meta.dir,"../packages/ui-backend-claude/tests/fixtures/host-relay-probe.ts"),"utf8");
    expect(source).toContain("selectedNativePid(nativeChild.pid, expectedExecutable)");
    expect(source).toContain("/proc/${pid}/environ");
  } finally { if(target)try{process.kill(target,"SIGKILL");}catch{}wrapper.kill();await wrapper.exited; }
});
