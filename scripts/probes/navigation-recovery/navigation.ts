import { resolve } from "node:path";
import { createHarness } from "./harness.ts";
const { results, state, reset, open, persist, close, output } =
  await createHarness("navigation");
try {
  for (const theme of ["dark", "light"])
    for (const width of [320, 390, 480, 900, 1280, 1440])
      for (const coarse of [false, true]) {
        const p = await open(width, coarse, theme);
        await reset(p, false);
        const viewport = await p.evaluate(() => ({
          innerWidth,
          innerHeight,
          coarse: matchMedia("(pointer: coarse)").matches,
          fine: matchMedia("(any-pointer: fine)").matches,
        }));
        const nav = p
          .getByRole("navigation", { name: "Primary" })
          .filter({ visible: true });
        const rects = await nav.evaluateAll((ns) =>
          ns.flatMap((n) =>
            [...n.querySelectorAll('[role="tab"],button')].map((e) => {
              const b = e.getBoundingClientRect();
              return {
                label: e.getAttribute("aria-label") ?? e.textContent,
                width: b.width,
                height: b.height,
                x: b.x,
                y: b.y,
              };
            })
          )
        );
        const cap = p.getByText("⌘K", { exact: true }).first();
        const capBefore = await p.getByRole("listbox").count();
        let capGeometry: any = null;
        if (await cap.isVisible()) {
          capGeometry = await cap.boundingBox();
          if (coarse) await cap.tap();
          else await cap.click();
        }
        const capAfter = await p
          .getByRole("listbox")
          .filter({ visible: true })
          .count();
        await p.keyboard.press("Control+k");
        const keyboardPalette = await p
          .getByRole("listbox")
          .filter({ visible: true })
          .count();
        let commands: any = [];
        if (keyboardPalette) {
          commands = await p.getByRole("option").evaluateAll((es) =>
            es.map((e) => ({
              text: e.textContent,
              disabled: e.getAttribute("aria-disabled"),
              rect: (() => {
                const r = e.getBoundingClientRect();
                return { x: r.x, y: r.y, width: r.width, height: r.height };
              })(),
            }))
          );
          await p.keyboard.press("Escape");
        }
        const welcome = await p
          .getByRole("button", { name: "Search…", exact: true })
          .count();
        await p.getByRole("button", { name: "Search…", exact: true }).click();
        await p.waitForTimeout(200);
        const searchOpen = (await state(p)).ui.searchPanelOpen;
        await reset(p, true);
        const newRect = await p
          .getByRole("button", { name: "New chat", exact: true })
          .boundingBox();
        if (width < 480) {
          const more = p.getByRole("tab", { name: "More", exact: true });
          await more.click();
          await p.waitForTimeout(300);
          const rows = await p
            .getByRole("dialog", { name: "More" })
            .getByRole("button")
            .evaluateAll((es) =>
              es.map((e) => ({
                text: e.textContent,
                disabled: e.getAttribute("aria-disabled"),
                rect: (() => {
                  const r = e.getBoundingClientRect();
                  return { x: r.x, y: r.y, width: r.width, height: r.height };
                })(),
              }))
            );
          results.navigation.push({
            width,
            coarse,
            theme,
            viewport,
            rects,
            capGeometry,
            capBefore,
            capAfter,
            keyboardPalette,
            commands,
            welcome,
            searchOpen,
            newRect,
            moreRows: rows,
          });
        } else
          results.navigation.push({
            width,
            coarse,
            theme,
            viewport,
            rects,
            capGeometry,
            capBefore,
            capAfter,
            keyboardPalette,
            commands,
            welcome,
            searchOpen,
            newRect,
          });
        await p.screenshot({
          path: resolve(
            output,
            `navigation-${theme}-${width}-${coarse ? "coarse" : "fine"}.png`
          ),
        });
        await persist();
        await p.context().close();
      }
  await persist();
  console.log(
    "navigation matrix saved",
    results.navigation.length,
    results.faults
  );
} finally {
  await close();
}
