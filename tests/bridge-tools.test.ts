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

import * as shared from "../packages/ui-sdk/src/server/bridge-tools";
import * as claudeAsk from "../packages/ui-backend-claude/src/ask-user-tool";
import * as claudeLocation from "../packages/ui-backend-claude/src/location-tool";
import * as claudeMask from "../packages/ui-backend-claude/src/mask-tool";
import * as claudeActivity from "../packages/ui-backend-claude/src/activity-tool";
import * as pi from "../packages/ui-backend-pi/src/bridge-tools";

type Adapter = "claude" | "pi";
type ToolName = (typeof shared.BRIDGE_TOOL_POSTURE.names)[number];
type SnapshotEntry = {
  definitionSha256: string;
  resultSha256: string;
  symlinkResultSha256?: string;
  rootSymlinkResultSha256?: string;
};
type Snapshot = Record<Adapter, Record<ToolName, SnapshotEntry>>;

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
  get_current_location: { highAccuracy: false },
  request_image_mask: { imagePath: "x.png" },
  query_activity: { scope: "running" },
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
      claudeLocation.createLocationTool(bridge.getLocation, {
        reverseGeocodeConfig: noGeocode,
      }),
      claudeMask.createMaskTool(bridge.requestMask, root),
      claudeActivity.createActivityQueryTool(bridge.queryActivity),
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
      for (const name of shared.BRIDGE_TOOL_POSTURE.names) {
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
    expect(after.request_image_mask.resultSha256).toBe(
      before.request_image_mask.resultSha256
    );
    expect(after.request_image_mask.symlinkResultSha256).toBe(
      before.request_image_mask.symlinkResultSha256
    );
    expect(after.request_image_mask.rootSymlinkResultSha256).toBe(
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
      expect(piResult).toEqual({
        content: [
          { type: "text", text: "Mask written to original.mask.png." },
        ],
        details: { maskPath: "original.mask.png" },
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
      expect(piResult).toEqual({
        content: [
          { type: "text", text: `Mask written to ${canonicalMaskPath}.` },
        ],
        details: { maskPath: canonicalMaskPath },
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
    get_current_location: [{ highAccuracy: "yes" }],
    request_image_mask: [{ imagePath: 42 }],
    query_activity: [{ scope: "all" }, { scope: "recent", hoursBack: "24" }],
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

  test("every pi JSON Schema compiles under pi-ai's resolved typebox 1.3.7", async () => {
    const require = createRequire(import.meta.url);
    const piAiManifest = require.resolve("@earendil-works/pi-ai/package.json");
    const piRequire = createRequire(piAiManifest);
    const typeboxManifest = piRequire.resolve("typebox/package.json");
    expect(
      (JSON.parse(readFileSync(typeboxManifest, "utf8")) as { version: string })
        .version
    ).toBe("1.3.7");
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
