// The logo, favicon set and social card, taken from the files
// `@schlessera/brain-ui-kit` ships (#1424, #1425) rather than drawn here.
// Publication builds the site against a release's `packages/` tree, so these
// are whatever that release ships. `?no-inline` keeps every file a real URL:
// a favicon or an Open Graph image must not become a data URI.
import { HTML_ICON_LINKS } from '../../../packages/ui-kit/src/brand.ts';

const files = import.meta.glob<string>('../../../packages/ui-kit/assets/brand/*', { query: '?no-inline', import: 'default', eager: true });

/** The built URL of one packaged brand file, by its file name. */
export function brandFile(name: string): string {
  const url = files[`../../../packages/ui-kit/assets/brand/${name}`];
  if (!url) throw new Error(`@schlessera/brain-ui-kit ships no brand file named ${name}`);
  return url;
}

/** The head `<link>`s the kit declares for tab and home-screen icons, resolved to built URLs. */
export const iconLinks = HTML_ICON_LINKS.map((link) => ({ ...link, href: brandFile(link.href) }));
