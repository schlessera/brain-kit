import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { createRequire } from "module";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import { z } from "zod";

// The server barrel carries both halves: the handlers from
// `server/bridge-tools/` and the contracts from `tool-contracts/`.
import * as shared from "../packages/ui-sdk/src/server";
import * as claudeAsk from "../packages/ui-backend-claude/src/ask-user-tool";
import * as claudeAskList from "../packages/ui-backend-claude/src/ask-user-list-tool";
import * as claudeLocation from "../packages/ui-backend-claude/src/location-tool";
import * as claudeMask from "../packages/ui-backend-claude/src/mask-tool";
import * as claudeActivity from "../packages/ui-backend-claude/src/activity-tool";
import * as claudeBlock from "../packages/ui-backend-claude/src/show-block-tool";
import * as pi from "../packages/ui-backend-pi/src/bridge-tools";

type Adapter = "claude" | "pi";
type ToolName = (typeof shared.BRIDGE_TOOL_POSTURE.names)[number];
type SnapshotEntry = {
  definitionSha256: string;
  resultSha256: string;
  symlinkResultSha256?: string;
  rootSymlinkResultSha256?: string;
};
/**
 * The four tools the snapshot fixtures were captured over. `show_block` came
 * later (D41) and has no "before"; its bytes are asserted by the contract
 * tests below rather than by a fixture.
 */
const SNAPSHOT_NAMES = [
  "ask_user",
  "get_current_location",
  "request_image_mask",
  "query_activity",
] as const;
type SnapshotName = (typeof SNAPSHOT_NAMES)[number];
type Snapshot = Record<Adapter, Record<SnapshotName, SnapshotEntry>>;

const VALID_INPUTS: Record<ToolName, unknown> = {
  ask_user: {
    questions: [
      {
        question: "Choose?",
        header: "Choice",
        options: [
          { label: "A", description: "First" },
          { label: "B", description: "Second", preview: "Preview" },
        ],
        multiSelect: false,
      },
    ],
  },
  ask_user_list: {
    prompt: "Rate these?",
    scale: [{ label: "loved" }, { label: "meh", description: "Fine, forgettable" }],
    items: [
      { id: "a", label: "First" },
      { id: "b", label: "Second", detail: "2024", link: "https://example.org/b" },
    ],
  },
  get_current_location: { highAccuracy: false },
  request_image_mask: { imagePath: "x.png" },
  query_activity: { scope: "running" },
  show_block: {
    block: {
      kind: "stats",
      tiles: [
        { label: "Ships", value: "12", meta: "of 12" },
        { label: "Days", value: "9", tone: "amber" },
      ],
    },
  },
};

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function stableResult(value: unknown, canonicalRoot?: string): string {
  const stable = JSON.stringify(value).replace(
    /[0-9a-f]{8}-[0-9a-f-]{27}/g,
    "<nonce>"
  );
  return canonicalRoot ? stable.replaceAll(canonicalRoot, "<repo>") : stable;
}

function readSnapshot(name: "before" | "after"): Snapshot {
  return JSON.parse(
    readFileSync(
      join(import.meta.dir, "fixtures", `bridge-tools.${name}.json`),
      "utf8"
    )
  ) as Snapshot;
}

function makeAdapters(root: string) {
  const bridge = {
    askUser: async () => ({
      answers: { Choice: "A" },
      annotations: { Choice: {} },
    }),
    askUserList: async () => ({ answers: { a: "loved" } }),
    getLocation: async () => ({
      coords: { latitude: 1, longitude: 2, accuracy: 3.6 },
      timestamp: 0,
    }),
    requestMask: async () => new Uint8Array([1, 2, 3]),
    queryActivity: async () => ({ running: [] }),
  };
  const noGeocode = {
    enabled: false,
    url: "https://nominatim.openstreetmap.org",
    userAgent: "brain-ui/1.0",
  };
  return {
    claude: [
      claudeAsk.createAskUserTool(bridge.askUser),
      claudeAskList.createAskUserListTool(bridge.askUserList),
      claudeLocation.createLocationTool(bridge.getLocation, {
        reverseGeocodeConfig: noGeocode,
      }),
      claudeMask.createMaskTool(bridge.requestMask, root),
      claudeActivity.createActivityQueryTool(bridge.queryActivity),
      claudeBlock.createShowBlockTool(),
    ] as any[],
    pi: pi.createPiBridgeTools({
      brainPath: root,
      turn: { bridge } as never,
      capabilities: { location: true, activity: true, mask: true },
      reverseGeocodeConfig: noGeocode,
    }) as any[],
  };
}

