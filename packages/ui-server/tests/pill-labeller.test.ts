/**
 * The pill labeller (#1004): a model's answer cleaned into a few plain words,
 * one call per distinct text, and every failure answered with null and
 * logged once per item.
 */
import { describe, expect, test } from "bun:test";
import {
  LABEL_CONCURRENCY,
  LABEL_MAX_CHARS,
  createLabeller,
  normaliseLabel,
  type LabelCompletionProvider,
} from "../src/labels/index";
import { createRecordingObservability } from "../src/observability/index";

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
    ["Loom​ weaving delay...", "Loom weaving delay"],
  ])("%j becomes %j", (raw, label) => {
    expect(normaliseLabel(raw)).toBe(label);
  });

  test("keeps at most four words, then cuts on a word boundary to fit", () => {
    expect(normaliseLabel("Plan the long voyage home to Ithaca")).toBe("Plan the long voyage");
    const label = normaliseLabel("Provisioning Phaeacian shipbuilders' extraordinary celebrations")!;
    expect(label.length).toBeLessThanOrEqual(LABEL_MAX_CHARS);
    expect(label).toBe("Provisioning Phaeacian");
  });

  test("a single word longer than a pill is cut at the limit", () => {
    const label = normaliseLabel("Antidisestablishmentarianismlikeoratory")!;
    expect(label).toHaveLength(LABEL_MAX_CHARS);
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

  test(`runs at most ${LABEL_CONCURRENCY} calls at once`, async () => {
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
    expect(peak).toBe(LABEL_CONCURRENCY);
  });
});
