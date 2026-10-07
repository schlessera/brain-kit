/**
 * The pill labeller (#1004): a model's answer cleaned into a few plain words,
 * one call per distinct text, and every failure answered with null and
 * logged once per item.
 */
import { describe, expect, test } from "bun:test";
import {
  createLabeller,
  normaliseLabel,
  type LabelCompletionProvider,
} from "../src/labels/index";
import { createPillLabels } from "../src/labels/pill-labels";
import { createRecordingObservability } from "../src/observability/index";
import type { SessionCatalog } from "../src/ws/session-catalog";
import { TurnCoordinator } from "../src/ws/turns";

describe("normaliseLabel", () => {
  test.each([
    ["Return to Ithaca", "Return to Ithaca"],
    ["\"Return to Ithaca.\"", "Return to Ithaca"],
    ["“Wine for the Cyclops!”", "Wine for the Cyclops"],
    ["Label: Suitor guest list", "Suitor guest list"],
    ["**Bag of winds**", "Bag of winds"],
    ["- Charting the strait", "Charting the strait"],
    ["Label:\nSirens' song plan", "Sirens song plan"],
    ["  Crew   rations \t audit  ", "Crew rations audit"],
    ["Loom\u200b weaving delay...", "Loom weaving delay"],
  ])("%j becomes %j", (raw, label) => {
    expect(normaliseLabel(raw)).toBe(label);
  });

  test("keeps at most four words, then cuts on a word boundary to fit", () => {
    expect(normaliseLabel("Plan the long voyage home to Ithaca")).toBe("Plan the long voyage");
    const label = normaliseLabel("Provisioning Phaeacian shipbuilders' extraordinary celebrations")!;
    expect(label.length).toBeLessThanOrEqual(32);
    expect(label).toBe("Provisioning Phaeacian");
  });

  test("a single word longer than a pill is cut at the limit", () => {
    const label = normaliseLabel("Antidisestablishmentarianismlikeoratory")!;
    expect(label).toHaveLength(32);
  });

  test("nothing usable is null", () => {
    for (const raw of ["", "   ", "\"\"", "...", "Label:", "**"]) expect(normaliseLabel(raw)).toBeNull();
  });
});

/** A provider whose answers the test scripts; `calls` is what it was asked. */
function scripted(answer: (prompt: string) => Promise<string> | string) {
  const calls: Array<{ system?: string; prompt: string; maxTokens?: number }> = [];
  const provider: LabelCompletionProvider = {
    id: "fixture-small",
    async complete(req) {
      calls.push(req);
      return answer(req.prompt);
    },
  };
  return { provider, calls };
}

