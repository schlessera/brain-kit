import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverNativeIntents } from "../src/server/native-intent-recovery.js";

test("malformed native intents preserve identity and cause while other identities recover", () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-intent-")), state = join(root, "state"), diagnostics = join(root, "diagnostics");
  mkdirSync(state);
  const bad = "11111111-1111-4111-8111-111111111790", good = "22222222-2222-4222-8222-222222221790";
  writeFileSync(join(state, `${bad}.json`), "{broken");
  writeFileSync(join(state, `${good}.json`), JSON.stringify({ id: good, state: "sealed" }));
  const recovered: string[] = [];
  try {
    const result = recoverNativeIntents(state, diagnostics, id => { JSON.parse(readFileSync(join(state, `${id}.json`), "utf8")); recovered.push(id); });
    expect(recovered, "NATIVE_OTHER_IDENTITY_RECOVERS").toEqual([good]);
    expect(result.ids.sort()).toEqual([bad, good]);
    expect([...result.quarantined], "NATIVE_MALFORMED_ID_STAYS_FENCED").toEqual([bad]);
    expect(readFileSync(join(state, `${bad}.json`), "utf8")).toBe("{broken");
    const cause = JSON.parse(readFileSync(join(diagnostics, readdirSync(diagnostics)[0]!), "utf8"));
    expect(cause).toMatchObject({ scope: `${bad}.json`, site: "native-brain-manager.recoverIntent", errorClass: "SyntaxError" });
    expect(cause.at).toBeGreaterThan(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("a failed native diagnostic write does not abandon healthy intent recovery", () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-diagnostics-")), state = join(root,"state"), diagnostics = join(root,"diagnostics");
  mkdirSync(state); writeFileSync(diagnostics,"unwritable directory");
  const bad = "11111111-1111-4111-8111-111111111790", good = "22222222-2222-4222-8222-222222221790";
  writeFileSync(join(state, `${bad}.json`), "{broken"); writeFileSync(join(state, `${good}.json`), "{}");
  const recovered: string[] = [], logs: string[] = [];
  const logger = spyOn(console,"error").mockImplementation(line => { logs.push(String(line)); });
  try {
    expect(() => recoverNativeIntents(state, diagnostics, id => {
      JSON.parse(readFileSync(join(state, `${id}.json`), "utf8")); recovered.push(id);
    }), "NATIVE_DIAGNOSTIC_FAILURE_DOES_NOT_BLOCK_BOOT").not.toThrow();
    expect(recovered).toEqual([good]);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!)).toMatchObject({kind:"native_recovery_failure",scope:`${bad}.json`,errorClass:"SyntaxError"});
    expect(JSON.parse(logs[0]!).diagnosticError).toContain("EEXIST");
  } finally { logger.mockRestore(); rmSync(root,{recursive:true,force:true}); }
});
