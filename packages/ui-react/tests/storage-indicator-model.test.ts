import { describe, expect, test } from "bun:test";
import { storageFormat, storageVolumes } from "../src/components/settings/storage/storage-volumes.js";
import { storageIndicator } from "../src/components/settings/storage/storage-indicator-model.js";
import {
  GB,
  ITHACA,
  OGYGIA,
  SCHERIA,
  brainRoots,
  capacity,
  evidence,
  guidance,
  inventory,
  pressure,
  twoVolumes,
  unavailable,
  worldTime,
} from "./fixtures/storage-volumes.js";

const format = storageFormat("UTC");
const indicate = (input: Parameters<typeof storageVolumes>[0], error: string | null = null) =>
  storageIndicator(storageVolumes({ ...input, format }), input.guidance!, error);

describe("app-wide indicator (#4547)", () => {
  test("with one Low and one Very-low volume, it names the Very-low one", () => {
    const { inventory: snapshot, guidance: response } = twoVolumes();
    const view = indicate({ guidance: response, inventory: snapshot });
    expect(view).toEqual({
      text: "App data disk very low",
      ariaLabel: "Open Storage: App data disk very low",
      severity: "critical",
      volumeId: SCHERIA,
      uncertain: false,
    });
  });

  test("between two Low volumes, measurement order decides", () => {
    const { inventory: snapshot, brain, app } = twoVolumes();
    const response = guidance([
      pressure(ITHACA, "low", evidence(ITHACA, brain.total, brain.available)),
      pressure(SCHERIA, "low", evidence(SCHERIA, app.total, app.available)),
    ]);
    expect(indicate({ guidance: response, inventory: snapshot }).text).toBe("Brain disk low");
  });

  test("its name equals the pane's volume card name for the same fixture", () => {
    const { inventory: snapshot, guidance: response } = twoVolumes();
    const volumes = storageVolumes({ guidance: response, inventory: snapshot, format });
    const view = storageIndicator(volumes, response);
    const card = volumes.find((volume) => volume.id === view.volumeId)!;
    expect(view.text).toBe(`${card.name} very low`);
    expect(view.ariaLabel.startsWith(`Open Storage: ${card.name} `)).toBe(true);
  });

  test("an unknown identity shows the generic fallback and never invents a name", () => {
    const unjoined = guidance([pressure(OGYGIA, "critical", null, { stores: [{ label: "Brain files", owner: "brain" }] })]);
    expect(indicate({ guidance: unjoined, inventory: inventory([], []) })).toEqual({
      text: "Storage warning · very low",
      ariaLabel: "Open Storage: Storage warning · very low",
      severity: "critical",
      volumeId: null,
      uncertain: false,
    });
    // No inventory to join at all: still no name.
    expect(indicate({ guidance: unjoined, inventory: null }).text).toBe("Storage warning · very low");
    const unresolved = inventory([capacity(OGYGIA, [brainRoots[0]!.id], null, null, { identity: "unknown", kind: "unknown" })], brainRoots);
    expect(indicate({ guidance: guidance([pressure(OGYGIA, "low", null)]), inventory: unresolved }).text).toBe("Storage warning · low");
  });

  test("the accessible name carries the severity and the stale qualifier", () => {
    const { inventory: snapshot, app } = twoVolumes();
    const old = evidence(SCHERIA, app.total, app.available, { at: worldTime - 7 * 3_600_000, fresh: false, short: unavailable("stale"), long: unavailable("stale") });
    const view = indicate({ guidance: guidance([pressure(SCHERIA, "critical", old, { state: "unknown" })]), inventory: snapshot });
    expect(view.text).toBe("App data disk very low · out of date");
    expect(view.ariaLabel).toBe("Open Storage: App data disk very low, out of date");
  });

  test("unknown evidence keeps its qualifier", () => {
    const { inventory: snapshot, guidance: response } = twoVolumes();
    expect(indicate({ guidance: { ...response, pending: true }, inventory: snapshot }).ariaLabel).toBe(
      "Open Storage: App data disk very low, evidence unknown"
    );
    expect(indicate({ guidance: response, inventory: snapshot }, "unavailable").text).toBe("App data disk very low · evidence unknown");
  });

  test("with no Low or Very-low volume, the neutral wording stays", () => {
    const { inventory: snapshot } = twoVolumes();
    const calm = guidance([pressure(ITHACA, "observed", evidence(ITHACA, 161 * GB, 60 * GB)), pressure(SCHERIA, "observed", null)]);
    expect(indicate({ guidance: calm, inventory: snapshot })).toMatchObject({ text: "Storage · Capacity observed", severity: null, volumeId: null });
    expect(indicate({ guidance: { ...calm, state: "unknown" }, inventory: snapshot }).text).toBe("Storage · Capacity unknown");
  });
});
