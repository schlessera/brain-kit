# Configure your brain

Your brain can start with almost no custom settings. Change the configuration
when you can name what you want to improve: a new kind of record, an optional
provider or a domain workflow.

## Know which settings belong where

`brain.config.ts` lives in your content repository. It describes your brain's
profile, document types, providers and enabled modules. A UI host has its own
server and browser settings; changing the content configuration does not
create or configure a hosted PWA.

The smallest TypeScript configuration is:

```ts
import { defineConfig } from "@schlessera/brain";

export default defineConfig({});
```

Built-in types cover identity, context, notes and directory indexes. You can
keep those defaults while you learn which structure suits your work.

## Change one thing, then validate it

For example, a fictional Odyssey brain can give its profile a name:

```ts
import { defineConfig } from "@schlessera/brain";

export default defineConfig({
  profile: { name: "Odysseus" },
});
```

After editing the configuration, run:

```sh
brain config check
```

Read and resolve validation errors before relying on the new setting. The
configuration helper assists your editor; validation happens when brain-kit
loads the configuration.

## Grow the structure with your work

Add types when existing notes need a distinct kind of record. Add a
[module](modules.md) when a domain needs its own workflow. Choose
[semantic search](search.md) when searching by words is missing useful context.

Keep provider credentials in the gitignored environment file rather than
committing them with your notes. Provider features are optional, and each
provider has its own account and privacy implications.

The [complete configuration reference on GitHub](../configuration.md) is the
place to look up an exact key, default or environment variable. It follows
repository source; check your installed version before adopting a newer setting.
