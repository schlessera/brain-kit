# Work with an agent

An agent can do more than answer questions about your notes. It can follow
related records, compare choices, draft a plan and update the files that keep
that work useful after the conversation ends.

## Connect the agent to this brain

The brain template prepares two complementary pieces:

- **Tools** let a compatible agent search, read, add and update records through
  the MCP server.
- **Skills** guide workflows such as onboarding and reviewing captured notes.

Your client must load the tools and discover the skills. The template includes
project-scoped MCP configuration, but clients differ in how they read and
approve it. Registration alone does not prove that the current conversation
is using the intended brain. Ask the agent to read a known record and check
that it matches the file in your repository.

Use the [MCP registration reference on GitHub](../mcp.md#registration) for
client settings, and the [skill discovery reference](../extending/skill-emitters.md)
when slash workflows do not appear.

## Ask for an outcome and its evidence

For a fictional Odyssey brain, a useful request might be:

> Review the departure preparations. Show which records support the plan and
> which questions still need a decision.

This gives the agent work to do and a way for you to assess it. Follow the
source links, inspect the proposed changes and correct the assumptions before
asking it to act on the plan.

## Use guided workflows for repeated work

`/brain-init` helps propose a structure for your own brain. `/process-notes`
helps review the capture inbox. These workflows depend on the agent client
and its skill setup; MCP tools and slash commands are separate capabilities.

You can also use ordinary conversation to ask for a comparison, a draft or a
specific file update. Keep requests bounded enough to review the result.

## Know where judgment and permissions sit

Agents use their own model accounts or credentials. Their answers need review,
especially when a source is old, incomplete or contradictory. The agent can
operate on files, so its permissions matter too. Ordinary supported edits may
be allowed directly; gated operations can ask for approval. Read what an
approval will authorize before accepting it.

The [rich interface](interface.md) makes decisions, sources and work steps
visible alongside the conversation.
