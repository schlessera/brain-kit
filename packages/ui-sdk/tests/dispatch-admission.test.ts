/**
 * The host's final tool-dispatch admission, written once for both backends
 * (`admitToolDispatch`, #4767): wait, validate, ticket or `allowed`, wait,
 * validate, commit, then the call site's synchronous exposure.
 */
import { describe, expect, test } from "bun:test";
import { admitToolDispatch, type BackendBridge, type InputSafetyAdmissionCheck, type ToolDispatchAdmission } from "../src/server/index";

type InputSafety = NonNullable<BackendBridge["inputSafety"]>;

/** A host whose ticket methods log what they were called with. */
function host(options: { tickets?: boolean; onCommit?: () => void } = {}) {
  const log: string[] = [];
  const commits: Array<InputSafetyAdmissionCheck | undefined> = [];
  const allowedWith: Array<InputSafetyAdmissionCheck | undefined> = [];
  const inputSafety = {
    begin: async () => {},
    result: async () => {},
    allowed: async (id: string, validate?: InputSafetyAdmissionCheck) => { log.push(`allowed ${id}`); allowedWith.push(validate); },
    ...(options.tickets === false ? {} : {
      prepareDispatch: async (id: string) => {
        log.push(`prepare ${id}`);
        return {
          commit: (validate?: InputSafetyAdmissionCheck) => { log.push("commit"); commits.push(validate); options.onCommit?.(); },
          cancel: async () => { log.push("cancel"); },
        };
      },
    }),
  } as unknown as InputSafety;
  return { inputSafety, log, commits, allowedWith };
}

const admission = (inputSafety: InputSafety, overrides: Partial<ToolDispatchAdmission> = {}): ToolDispatchAdmission => ({
  inputSafety, toolUseId: "call-ithaca", validate: () => null, pending: () => [], dispatchesNow: true, ...overrides,
});

describe("admitToolDispatch", () => {
  test("runs the exposure in the same synchronous turn as the commit", async () => {
    let queued = false;
    const { inputSafety, log } = host({ onCommit: () => queueMicrotask(() => { queued = true; }) });
    let seen: boolean | undefined;
    await admitToolDispatch(admission(inputSafety, { expose: () => { seen = queued; log.push("expose"); } }));
    expect(seen).toBe(false);
    expect(log).toEqual(["prepare call-ithaca", "commit", "expose"]);
  });

  test("lets an exposure throw propagate and keeps the committed ticket", async () => {
    const { inputSafety, log } = host();
    const failure = admitToolDispatch(admission(inputSafety, { expose: () => { throw new Error("the session closed"); } }));
    await expect(failure).rejects.toThrow("the session closed");
    expect(log).toEqual(["prepare call-ithaca", "commit"]);
  });

  test("falls back to allowed with the validator on a host without tickets", async () => {
    const { inputSafety, log, allowedWith } = host({ tickets: false });
    const validate = () => null;
    await admitToolDispatch(admission(inputSafety, { validate }));
    expect(log).toEqual(["allowed call-ithaca"]);
    expect(allowedWith).toEqual([validate]);
  });

  test("takes no ticket when the validator refuses before it", async () => {
    const { inputSafety, log } = host();
    await expect(admitToolDispatch(admission(inputSafety, { validate: () => "Penelope revoked the grant" }))).rejects.toThrow("Penelope revoked the grant");
    expect(log).toEqual([]);
  });

  test("cancels the ticket and throws when the validator refuses after the pending wait", async () => {
    const { inputSafety, log } = host();
    let stale = false;
    let waits = 0;
    const pending = () => waits++ === 0 ? [] : [Promise.resolve().then(() => { stale = true; })];
    const failure = admitToolDispatch(admission(inputSafety, { pending, validate: () => stale ? "the suitors' record changed" : null }));
    await expect(failure).rejects.toThrow("the suitors' record changed");
    expect(log).toEqual(["prepare call-ithaca", "cancel"]);
  });

  test("hands commit the validator", async () => {
    const { inputSafety, commits } = host();
    const validate = () => null;
    await admitToolDispatch(admission(inputSafety, { validate }));
    expect(commits).toEqual([validate]);
  });

  test("validates again after a recording that settles between the two validations", async () => {
    const { inputSafety, log } = host();
    let release!: () => void;
    const recording = new Promise<void>((resolve) => { release = resolve; });
    let waits = 0;
    const pending = () => waits++ === 0 ? [] : [recording.then(() => { log.push("recorded"); })];
    const done = admitToolDispatch(admission(inputSafety, { pending, validate: () => { log.push("validate"); return null; } }));
    await Bun.sleep(0);
    expect(log).toEqual(["validate", "prepare call-ithaca"]);
    release();
    await done;
    expect(log).toEqual(["validate", "prepare call-ithaca", "recorded", "validate", "commit"]);
  });

  test("takes no ticket and calls no allowed for a call site that does not dispatch now", async () => {
    const { inputSafety, log } = host();
    let validations = 0;
    let exposed = false;
    await admitToolDispatch(admission(inputSafety, { dispatchesNow: false, validate: () => { validations++; return null; }, expose: () => { exposed = true; } }));
    expect(log).toEqual([]);
    expect(validations).toBe(2);
    expect(exposed).toBe(true);
  });

  test("waits for pending recordings before the first validation", async () => {
    const { inputSafety, log } = host();
    let waits = 0;
    const pending = () => waits++ === 0 ? [Promise.resolve().then(() => { log.push("recorded"); })] : [];
    await admitToolDispatch(admission(inputSafety, { pending, validate: () => { log.push("validate"); return null; } }));
    expect(log).toEqual(["recorded", "validate", "prepare call-ithaca", "validate", "commit"]);
  });
});