async function currentSnapshot(): Promise<Snapshot> {
  const root = mkdtempSync(join(tmpdir(), "bridge-snapshot-"));
  writeFileSync(join(root, "x.png"), "");
  mkdirSync(join(root, "real"));
  writeFileSync(join(root, "real", "x.png"), "");
  symlinkSync("real", join(root, "alias"));
  try {
    const adapters = makeAdapters(root);
    const snapshot = { claude: {}, pi: {} } as Snapshot;
    for (const adapter of ["claude", "pi"] as const) {
      for (const name of SNAPSHOT_NAMES) {
        const definition = adapters[adapter].find((item) => item.name === name)!;
        let schema: unknown;
        if (adapter === "claude") {
          const { $schema: _schema, ...jsonSchema } = z.toJSONSchema(
            z.object(definition.inputSchema),
            { io: "input" }
          );
          schema = jsonSchema;
        } else {
          schema = definition.parameters;
        }
        const definitionText = JSON.stringify({
          name: definition.name,
          ...(definition.label ? { label: definition.label } : {}),
          description: definition.description,
          schema,
        });
        const result =
          adapter === "claude"
            ? await definition.handler(VALID_INPUTS[name], {})
            : await definition.execute("request-id", VALID_INPUTS[name]);
        snapshot[adapter][name] = {
          definitionSha256: sha256(definitionText),
          resultSha256: sha256(stableResult(result)),
        };
      }
      const mask = adapters[adapter].find(
        (item) => item.name === shared.REQUEST_IMAGE_MASK_TOOL_NAME
      )!;
      const symlinkResult =
        adapter === "claude"
          ? await mask.handler({ imagePath: "alias/x.png" }, {})
          : await mask.execute("request-id", { imagePath: "alias/x.png" });
      snapshot[adapter].request_image_mask.symlinkResultSha256 = sha256(
        stableResult(symlinkResult)
      );

      const rootParent = mkdtempSync(join(tmpdir(), "bridge-root-symlink-"));
      const canonicalRoot = join(rootParent, "real");
      const symlinkedRoot = join(rootParent, "alias");
      mkdirSync(canonicalRoot);
      writeFileSync(join(canonicalRoot, "x.png"), "");
      symlinkSync("real", symlinkedRoot);
      try {
        const rootSymlinkMask = makeAdapters(symlinkedRoot)[adapter].find(
          (item) => item.name === shared.REQUEST_IMAGE_MASK_TOOL_NAME
        )!;
        const rootSymlinkResult =
          adapter === "claude"
            ? await rootSymlinkMask.handler({ imagePath: "x.png" }, {})
            : await rootSymlinkMask.execute("request-id", {
                imagePath: "x.png",
              });
        snapshot[adapter].request_image_mask.rootSymlinkResultSha256 = sha256(
          stableResult(rootSymlinkResult, canonicalRoot)
        );
      } finally {
        rmSync(rootParent, { recursive: true, force: true });
      }
    }
    return snapshot;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("bridge tool adapter identity", () => {
  test("both adapters expose the SDK's exact description and schema objects", () => {
    const cases = [
      [
        shared.ASK_USER_DESCRIPTION,
        shared.ASK_USER_INPUT_SCHEMA,
        claudeAsk.ASK_USER_DESCRIPTION,
        claudeAsk.ASK_USER_INPUT_SCHEMA,
        pi.ASK_USER_DESCRIPTION,
        pi.ASK_USER_INPUT_SCHEMA,
      ],
      [
        shared.ASK_USER_LIST_DESCRIPTION,
        shared.ASK_USER_LIST_INPUT_SCHEMA,
        claudeAskList.ASK_USER_LIST_DESCRIPTION,
        claudeAskList.ASK_USER_LIST_INPUT_SCHEMA,
        pi.ASK_USER_LIST_DESCRIPTION,
        pi.ASK_USER_LIST_INPUT_SCHEMA,
      ],
      [
        shared.GET_CURRENT_LOCATION_DESCRIPTION,
        shared.GET_CURRENT_LOCATION_INPUT_SCHEMA,
        claudeLocation.GET_CURRENT_LOCATION_DESCRIPTION,
        claudeLocation.GET_CURRENT_LOCATION_INPUT_SCHEMA,
        pi.GET_CURRENT_LOCATION_DESCRIPTION,
        pi.GET_CURRENT_LOCATION_INPUT_SCHEMA,
      ],
      [
        shared.REQUEST_IMAGE_MASK_DESCRIPTION,
        shared.REQUEST_IMAGE_MASK_INPUT_SCHEMA,
        claudeMask.REQUEST_IMAGE_MASK_DESCRIPTION,
        claudeMask.REQUEST_IMAGE_MASK_INPUT_SCHEMA,
        pi.REQUEST_IMAGE_MASK_DESCRIPTION,
        pi.REQUEST_IMAGE_MASK_INPUT_SCHEMA,
      ],
      [
        shared.QUERY_ACTIVITY_DESCRIPTION,
        shared.QUERY_ACTIVITY_INPUT_SCHEMA,
        claudeActivity.QUERY_ACTIVITY_DESCRIPTION,
        claudeActivity.QUERY_ACTIVITY_INPUT_SCHEMA,
        pi.QUERY_ACTIVITY_DESCRIPTION,
        pi.QUERY_ACTIVITY_INPUT_SCHEMA,
      ],
      [
        shared.SHOW_BLOCK_DESCRIPTION,
        shared.SHOW_BLOCK_INPUT_SCHEMA,
        claudeBlock.SHOW_BLOCK_DESCRIPTION,
        claudeBlock.SHOW_BLOCK_INPUT_SCHEMA,
        pi.SHOW_BLOCK_DESCRIPTION,
        pi.SHOW_BLOCK_INPUT_SCHEMA,
      ],
    ] as const;
    for (const [description, schema, claudeDescription, claudeSchema, piDescription, piSchema] of cases) {
      expect(claudeDescription).toBe(description);
      expect(piDescription).toBe(description);
      expect(claudeSchema).toBe(schema);
      expect(piSchema).toBe(schema);
    }
  });

  test("both advertised schemas are generated from the same zod objects", () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-identity-"));
    try {
      const adapters = makeAdapters(root);
      for (const name of shared.BRIDGE_TOOL_POSTURE.names) {
        const claude = adapters.claude.find((item) => item.name === name)!;
        const piTool = adapters.pi.find((item) => item.name === name)!;
        const { $schema: _schema, ...jsonSchema } = z.toJSONSchema(
          z.object(claude.inputSchema),
          { io: "input" }
        );
        expect(piTool.parameters).toEqual(jsonSchema);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Claude's four definition and result bytes are unchanged", async () => {
    const before = readSnapshot("before");
    const after = readSnapshot("after");
    expect(after.claude).toEqual(before.claude);
    expect((await currentSnapshot()).claude).toEqual(after.claude);
  });

  test("the eight current adapter snapshots match the captured after fixture", async () => {
    expect(await currentSnapshot()).toEqual(readSnapshot("after"));
  });

  test("the pi snapshot moves only in the intended definition/result categories", () => {
    const before = readSnapshot("before").pi;
    const after = readSnapshot("after").pi;
    expect(after.ask_user.definitionSha256).not.toBe(before.ask_user.definitionSha256);
    expect(after.ask_user.resultSha256).not.toBe(before.ask_user.resultSha256);
    expect(after.get_current_location.definitionSha256).not.toBe(
      before.get_current_location.definitionSha256
    );
    expect(after.get_current_location.resultSha256).toBe(
      before.get_current_location.resultSha256
    );
    expect(after.request_image_mask.definitionSha256).not.toBe(
      before.request_image_mask.definitionSha256
    );
    // The mask result DOES move, and only here: pi reported a sentence while
    // every other payload tool serialised its payload into `output`, so a
    // renderer could not parse any payload tool's result the same way. The
    // paths inside it are unchanged — the assertions further down hold each
    // symlink case to the same maskPath as before.
    expect(after.request_image_mask.resultSha256).not.toBe(
      before.request_image_mask.resultSha256
    );
    expect(after.request_image_mask.symlinkResultSha256).not.toBe(
      before.request_image_mask.symlinkResultSha256
    );
    expect(after.request_image_mask.rootSymlinkResultSha256).not.toBe(
      before.request_image_mask.rootSymlinkResultSha256
    );
    expect(after.query_activity.definitionSha256).not.toBe(
      before.query_activity.definitionSha256
    );
    expect(after.query_activity.resultSha256).toBe(
      before.query_activity.resultSha256
    );
  });

  test("mask paths preserve each adapter's pre-refactor symlink behavior", async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-mask-symlink-"));
    try {
      writeFileSync(join(root, "original.png"), "image");
      symlinkSync("original.png", join(root, "link.png"));
      writeFileSync(join(root, "link.mask.png"), "link candidate");
      writeFileSync(join(root, "original.mask.png"), "canonical candidate");

      const piMask = makeAdapters(root).pi.find(
        (tool) => tool.name === shared.REQUEST_IMAGE_MASK_TOOL_NAME
      )!;
      const piResult = await piMask.execute("mask", {
        imagePath: "link.png",
      });
      // pi now serialises the payload into `output` like the other payload
      // tools, instead of reporting a sentence; `details` keeps its old shape.
      expect(piResult.details).toEqual({ maskPath: "original.mask.png" });
      expect(JSON.parse(piResult.content[0].text)).toMatchObject({
        maskPath: "original.mask.png",
        imagePath: "link.png",
        bytes: 3,
      });
      expect(readFileSync(join(root, "original.mask.png"))).toEqual(
        Buffer.from([1, 2, 3])
      );
      expect(readFileSync(join(root, "link.mask.png"), "utf8")).toBe(
        "link candidate"
      );

      mkdirSync(join(root, "real"));
      writeFileSync(join(root, "real", "x.png"), "image");
      symlinkSync("real", join(root, "alias"));
      writeFileSync(join(root, "real", "x-mask.png"), "old mask");

      const claudeMaskTool = makeAdapters(root).claude.find(
        (tool) => tool.name === shared.REQUEST_IMAGE_MASK_TOOL_NAME
      )!;
      const claudeResult = await claudeMaskTool.handler(
        { imagePath: "alias/x.png" },
        {}
      );
      expect(JSON.parse(claudeResult.content[0].text)).toMatchObject({
        maskPath: "alias/x-mask.png",
        imagePath: "alias/x.png",
      });
      expect(readFileSync(join(root, "real", "x-mask.png"))).toEqual(
        Buffer.from([1, 2, 3])
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("pi reports a canonical absolute mask path through a symlinked repo root", async () => {
    const rootParent = mkdtempSync(join(tmpdir(), "bridge-mask-root-symlink-"));
    const canonicalRoot = join(rootParent, "real");
    const symlinkedRoot = join(rootParent, "alias");
    try {
      mkdirSync(canonicalRoot);
      writeFileSync(join(canonicalRoot, "x.png"), "image");
      symlinkSync("real", symlinkedRoot);

      const adapters = makeAdapters(symlinkedRoot);
      const piMask = adapters.pi.find(
        (tool) => tool.name === shared.REQUEST_IMAGE_MASK_TOOL_NAME
      )!;
      const piResult = await piMask.execute("mask", { imagePath: "x.png" });
      const canonicalMaskPath = join(canonicalRoot, "x.mask.png");
      expect(piResult.details).toEqual({ maskPath: canonicalMaskPath });
      expect(JSON.parse(piResult.content[0].text)).toMatchObject({
        maskPath: canonicalMaskPath,
        imagePath: "x.png",
        bytes: 3,
      });
      expect(readFileSync(canonicalMaskPath)).toEqual(Buffer.from([1, 2, 3]));

      const claudeMaskTool = adapters.claude.find(
        (tool) => tool.name === shared.REQUEST_IMAGE_MASK_TOOL_NAME
      )!;
      const claudeResult = await claudeMaskTool.handler(
        { imagePath: "x.png" },
        {}
      );
      expect(JSON.parse(claudeResult.content[0].text)).toMatchObject({
        maskPath: "x-mask.png",
        imagePath: "x.png",
      });
    } finally {
      rmSync(rootParent, { recursive: true, force: true });
    }
  });
});

describe("bridge tool adapter validation", () => {
  const invalidInputs: Record<ToolName, unknown[]> = {
    ask_user: [
      {
        questions: [
          {
            question: "Choose?",
            header: "Choice",
            options: [{ label: "A", description: "Only one" }],
            multiSelect: false,
          },
        ],
      },
      {
        questions: [
          {
            question: "Choose?",
            header: "Header over 12 chars",
            options: [
              { label: "A", description: "First" },
              { label: "B", description: "Second" },
            ],
            multiSelect: false,
          },
        ],
      },
      {
        questions: Array.from({ length: 5 }, (_, index) => ({
          question: `Choose ${index}?`,
          header: `Choice ${index}`,
          options: [
            { label: "A", description: "First" },
            { label: "B", description: "Second" },
          ],
          multiSelect: false,
        })),
      },
      {
        questions: [
          {
            question: "Choose?",
            header: "Choice",
            options: Array.from({ length: 5 }, (_, index) => ({
              label: String(index),
              description: `Option ${index}`,
            })),
            multiSelect: false,
          },
        ],
      },
      {
        questions: [
          {
            question: "Choose?",
            header: "Choice",
            options: [
              { label: "A", description: "First" },
              { label: "B", description: "Second" },
            ],
          },
        ],
      },
      { questions: "wrong type" },
    ],
    ask_user_list: [
      // One scale option is not a scale.
      {
        prompt: "Rate?",
        scale: [{ label: "only" }],
        items: [{ id: "a", label: "A" }],
      },
      // Nine options is past the cap.
      {
        prompt: "Rate?",
        scale: Array.from({ length: 9 }, (_, i) => ({ label: `o${i}` })),
        items: [{ id: "a", label: "A" }],
      },
      // Thirty-one items is past the cap.
      {
        prompt: "Rate?",
        scale: [{ label: "x" }, { label: "y" }],
        items: Array.from({ length: 31 }, (_, i) => ({ id: `i${i}`, label: `I${i}` })),
      },
      { prompt: "Rate?", scale: [{ label: "x" }, { label: "y" }], items: [] },
      // Duplicate ids: an answer is keyed by id, so two items cannot share one.
      {
        prompt: "Rate?",
        scale: [{ label: "x" }, { label: "y" }],
        items: [
          { id: "a", label: "A" },
          { id: "a", label: "B" },
        ],
      },
      // Duplicate labels: an answer names its option by label.
      {
        prompt: "Rate?",
        scale: [{ label: "x" }, { label: "x" }],
        items: [{ id: "a", label: "A" }],
      },
    ],
    get_current_location: [{ highAccuracy: "yes" }],
    request_image_mask: [{ imagePath: 42 }],
    query_activity: [{ scope: "all" }, { scope: "recent", hoursBack: "24" }],
    show_block: [
      { block: { kind: "map" } },
      { block: { kind: "stats", tiles: [] } },
      { block: { kind: "comparison", columns: [{ label: "only one" }], rows: [] } },
      { block: { kind: "trend", values: [1] } },
      { block: { kind: "bars", rows: [{ label: "x", pct: 140, value: "1" }] } },
      { block: { kind: "quote", quote: "x", tone: "red" } },
      { kind: "stats", tiles: [{ label: "x", value: "1" }] },
    ],
  };

  test("valid input succeeds and invalid input fails through both envelopes", async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-validation-"));
    writeFileSync(join(root, "x.png"), "");
    try {
      const adapters = makeAdapters(root);
      for (const name of shared.BRIDGE_TOOL_POSTURE.names) {
        const claude = adapters.claude.find((item) => item.name === name)!;
        const piTool = adapters.pi.find((item) => item.name === name)!;
        expect((await claude.handler(VALID_INPUTS[name], {})).isError).toBeUndefined();
        await expect(
          piTool.execute("valid", VALID_INPUTS[name])
        ).resolves.toBeDefined();
        for (const input of invalidInputs[name]) {
          expect((await claude.handler(input, {})).isError).toBe(true);
          await expect(piTool.execute("invalid", input)).rejects.toThrow();
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("every pi JSON Schema compiles under pi-ai's resolved typebox 1.3.27", async () => {
    const require = createRequire(import.meta.url);
    const piAiManifest = require.resolve("@earendil-works/pi-ai/package.json");
    const piRequire = createRequire(piAiManifest);
    const typeboxManifest = piRequire.resolve("typebox/package.json");
    expect(
      (JSON.parse(readFileSync(typeboxManifest, "utf8")) as { version: string })
        .version
    ).toBe("1.3.27");
    const compilePath = piRequire.resolve("typebox/compile");
    const { Compile } = (await import(pathToFileURL(compilePath).href)) as {
      Compile(schema: unknown): { Check(value: unknown): boolean };
    };

    const root = mkdtempSync(join(tmpdir(), "bridge-compile-"));
    try {
      const definitions = makeAdapters(root).pi;
      for (const definition of definitions) {
        const validator = Compile(definition.parameters);
        expect(validator.Check(VALID_INPUTS[definition.name as ToolName])).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("bridge tool geocode configuration", () => {
  test("both adapters pass the same enabled/url/userAgent values", async () => {
    const previous = {
      enabled: process.env.BRAIN_UI_REVERSE_GEOCODE,
      url: process.env.NOMINATIM_URL,
      userAgent: process.env.NOMINATIM_USER_AGENT,
    };
    process.env.BRAIN_UI_REVERSE_GEOCODE = "true";
    process.env.NOMINATIM_URL = "https://nominatim.example";
    process.env.NOMINATIM_USER_AGENT = "bridge-test/1";
    const configs: unknown[] = [];
    const geocode = async (_coords: unknown, config: unknown) => {
      configs.push(config);
      return null;
    };
    const getLocation = async () => ({
      coords: { latitude: 1, longitude: 2, accuracy: 3 },
      timestamp: 0,
    });
    try {
      const claude = claudeLocation.createLocationTool(getLocation, {
        reverseGeocode: geocode as never,
      }) as any;
      await claude.handler({}, {});

      const piTool = pi.createPiBridgeTools({
        brainPath: tmpdir(),
        turn: { bridge: { getLocation } } as never,
        capabilities: { location: true },
        reverseGeocode: geocode as never,
      }).find((tool) => tool.name === "get_current_location")! as any;
      await piTool.execute("location", {});

      expect(configs).toEqual([
        {
          enabled: true,
          url: "https://nominatim.example",
          userAgent: "bridge-test/1",
        },
        {
          enabled: true,
          url: "https://nominatim.example",
          userAgent: "bridge-test/1",
        },
      ]);
    } finally {
      if (previous.enabled === undefined) delete process.env.BRAIN_UI_REVERSE_GEOCODE;
      else process.env.BRAIN_UI_REVERSE_GEOCODE = previous.enabled;
      if (previous.url === undefined) delete process.env.NOMINATIM_URL;
      else process.env.NOMINATIM_URL = previous.url;
      if (previous.userAgent === undefined) delete process.env.NOMINATIM_USER_AGENT;
      else process.env.NOMINATIM_USER_AGENT = previous.userAgent;
    }
  });
});

describe("tool results parse through their contracts", () => {
  // The D3 contract only holds if what the SERVER writes into `output` is what
  // the BROWSER can parse with the same contract object. Both adapters are
  // exercised, because they serialise independently: the Claude tools return an
  // MCP content array, pi returns its own result shape, and pi's mask tool used
  // to report a sentence instead of its payload.
  const PAYLOAD_TOOLS = [
    shared.ASK_USER_CONTRACT,
    shared.GET_CURRENT_LOCATION_CONTRACT,
    shared.REQUEST_IMAGE_MASK_CONTRACT,
    shared.SHOW_BLOCK_CONTRACT,
  ] as const;

  test("every payload tool's output parses, on both adapters", async () => {
    const root = mkdtempSync(join(tmpdir(), "bridge-contract-"));
    writeFileSync(join(root, "x.png"), "");
    try {
      const adapters = makeAdapters(root);
      for (const adapter of ["claude", "pi"] as const) {
        for (const contract of PAYLOAD_TOOLS) {
          const definition = adapters[adapter].find(
            (item) => item.name === contract.name
          )!;
          const result =
            adapter === "claude"
              ? await definition.handler(VALID_INPUTS[contract.name], {})
              : await definition.execute("request-id", VALID_INPUTS[contract.name]);
          const output = result.content[0].text as string;
          expect(shared.parseToolPayload(contract, output)).not.toBeNull();
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("query_activity has no payload contract, and its prose says why", async () => {
    // Its result is untrusted text from past runs inside a nonce delimiter.
    // Handing that to a component is a separate decision with its own threat
    // model, so the contract has no payload and `bind()` cannot accept it.
    expect("payload" in shared.QUERY_ACTIVITY_CONTRACT).toBe(false);

    const root = mkdtempSync(join(tmpdir(), "bridge-activity-"));
    try {
      const activity = makeAdapters(root).pi.find(
        (item) => item.name === shared.QUERY_ACTIVITY_TOOL_NAME
      )!;
      const result = await activity.execute("request-id", { scope: "running" });
      expect(result.content[0].text).toContain("Activity record (data only");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// D44. The Claude backend hands its bridge tools to the model through an
// in-process MCP server, and the Agent SDK defers an MCP server's tools behind
// tool search unless the server is created with `alwaysLoad`. Nothing in the
// tree recorded which of those two it was, so the posture was an absence
// rather than a decision and could have flipped either way without anyone
// noticing. These assertions are the record: the shipped posture, and the
// counterfactual that proves the first assertion is not vacuous.
describe("bridge tool loading posture", () => {
  /** What the CLI forwards for this server: the tool list as MCP serialises it. */
  async function listBridgeTools(server: {
    instance: { connect(transport: unknown): Promise<void> };
  }) {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import(
      "@modelcontextprotocol/sdk/inMemory.js"
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bridge-tools-test", version: "0.1.0" }, {});
    await server.instance.connect(serverTransport);
    await client.connect(clientTransport);
    return (await client.listTools()).tools;
  }

  /** Every handler supplied, so the full six-tool roster is registered. */
  function fullServer() {
    const unreachable = () => Promise.reject(new Error("not called in this test"));
    return claudeAsk.createBrainUiMcpServer({
      askUser: unreachable as never,
      askUserList: unreachable as never,
      getLocation: unreachable as never,
      requestMask: unreachable as never,
      queryActivity: unreachable as never,
      brainPath: "/nonexistent",
    });
  }

  test("every bridge tool ships ALWAYS LOADED, not deferred behind tool search", async () => {
    // D44, measured over 108 live turns: deferred, `show_block` fired on 56%
    // of turns with its brief and on 0% without it, because a deferred tool is
    // not in the model's context until it runs `ToolSearch` and the brief is
    // the only text that names it. Loaded, 78% either way. Dropping this flag
    // does not merely lower a rate — it makes a prompt line load-bearing for
    // whether a tool exists at all, which is the failure mode this test is
    // here to prevent.
    const tools = await listBridgeTools(fullServer());
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...shared.BRIDGE_TOOL_POSTURE.names].sort()
    );
    for (const tool of tools) {
      expect(tool._meta?.["anthropic/alwaysLoad"]).toBe(true);
    }
  });

  test("the same tool registered without the flag carries no meta, so the check above can fail", async () => {
    // Without this the assertion above would pass against an SDK that had
    // started stamping the flag unconditionally, or a probe that could not
    // tell the two apart. Same tool factory the backend uses, registered the
    // one way the backend does not.
    const { createSdkMcpServer } = await import("@anthropic-ai/claude-agent-sdk");
    const tools = await listBridgeTools(
      createSdkMcpServer({
        name: "brain-ui",
        version: "0.1.0",
        tools: [claudeBlock.createShowBlockTool()],
      })
    );
    expect(tools.map((tool) => tool.name)).toEqual([shared.SHOW_BLOCK_TOOL_NAME]);
    expect(tools[0]!._meta?.["anthropic/alwaysLoad"]).toBeUndefined();
  });

  test("pi had no deferral to decide: its bridge tools are always in the prompt", async () => {
    // The other half of D44, and the reason the decision is scoped to the
    // Claude SDK. pi's `splitDeferredTools` defers a tool only when an earlier
    // tool result added it to the conversation and nothing has called it since;
    // a statically registered `ToolDefinition` can never be in that set. So
    // `createPiBridgeTools` returns tools that ride every prompt, and pi has
    // never run any other configuration — which is what #137's gap was.
    const root = mkdtempSync(join(tmpdir(), "bridge-posture-"));
    try {
      const tools = makeAdapters(root).pi;
      expect(tools.map((tool) => tool.name).sort()).toEqual(
        [...shared.BRIDGE_TOOL_POSTURE.names].sort()
      );
      // The invariant that matters is not a missing field — asserting an
      // absence on a plain object proves nothing. It is that each tool arrives
      // with its schema already attached, which is what makes it a static
      // registration rather than something a search hands over later.
      for (const tool of tools) {
        expect(tool.parameters).toBeDefined();
        expect(typeof tool.execute).toBe("function");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
