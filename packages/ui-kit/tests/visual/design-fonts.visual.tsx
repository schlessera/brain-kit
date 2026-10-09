import { expect, test } from "vitest";
import { loadDesignFonts, verifyDesignFonts } from "./design-font-checks.js";

test("locked design faces paint all roles and weights", async () => {
  console.info(`locked painted faces: ${JSON.stringify(await verifyDesignFonts())}`);
});

test("painted-font verification rejects absent font CSS", async () => {
  const style = document.querySelector<HTMLStyleElement>("style[data-design-fonts]")!;
  try {
    style.media = "not all";
    await document.fonts.ready;
    await expect(verifyDesignFonts()).rejects.toThrow(/painted DM Serif Text glyphs/);
  } finally { style.media = ""; await loadDesignFonts(); }
  await verifyDesignFonts();
});

test("a loaded local alias cannot impersonate the design face", async () => {
  const alias = new FontFace("JetBrains Mono", 'local("Liberation Mono")', { weight: "400 700" });
  try {
    document.fonts.add(await alias.load());
    expect(document.fonts.check("500 16px 'JetBrains Mono'"), "declaration-only check still passes").toBe(true);
    await expect(verifyDesignFonts()).rejects.toThrow(/painted JetBrains Mono glyphs/);
  } finally { document.fonts.delete(alias); }
  await verifyDesignFonts();
});