describe("createLabeller", () => {
  test("without a provider it is off and asks nothing", async () => {
    const labeller = createLabeller({ options: null });
    expect(labeller.enabled).toBe(false);
    expect(await labeller.label("follow-up:a", "Ask Aeolus about the winds")).toBeNull();
  });

  test("labels a text once: a repeat and a concurrent ask share the answer", async () => {
    const { provider, calls } = scripted(() => "Asking Aeolus.");
    const labeller = createLabeller({ options: { provider } });
    const [first, second] = await Promise.all([
      labeller.label("follow-up:a", "Ask Aeolus about the winds"),
      labeller.label("session:s", "Ask Aeolus about the winds"),
    ]);
    expect([first, second]).toEqual(["Asking Aeolus", "Asking Aeolus"]);
    expect(await labeller.label("follow-up:b", "  Ask Aeolus   about the winds ")).toBe("Asking Aeolus");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toBe("Ask Aeolus about the winds");
    expect(calls[0]!.system).toContain("two to four plain words");
  });

  test("a text with no words is never sent", async () => {
    const { provider, calls } = scripted(() => "Anything");
    const labeller = createLabeller({ options: { provider } });
    expect(await labeller.label("follow-up:a", "  \n ")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("a failing provider answers null, logs once per item and is asked again later", async () => {
    const observability = createRecordingObservability();
    let fail = true;
    const { provider, calls } = scripted(() => {
      if (fail) throw new Error("vendor unavailable");
      return "Winds report";
    });
    const labeller = createLabeller({
      options: { provider },
      log: observability.logger("labels"),
      meter: observability.meter("labels"),
    });
    expect(await labeller.label("follow-up:a", "Ask Aeolus about the winds")).toBeNull();
    expect(await labeller.label("follow-up:a", "Ask Aeolus about the winds")).toBeNull();
    expect(await labeller.label("follow-up:b", "Keep the bag of winds shut")).toBeNull();
    const warnings = observability.logs.find({ scope: "labels", body: "pill label unavailable" });
    expect(warnings.map((w) => [w.attributes["label.item"], w.attributes["label.outcome"]])).toEqual([
      ["follow-up:a", "error"],
      ["follow-up:b", "error"],
    ]);
    expect(observability.metrics.value("brain.labeller.calls", { outcome: "error", provider: "fixture-small" })).toBe(3);
    // A failure is not cached: once the vendor is back, the same text is labelled.
    fail = false;
    expect(await labeller.label("follow-up:a", "Ask Aeolus about the winds")).toBe("Winds report");
    expect(calls).toHaveLength(4);
    expect(observability.metrics.value("brain.labeller.calls", { outcome: "labelled", provider: "fixture-small" })).toBe(1);
  });

  test("a provider that never answers times out to null", async () => {
    const observability = createRecordingObservability();
    const { provider } = scripted(() => new Promise<string>(() => {}));
    const labeller = createLabeller({
      options: { provider, timeoutMs: 20 },
      log: observability.logger("labels"),
    });
    expect(await labeller.label("session:s", "Chart the way home")).toBeNull();
    expect(observability.logs.find({ scope: "labels" })[0]!.attributes["label.outcome"]).toBe("timeout");
  });

  test("an answer with nothing usable is kept as no label, not asked again", async () => {
    const { provider, calls } = scripted(() => "\"\"");
    const labeller = createLabeller({ options: { provider } });
    expect(await labeller.label("follow-up:a", "Ask Aeolus about the winds")).toBeNull();
    expect(await labeller.label("follow-up:a", "Ask Aeolus about the winds")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test("runs at most two calls at once", async () => {
    let running = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const { provider } = scripted(async (prompt) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => release.push(resolve));
      running--;
      return `Label ${prompt.slice(-1)}`;
    });
    const labeller = createLabeller({ options: { provider } });
    const answers = ["1", "2", "3", "4", "5"].map((n) => labeller.label(`follow-up:${n}`, `Message ${n}`));
    while (release.length || running) {
      await new Promise((r) => setTimeout(r, 1));
      release.shift()?.();
    }
    expect(await Promise.all(answers)).toEqual(["Label 1", "Label 2", "Label 3", "Label 4", "Label 5"]);
    expect(peak).toBe(2);
  });

  test("a call past its deadline answers null but keeps its slot until the provider settles", async () => {
    let running = 0;
    let peak = 0;
    const settle: Array<() => void> = [];
    const { provider, calls } = scripted(async (prompt) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => settle.push(resolve));
      running--;
      return `Late ${prompt.slice(-1)}`;
    });
    const labeller = createLabeller({ options: { provider, timeoutMs: 10 } });
    const answers = await Promise.all(["1", "2", "3", "4"].map((n) => labeller.label(`follow-up:${n}`, `Message ${n}`)));
    // The first two timed out while running; the other two timed out
    // waiting for a slot, and are never started.
    expect(answers).toEqual([null, null, null, null]);
    expect(calls).toHaveLength(2);
    while (settle.length || running) {
      settle.shift()?.();
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(peak).toBe(2);
    expect(calls).toHaveLength(2);
    // A late answer is kept: asking again costs no call.
    expect(await labeller.label("follow-up:1", "Message 1")).toBe("Late 1");
    expect(calls).toHaveLength(2);
  });
});

test("asking again for a text whose call outlived its deadline joins that call", async () => {
  const settle: Array<(label: string) => void> = [];
  const { provider, calls } = scripted(() => new Promise<string>((resolve) => settle.push(resolve)));
  const labeller = createLabeller({ options: { provider, timeoutMs: 10 } });
  expect(await labeller.label("follow-up:a", "Ask Aeolus about the winds")).toBeNull();
  // The follow-up starts and its session asks for the same request.
  const again = labeller.label("session:s", "Ask Aeolus about the winds");
  settle.shift()!("Asking Aeolus");
  expect(await again).toBe("Asking Aeolus");
  expect(calls).toHaveLength(1);
});

test("the call count is the provider's calls; asks that gave up are counted apart", async () => {
  const observability = createRecordingObservability();
  const settle: Array<(label: string) => void> = [];
  const { provider } = scripted(() => new Promise<string>((resolve) => settle.push(resolve)));
  const labeller = createLabeller({ options: { provider, timeoutMs: 10 }, meter: observability.meter("labels") });
  // Two asks share one slow call and both give up.
  expect(await Promise.all([
    labeller.label("follow-up:a", "Ask Aeolus about the winds"),
    labeller.label("session:s", "Ask Aeolus about the winds"),
  ])).toEqual([null, null]);
  settle.shift()!("Asking Aeolus");
  await new Promise((r) => setTimeout(r, 1));
  expect(observability.metrics.total("brain.labeller.calls")).toBe(1);
  expect(observability.metrics.value("brain.labeller.calls", { outcome: "labelled", provider: "fixture-small" })).toBe(1);
  expect(observability.metrics.value("brain.labeller.fallbacks", { outcome: "timeout", provider: "fixture-small" })).toBe(2);
});

describe("createPillLabels", () => {
  test("a started follow-up's label becomes its session's without asking again", () => {
    const asked: string[] = [];
    const labeller = { enabled: true, label: async (_item: string, text: string) => { asked.push(text); return "Asked"; } };
    const stored = new Map<string, { label: string; source: string }>();
    const catalog = {
      sessionLabel: (id: string) => stored.get(id) ?? null,
      saveSessionLabel: (id: string, label: string, source: string) => { stored.set(id, { label, source }); },
    } as unknown as SessionCatalog;
    const labels = createPillLabels({ labeller, catalog, coordinator: new TurnCoordinator() });
    labels.turnStarted("s", "Ask Aeolus about the winds", "Asking Aeolus");
    expect(stored.get("s")?.label).toBe("Asking Aeolus");
    expect(asked).toEqual([]);
  });

  test("an older request's slow label never replaces the label of the request that followed it", async () => {
    const pending = new Map<string, (label: string) => void>();
    const labeller = {
      enabled: true,
      label: (_item: string, text: string) => new Promise<string | null>((resolve) => pending.set(text, resolve)),
    };
    const stored = new Map<string, { label: string; source: string }>();
    const catalog = {
      sessionLabel: (id: string) => stored.get(id) ?? null,
      saveSessionLabel: (id: string, label: string, source: string) => { stored.set(id, { label, source }); },
    } as unknown as SessionCatalog;
    const labels = createPillLabels({ labeller, catalog, coordinator: new TurnCoordinator() });

    labels.turnStarted("s", "Chart the way home");
    pending.get("Chart the way home")!("Route home");
    await Promise.resolve();
    expect(stored.get("s")?.label).toBe("Route home");
    // B starts and is slow; then the session repeats A, already labelled.
    labels.turnStarted("s", "Ask Aeolus about the winds");
    labels.turnStarted("s", "Chart the way home");
    pending.get("Ask Aeolus about the winds")!("Asking Aeolus");
    await Promise.resolve();
    expect(stored.get("s")?.label).toBe("Route home");
  });
});
