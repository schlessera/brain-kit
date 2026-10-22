import { expect, test } from "vitest";
import { DESKTOP, SURFACE, allowed, mount, pointer, settle, startsAt, targets, themeOf, walk } from "./navigation-reach-fixture.js";

for (const width of DESKTOP) for (const start of startsAt(width)) for (const [name, target] of Object.entries(targets)) {
  test(`D52 §2 desktop matrix at ${width} from ${start}: ${name}`, async (ctx) => {
    const mode = pointer();
    const s = await mount(ctx, start, { width, theme: themeOf(start) });
    s.writes.length = 0;
    // Already there is 0 (D52 §2); otherwise the adopted path.
    const steps = target.reached(s) ? [] : target.path(start, width);
    await walk(s, steps, mode, `${name} from ${start}`);
    await expect.poll(() => target.reached(s), { message: `${name} from ${start} at ${width} (${mode}) after ${steps.length}` }).toBe(true);
    await expect.poll(() => SURFACE[name]!(s), { message: `${name} is drawn, not only flagged, from ${start} at ${width}` }).toBe(true);
    expect(steps.length, `activations to ${name} from ${start} at ${width} (D52 §2)`).toBe(allowed(name, start, width));
    // Opening Search, Add, the briefing or a panel writes nothing; Sync
    // starts its own job and nothing else. The briefing only reads (#1391).
    await settle(s);
    const job = name === "Sync" ? ["POST /api/brain/sync"] : [];
    await expect.poll(() => s.writes, { message: `${name} from ${start}: requests that write` }).toEqual(job);
    expect(document.documentElement.scrollWidth, "no horizontal overflow").toBeLessThanOrEqual(width);
  });
}
