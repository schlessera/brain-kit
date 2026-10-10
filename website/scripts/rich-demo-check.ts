import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Page } from 'playwright';

export async function verifyDeviceGeometry(page: Page) {
  for (const device of await page.locator('.device-screen').all()) {
    const geometry = await device.evaluate(screen => {
      const app = screen.querySelector('iframe')!.getBoundingClientRect(); const box = screen.getBoundingClientRect();
      return { edges: [app.left - box.left, app.top - box.top, app.right - box.right, app.bottom - box.bottom], ratio: box.width / box.height, expected: Number((screen as HTMLElement).dataset.width) / Number((screen as HTMLElement).dataset.height) };
    });
    assert(geometry.edges.every(edge => Math.abs(edge) < 1), `App does not fit its device screen: ${JSON.stringify(geometry)}`);
    assert(Math.abs(geometry.ratio - geometry.expected) < .002, 'Device screen changed the app aspect ratio');
  }
}

export async function verifyRichDemo(page: Page, origin: string, base: string, captures: string, capture: boolean, errors: string[]) {
  // Zoom keeps the same iframe/document, holds page geometry, and returns focus.
  const frameElement = page.locator('iframe[data-side=right]');
  await page.locator('[data-open=right]').scrollIntoViewIfNeeded();
  const frame = await (await frameElement.elementHandle())!.contentFrame();
  const nonce = await frame!.evaluate(() => { (window as any).__identityProof = 'same-mounted-application'; return (window as any).__identityProof; });
  const original = await frameElement.boundingBox();
  const scroll = await page.evaluate(() => scrollY);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('[data-open=right]').click();
  assert(await page.locator('.is-zoomed').evaluate(stage => stage.getAnimations().some(animation => Number(animation.effect?.getTiming().duration) > 0)), 'Device expansion had no animation');
  await page.locator('.is-zoomed[role=dialog]').waitFor();
  await page.waitForTimeout(420);
  await verifyDeviceGeometry(page);
  assert.equal(await frame!.evaluate(() => (window as any).__identityProof), nonce, 'Zoom remounted the app');
  assert(await page.locator('.site-header').evaluate(element => (element as HTMLElement).inert), 'Expanded device left background focusable');
  assert((await frameElement.boundingBox())!.width > original!.width, 'Expanded phone did not grow');
  if (capture) await page.screenshot({ path: resolve(captures, 'expanded-phone.png') });
  await page.getByRole('button', { name: 'Close expanded demonstration', exact: true }).click();
  await page.locator('.is-zoomed').waitFor({ state: 'detached' });
  assert.equal(await frame!.evaluate(() => (window as any).__identityProof), nonce, 'Close remounted the app');
  assert.equal(await page.evaluate(() => scrollY), scroll, 'Zoom changed the page scroll position');
  assert.equal(await page.locator('[data-open=right]').evaluate(button => button === document.activeElement), true, 'Close did not restore focus');
  assert.equal(await page.locator('.site-header').evaluate(element => (element as HTMLElement).inert), false);
  await verifyDeviceGeometry(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('[data-open=left]').click(); await page.waitForTimeout(420);
  await page.frameLocator('iframe[data-side=left]').locator('body').press('Escape'); await page.waitForTimeout(340);
  assert.equal(await page.locator('.is-zoomed').count(), 0, 'Escape from inside the app did not close device zoom');

  const demo = await page.context().newPage(); demo.setDefaultTimeout(7000); demo.on('pageerror', error => errors.push(error.message));
  await demo.goto(`${origin}${base}demo/rich/?theme=light`, { waitUntil: 'domcontentloaded' });
  await demo.getByRole('tab', { name: /^Files/ }).click();
  async function openFile(path: string) {
    const reveal = demo.getByRole('button', { name: 'Reveal in tree', exact: true });
    if (await reveal.isVisible()) await reveal.click();
    const parts = path.split('/');
    // Rows are flat, and a name can recur at another depth (the library's
    // `ogygia/` beside `voyage/ogygia/`): take the first match after the
    // parent row, waiting for a just-expanded folder's children to load.
    async function rowAfter(name: string, after: number) {
      for (let attempt = 0; attempt < 70; attempt++) {
        for (const row of await demo.getByRole('treeitem', { name, exact: true }).all()) {
          const index = await row.evaluate(element => [...document.querySelectorAll('[role="treeitem"]')].indexOf(element));
          if (index > after) return { row, index };
        }
        await demo.waitForTimeout(100);
      }
      throw Error(`No tree row named ${name} below row ${after}`);
    }
    let after = -1;
    for (const part of parts.slice(0, -1)) {
      const { row, index } = await rowAfter(part, after);
      if (await row.getAttribute('aria-expanded') === 'false') await row.click();
      after = index;
    }
    await (await rowAfter(parts.at(-1)!, after)).row.click();
    await demo.locator('[title]').filter({ hasText: parts.at(-1)! }).first().waitFor();
  }
  async function download(trigger: string, option: string, extension: string) {
    await demo.getByRole('button', { name: trigger, exact: true }).last().click();
    const pending = demo.waitForEvent('download');
    await demo.getByRole('menuitem', { name: new RegExp(`^${option}`) }).click();
    const file = await pending;
    assert(file.suggestedFilename().endsWith(extension));
    assert.equal(await file.failure(), null, 'Browser refused the real download');
    return new Uint8Array(await Bun.file((await file.path())!).arrayBuffer());
  }
  await openFile('voyage/ogygia/departure-plan.md');
  await demo.getByRole('heading', { name: 'Departure from Ogygia', exact: true }).waitFor();
  const frontmatter = demo.getByRole('button', { name: /^frontmatter/ });
  assert.equal(await frontmatter.getAttribute('aria-expanded'), 'false');
  await frontmatter.click(); await demo.getByText('status: planned', { exact: true }).waitFor();
  await frontmatter.click();
  const markdown = await download('Share', 'Share as .md file', '.md');
  assert(new TextDecoder().decode(markdown).startsWith('---\ntitle:'));
  assert(new TextDecoder().decode(markdown).includes('status: "planned"'));
  const text = new TextDecoder().decode(await download('Share', 'Share body as plain text', '.txt'));
  assert(text.includes('Departure from Ogygia') && !text.includes('status: "planned"'));
  const png = await download('Share', 'Share as image', '.png'); assert.equal(png[0], 137);
  const pdf = await download('Share', 'Share as PDF', '.pdf'); assert.equal(new TextDecoder().decode(pdf.slice(0, 5)), '%PDF-');
  if (capture) await demo.screenshot({ path: resolve(captures, 'files-desktop.png') });
  await demo.getByRole('tab', { name: 'Raw', exact: true }).click();
  assert((await demo.locator('pre').textContent())!.includes('deadline: "2026-07-29"'));
  await demo.getByRole('tab', { name: 'Preview', exact: true }).click();
  await demo.getByText('people/calypso', { exact: false }).last().click();
  await demo.getByRole('heading', { name: 'Calypso', exact: true }).waitFor();
  assert.equal(await demo.getByRole('button', { name: /^frontmatter/ }).getAttribute('aria-expanded'), 'false');
  // A library record is browsable and shares as text; its image option says
  // why no PNG is prepared instead of substituting another record's export.
  await openFile('ithaca/suitors/roster.md');
  await demo.getByRole('heading', { name: 'The suitors, by island', exact: true }).waitFor();
  assert(new TextDecoder().decode(await download('Share', 'Share as .md file', '.md')).includes('title: "The suitors, by island"'));
  await demo.getByRole('button', { name: 'Share', exact: true }).last().click();
  await demo.getByRole('menuitem', { name: /^Share as image/ }).click();
  await demo.waitForFunction(() => [...document.querySelectorAll('button[title]')].some(button => (button as HTMLButtonElement).title.includes('Share this one as Markdown or text')));

  await openFile('voyage/ogygia/departure-plan.png');
  const image = demo.locator('img[alt="voyage/ogygia/departure-plan.png"]');
  await image.waitFor(); await demo.waitForFunction(() => [...document.images].some(image => image.alt === 'voyage/ogygia/departure-plan.png' && image.naturalWidth > 0));
  // Original image bytes must be identical to that file's PNG export.
  const originalImage = await download('Share', 'Share original', '.png');
  assert.equal(createHash('sha256').update(originalImage).digest('hex'), createHash('sha256').update(png).digest('hex'));
  await openFile('voyage/ogygia/departure-plan.pdf');
  await demo.locator('canvas').first().waitFor();
  await demo.waitForFunction(() => [...document.querySelectorAll('canvas')].some(canvas => canvas.width > 0 && canvas.height > 0));
  // A PDF file has one direct Share action; it must return the same bytes.
  const pendingPdf = demo.waitForEvent('download'); await demo.getByRole('button', { name: 'Share', exact: true }).click();
  const originalPdf = new Uint8Array(await Bun.file((await (await pendingPdf).path())!).arrayBuffer());
  assert.equal(createHash('sha256').update(originalPdf).digest('hex'), createHash('sha256').update(pdf).digest('hex'));
  await openFile('voyage/ogygia/departure-brief.html');
  await demo.frameLocator('iframe[title="HTML preview"]').getByRole('heading', { name: 'Departure from Ogygia', exact: true }).waitFor();
  await download('Share', 'Share as .html file', '.html');
  await download('Share', 'Share as image', '.png'); await download('Share', 'Share as PDF', '.pdf');
  await openFile('voyage/ogygia/passage.mmd');
  await demo.locator('svg[id^=brain-mermaid-]').first().waitFor();
  await download('Share', 'Vector', '.svg'); await download('Share', 'Image', '.png'); await download('Share', 'PDF', '.pdf');
  await download('Share', 'Share source file', '.mmd');

  // Actual message export includes the production DataTable, not just its prose.
  await demo.getByRole('tab', { name: /^Chat/ }).click();
  const composer = demo.locator('textarea[data-composer]');
  await composer.fill('crew ledger'); await composer.press('Enter');
  await demo.locator('[data-block=table]').waitFor();
  const ledgerPng = await download('Share message', 'Image', '.png');
  assert(!Buffer.from(ledgerPng).equals(Buffer.from(png)), 'Ledger shared the unrelated departure image');
  await download('Share message', 'PDF', '.pdf');
  await demo.setViewportSize({ width: 390, height: 844 });
  await demo.getByRole('tab', { name: 'Files', exact: true }).click();
  await demo.getByRole('button', { name: 'Show tree', exact: true }).click();
  await openFile('decisions/scylla-or-charybdis.md');
  await demo.getByRole('heading', { name: 'Scylla or Charybdis', exact: true }).waitFor();
  assert.equal(await demo.getByRole('button', { name: /^frontmatter/ }).getAttribute('aria-expanded'), 'false');
  assert(await demo.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  if (capture) await demo.screenshot({ path: resolve(captures, 'files-mobile.png') });
  await demo.close();
  console.log('Richer demo proof passed: persistent device zoom, frontmatter, linked files, live binary/HTML previews, actual PNG/PDF/Markdown/text/SVG downloads and a structured ledger export.');
}
