export const externalIconPath = 'M9 2h5v5M14 2 7 9M6 3H2v11h11v-4';
export function externalLinkHost(href) {
  const url = new URL(href, 'https://schlessera.github.io');
  return ['http:', 'https:'].includes(url.protocol) && url.origin !== 'https://schlessera.github.io' ? url.host : null;
}
export function markExternalLinks() {
  return tree => {
    function visit(node) {
      if (node.type === 'element' && node.tagName === 'a' && node.properties?.href) {
        const host = externalLinkHost(node.properties.href);
        if (host) {
          node.properties.dataExternal = host;
          node.properties.title = `${node.properties.title ? node.properties.title + ' — ' : ''}External site: ${host}`;
          node.children.push(
            { type: 'element', tagName: 'svg', properties: { className: ['external-icon'], viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', ariaHidden: 'true' }, children: [{ type: 'element', tagName: 'path', properties: { d: externalIconPath }, children: [] }] },
            { type: 'element', tagName: 'span', properties: { className: ['sr-only'] }, children: [{ type: 'text', value: ` (external site: ${host})` }] },
          );
        }
      }
      for (const child of node.children || []) visit(child);
    }
    visit(tree);
  };
}
