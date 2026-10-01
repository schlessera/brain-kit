import { rmSync } from 'node:fs';
// Collection digests do not include an imported plugin's implementation.
// Every measured build recompiles Markdown after changing the URL transform.
rmSync(new URL('./dist/cache/', import.meta.url), { recursive: true, force: true });
