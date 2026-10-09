# Back up and sync

Your files are the durable part of the brain. Keep an off-machine copy of the
repository before you worry about hosting an interface.

## Back up the repository

A private git remote is a simple place for a second copy. It preserves your
committed knowledge and change history. Confirm that the remote is private,
then make sure the files you intend to keep are actually committed and pushed.

Gitignored secrets and other untracked files are not in that backup. Large
assets may need a separate storage policy. Think through what you would need
to restore on a new machine, and check that those pieces have a backup too.

The search database is disposable: `brain index --force` rebuilds it from the
files. Keeping the database is not a substitute for backing up the repository.

## Use sync to reconcile changes

From the `main` branch of your brain, with its `origin` remote configured:

```sh
brain sync --human
```

Sync commits recognized content, pulls, merges and pushes. Some files or
conflicts still need judgment. It can invoke your configured agent runner;
if that runner or its account is unavailable, complete the handoff before
treating the sync as finished.

For the exact merge policies and commands, use the
[sync reference on GitHub](../daily-workflow.md#maintain-and-sync).

## Add phone access as a separate step

An optional host can provide the [rich interface](interface.md) over your brain.
That host supplies authentication, the agent backend and the PWA shell. It is
separate from the private content repository and has its own configuration.

The public hosting starter is still in development. A local brain and a
private remote work without it; UI packages are available for people building
their own host. Cached offline recording is limited, and agent work and server
history require a connection.

The [hosting reference on GitHub](../hosting/README.md) covers the technical
boundaries, and [media guidance](../media.md) explains the tradeoffs for large
files and git history.
