# Build with brain-kit

If you want to build an integration or your own interface, start with the
public packages and the capability you need. You do not need to understand
every internal subsystem to use the toolkit.

## Pick the layer you are integrating

- The **core package** provides file-based capture, indexing, search, validation
  and the CLI/MCP surface.
- The **UI SDK and server** connect a host and agent backend to that brain.
- The **React UI and UI kit** provide application composition and rich answer
  components.
- **Modules** add content domains and workflows; providers implement specific
  infrastructure capabilities.

The [package overview on GitHub](../../README.md#developers) links to the
individual package READMEs. Read the README for the layer you will consume
rather than the entire implementation archive.

## Use an existing interface when changing a capability

Brain-kit exposes experimental extension interfaces for capabilities such as
embeddings, completions, reranking, agent runners and backends, speech, skill
emission and tool rendering. Choose the relevant existing interface and test
your implementation against its documented contract.

Storage, the index pipeline and the wire protocol are part of the product.
They are not interchangeable provider slots. The
[extension reference on GitHub](../extending/README.md) identifies the supported
seams and links to their detailed guides.

## Keep the host and the knowledge separate

A host composes the public packages and supplies its own authentication,
deployment shell and settings. The content repository holds the owner's
knowledge. UI package availability does not mean the public hosting starter
is ready or that a hosted account is provided.

Use the [UI package reference](../../packages/ui-react/README.md) for application
composition and the [HTTP/API reference](../http-api.md) when wiring a server.
The [integration contract](../integration-contract.md) records compatibility
boundaries. Pre-1.0 extension interfaces remain experimental.

## Go deeper only when the implementation calls for it

The [engineering index](../README.md) and [decision records](../decisions/README.md)
are maintained on GitHub. They explain exact APIs, tradeoffs and investigations.
They are background for implementation work, rather than chapters a new user
needs to read before keeping their first note.
