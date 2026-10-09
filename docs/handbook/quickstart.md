# Create your first brain

The goal is small: create a private home for your knowledge, save one note and
find it again. You can do this without choosing a model or enabling semantic
search.

## Create your private repository

Install [Bun](https://bun.sh), git and the [GitHub CLI](https://cli.github.com),
and sign in to the GitHub CLI. The public brain template supplies the starting
files. Create your own private copy and clone it:

```sh
gh repo create my-brain --template schlessera/brain-template --private --clone
cd my-brain
bun install
bun run setup
```

Keep the content repository private. It will contain your personal knowledge;
the public template and public toolkit do not need access to it. A private
repository controls access, but does not encrypt the files.

Setup installs the command and prepares agent skills. If your shell cannot
find `brain`, use `bun run brain` from this repository in place of `brain`
in the commands below.

## Build the index and capture a note

Build the initial search index, then capture a fictional example:

```sh
brain index
brain add "Odysseus needs timber and sailcloth for the raft." --title "Raft supplies"
brain search "sailcloth" --mode fts
```

The capture writes a Markdown note with frontmatter and updates the index.
The search finds it using its words. Read the returned path to inspect the
actual file:

```sh
brain read notes/raft-supplies.md
```

If that filename was already in use, capture chooses a different path; use
the path returned by your command.

## Personalize it when you are ready

You now have the basic loop: capture, find and read. Continue with
[Capture and find](daily-workflow.md) to connect a second note.

If you want an agent to help shape your brain, open this repository in a
signed-in coding agent that discovers the generated skills, then run
`/brain-init`. The interview proposes a structure for your needs and asks you
to review it. [Work with an agent](agents.md) explains that path.

## If a step does not work

Run `brain doctor --json` and read the detail for the failed check. The initial
index command fixes a missing database; warnings about optional providers do
not mean keyword search needs a paid account.

The [setup and troubleshooting reference on GitHub](../quickstart.md) covers
shell paths, client registration and the full onboarding sequence.
