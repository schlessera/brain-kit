# Add domain workflows

A module adds the vocabulary and workflows for one kind of work. Use one when
ordinary notes are no longer enough for that domain, rather than installing
every module before you know what you need.

## Choose a module for a concrete need

First-party modules cover domains such as speaking, travel, job opportunities,
finance and images. They can contribute document types, skills and commands.
Their package READMEs explain the fields and workflows for that domain.

For example, a speaking module can organize talks and conferences; a travel
module can organize journeys and places. These records remain files in your
brain. A module supplies structure around them, rather than moving the domain
into a separate database that owns your knowledge.

## Install it before enabling it

For the speaking module:

```sh
bun add @schlessera/brain-module-speaking
```

Keep first-party module versions aligned with your installed brain-kit release.
Add the module to the `modules` section of your existing configuration:

```ts
modules: {
  "@schlessera/brain-module-speaking": {},
}
```

Then validate the configuration and synchronize the agent skills:

```sh
brain config check
brain skills sync
```

Each module has its own optional settings. Start with its documented defaults
and add the fields your workflow needs.

## Park a workflow without deleting its records

The enable and disable commands let you reactivate or park a configured module:

```sh
brain module disable @schlessera/brain-module-speaking
brain module enable @schlessera/brain-module-speaking
```

Disabling keeps the configuration and domain documents. It changes which
workflows are active; it is not a promise to revoke tools already loaded by
a running agent process.

Use the [module inventory and configuration reference on GitHub](../modules.md)
to choose a package, then read its own README before adding domain records.
