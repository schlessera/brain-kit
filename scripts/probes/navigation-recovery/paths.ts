import { createHarness } from "./harness.ts";
const { results, state, reset, open, persist, close, requests } =
  await createHarness("paths");
try {
  for (const width of [390, 900]) {
    const p = await open(width, width === 390, "dark");
    for (const from of [
      "empty-chat",
      "occupied-chat",
      "activity",
      "files",
      "graph",
      "settings",
    ])
      for (const act of [
        "New chat",
        "Sessions",
        "Search the brain",
        "Add a note",
        "Daily briefing",
        "Sync the brain",
        "Brain statistics",
      ]) {
        await reset(p, from !== "empty-chat");
        if (!from.includes("chat"))
          await p.evaluate((v) => (window as any).probe.view(v), from);
        await p.waitForTimeout(100);
        await p.waitForTimeout(250);
        const before = await state(p),
          http = requests.length;
        let count = 0;
        let route = "";
        let unavailable: string | null = null;
        try {
          if (width === 900) {
            await p.keyboard.press("Control+k");
            count++;
            route = "keyboard palette";
            const item = p.getByRole("option", { name: new RegExp(act) });
            await item.click({ timeout: 2000 });
            count++;
          } else {
            if (["files", "settings"].includes(from)) {
              const close =
                from === "files"
                  ? p
                      .getByRole("heading", { name: "Files", exact: true })
                      .filter({ visible: true })
                      .locator("..")
                      .getByRole("button")
                  : p.getByRole("button", {
                      name: "Close Settings",
                      exact: true,
                    });
              if (await close.isVisible()) {
                await close.click({ timeout: 2000 });
                count++;
                await p.waitForTimeout(350);
              } else {
                unavailable = "panel has no visible close in fixture";
                throw Error(unavailable);
              }
            }
            if (["New chat", "Search the brain", "Add a note"].includes(act)) {
              if (["activity", "graph"].includes(from)) {
                await p.getByRole("tab", { name: "Chat", exact: true }).click();
                count++;
                await p.waitForTimeout(100);
              }
              if (act === "New chat") {
                const button = p.getByRole("button", {
                  name: "New chat",
                  exact: true,
                });
                if (await button.isVisible()) {
                  await button.click({ timeout: 2000 });
                  count++;
                  route = "chat disc";
                } else {
                  await p
                    .getByRole("tab", { name: "More", exact: true })
                    .click({ timeout: 2000 });
                  count++;
                  await p
                    .getByRole("button", { name: /Sessions/ })
                    .last()
                    .click();
                  count++;
                  await p
                    .getByRole("button", {
                      name: "New conversation",
                      exact: true,
                    })
                    .click();
                  count++;
                  route = "More/Sessions/New conversation";
                }
              } else {
                if (from === "empty-chat" && act === "Search the brain") {
                  await p
                    .getByRole("button", { name: "Search…", exact: true })
                    .click();
                  count++;
                  route = "welcome";
                } else {
                  await p
                    .locator("textarea")
                    .fill(act === "Add a note" ? "/add" : "/search");
                  await p
                    .getByRole("button", {
                      name:
                        act === "Add a note"
                          ? "/add Add a note"
                          : "/search Search knowledge base",
                      exact: true,
                    })
                    .click();
                  count++;
                  route =
                    "slash (typing prerequisite excluded from activation count)";
                }
              }
            } else {
              await p
                .getByRole("tab", { name: "More", exact: true })
                .click({ timeout: 2000 });
              count++;
              await p
                .getByRole("dialog", { name: "More" })
                .getByRole("button", { name: new RegExp(act) })
                .click({ timeout: 2000 });
              count++;
              route = "More";
            }
          }
        } catch (error) {
          unavailable = String(error).slice(0, 300);
        }
        await p.waitForTimeout(100);
        const after = await state(p);
        results.navigation.push({
          width,
          from,
          act,
          count,
          route,
          unavailable,
          before: before.ui,
          after: after.ui,
          activeBefore: before.active,
          activeAfter: after.active,
          requests: requests.slice(http),
        });
        await persist();
      }
    for (const from of [
      "empty-chat",
      "occupied-chat",
      "activity",
      "files",
      "graph",
      "settings",
    ]) {
      for (const destination of [
        "Chat",
        "Actions",
        "Files",
        "Graph",
        "Settings",
      ]) {
        await reset(p, from !== "empty-chat");
        if (!from.includes("chat"))
          await p.evaluate((v) => (window as any).probe.view(v), from);
        await p.waitForTimeout(350);
        let count = 0;
        if (width === 390 && ["files", "settings"].includes(from)) {
          const close =
            from === "files"
              ? p
                  .getByRole("heading", { name: "Files", exact: true })
                  .filter({ visible: true })
                  .locator("..")
                  .getByRole("button")
              : p.getByRole("button", { name: "Close Settings", exact: true });
          await close.click({ timeout: 2000 });
          count++;
          await p.waitForTimeout(350);
        }
        // This fixture intentionally mounts only the selected page. Files/Settings
        // live inside ChatPage today, so a non-Chat page needs a Chat activation.
        const viaChat =
          ["activity", "graph"].includes(from) &&
          ["Files", "Settings"].includes(destination);
        if (viaChat) {
          await p
            .getByRole("navigation", { name: "Primary" })
            .filter({ visible: true })
            .getByRole("tab", { name: /^Chat/ })
            .click();
          count++;
        }
        if (destination === "Settings" && width === 390) {
          await p.getByRole("tab", { name: "More", exact: true }).click();
          count++;
          await p
            .getByRole("dialog", { name: "More" })
            .getByRole("button", { name: "Settings", exact: true })
            .click();
          count++;
        } else {
          await p
            .getByRole("navigation", { name: "Primary" })
            .filter({ visible: true })
            .getByRole("tab", { name: new RegExp("^" + destination) })
            .click();
          count++;
        }
        await p.waitForTimeout(100);
        results.destinations ??= [];
        results.destinations.push({
          width,
          from,
          destination,
          count,
          viaChat,
          ui: (await state(p)).ui,
        });
        await persist();
      }
    }

    await p.context().close();
  }
  console.log("Path cases", results.navigation.length, results.faults);
} finally {
  await close();
}
