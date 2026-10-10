import { expect, test } from "bun:test";
import { classifySurface, chooseNarrow, narrowRoutingRequest, ROUTING_MODEL, shortlist, wideRoutingRequest, type RoutingCatalogue } from "../scripts/turn-surface-classifier";
import { createJevClient } from "../packages/ui-server/src/classification/jev-client";
import type { ClassificationAnswers } from "@schlessera/brain-ui-sdk/internal";

const catalogue: RoutingCatalogue = {
  tools: ["read", "search", "table", "question"].map(name => ({ name, id: `mcp__brain__${name}`, serverName: "brain", inputSchema: { type: "object" }, description: `Original ${name} description` })),
  skills: ["voyage-plan", "shipbuilding", "crew-log"].map(name => ({ name, description: `Original ${name} procedure` })),
};
const wide: ClassificationAnswers = {
  needs_tool: { type: "noul", noul: 0.99 }, needs_skill: { type: "noul", noul: 0.01 },
  tool: { type: "choice", choice: "mcp__brain__read", confidence: 0.9,
    probabilities: { mcp__brain__read: 0.5, mcp__brain__search: 0.3, mcp__brain__table: 0.15, mcp__brain__question: 0.05 } },
};
const narrow: ClassificationAnswers = {
  tool: { type: "choice", choice: "mcp__brain__read", confidence: 0.9, probabilities: { mcp__brain__read: 0.9 } },
  "fits_tool:mcp__brain__read": { type: "noul", noul: 0.95 },
  "fits_tool:mcp__brain__search": { type: "noul", noul: 0.7 },
  "fits_tool:mcp__brain__table": { type: "noul", noul: 0.01 },
};

test("wide pass pins Jev, bounds state, and narrows to three unchanged descriptions", () => {
  const request = wideRoutingRequest("Read the notebook", "x".repeat(1100), catalogue);
  expect(request.model).toBe("jev-1.13.0");
  expect(request.state.previous_assistant_tail).toHaveLength(1000);
  expect(Object.keys(request.questions)).toHaveLength(4);
  const candidates = shortlist(wide, "tool", catalogue)!;
  expect(candidates.map(entry => entry.name)).toEqual(["mcp__brain__read", "mcp__brain__search", "mcp__brain__table"]);
  const verify = narrowRoutingRequest("Read the notebook", "", { tool: candidates, skill: [] });
  expect(verify.model).toBe(ROUTING_MODEL);
  expect(Object.keys(verify.questions)).toHaveLength(4);
  expect(JSON.stringify(verify.questions)).toContain("Original read description");
  expect(chooseNarrow(narrow, "tool", candidates)).toEqual(["mcp__brain__read", "mcp__brain__search"]);
  expect(chooseNarrow({ ...narrow, "fits_tool:mcp__brain__read": { type: "noul", noul: 0.59 } }, "tool", candidates)).toBeNull();
  expect(chooseNarrow({ ...narrow, "fits_tool:mcp__brain__search": { type: "noul", noul: NaN } }, "tool", candidates)).toBeNull();
  expect(shortlist({ ...wide, needs_tool: { type: "noul", noul: 0.5 } }, "tool", catalogue)).toBeNull();
  expect(shortlist({ ...wide, tool: { type: "choice", choice: "mcp__brain__read", confidence: 0.99, probabilities: {} } }, "tool", catalogue)).toBeNull();
});

test("real Jev transport runs both passes and none-needed uses no verification request", async () => {
  const requests: unknown[] = [];
  const client = createJevClient({ apiKey: "offline-classifier-control", fetch: async (_url, init) => {
    requests.push(JSON.parse(String(init.body)));
    return Response.json({ answers: requests.length === 1 ? wide : narrow });
  } });
  const selection = await classifySurface({ client, prompt: "Read the notebook", previousTail: "", catalogue, enabled: true, deadline: AbortSignal.timeout(2000) });
  expect(selection).toMatchObject({ outcome: "answered", passes: 2, tools: ["mcp__brain__read", "mcp__brain__search"], skills: [] });
  expect(requests).toHaveLength(2);
  let calls = 0;
  const none = createJevClient({ apiKey: "offline-classifier-control", fetch: async () => {
    calls++; return Response.json({ answers: { needs_tool: { type: "noul", noul: 0.01 }, needs_skill: { type: "noul", noul: 0.01 } } });
  } });
  expect(await classifySurface({ client: none, prompt: "Explain a mast", previousTail: "", catalogue, enabled: true, deadline: AbortSignal.timeout(2000) }))
    .toMatchObject({ outcome: "answered", passes: 1, tools: [], skills: [] });
  expect(calls).toBe(1);
});

test("one deadline prevents the second HTTP pass and off/no-key/circuit make no calls", async () => {
  const deadline = new AbortController();
  let calls = 0;
  const client = createJevClient({ apiKey: "offline-classifier-control", fetch: async () => {
    calls++; deadline.abort(); return Response.json({ answers: wide });
  } });
  expect(await classifySurface({ client, prompt: "Read", previousTail: "", catalogue, enabled: true, deadline: deadline.signal }))
    .toMatchObject({ outcome: "timeout", passes: 1, tools: [], skills: [] });
  expect(calls).toBe(1);
  expect(await classifySurface({ client, prompt: "Read", previousTail: "", catalogue, enabled: false, deadline: deadline.signal }))
    .toMatchObject({ outcome: "off", passes: 0 });
  const noKey = createJevClient({ apiKey: null, fetch: async () => { throw Error("must not dispatch"); } });
  expect(await classifySurface({ client: noKey, prompt: "Read", previousTail: "", catalogue, enabled: true, deadline: deadline.signal }))
    .toMatchObject({ outcome: "no_key", passes: 0 });
  const failing = createJevClient({ apiKey: "offline-classifier-control", fetch: async () => new Response("controlled", { status: 503 }) });
  for (let i = 0; i < 3; i++) await failing.classify(wideRoutingRequest("Read", "", catalogue));
  expect(await classifySurface({ client: failing, prompt: "Read", previousTail: "", catalogue, enabled: true, deadline: deadline.signal }))
    .toMatchObject({ outcome: "circuit_open", passes: 0 });
});
