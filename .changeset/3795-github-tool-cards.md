---
"@schlessera/brain-ui-react": minor
---

The host GitHub tools' results now render as the dedicated ui-kit GitHub components instead of raw tool output, on every backend and under every spelling of the tool names:

- **Reads:** an issue or pull request read and an issue search render as their own components.
- **Writes:** the issue and comment tools show exactly what will be posted on their approval card, then the posted object, or why nothing was posted.

The mapping is honest:

- Absent checks, unknown review states and deleted authors read as absent.
- Every direct GitHub link is re-checked with the tool contract's validator before it renders.
- Avatars come only from the brain's own avatar route.

On-demand parts of a pull request or issue (earlier comments, commits, files, checks, line comments) load only when the reader asks. They load through the session's detail route, show their loading, empty, error, rate-limited and unavailable states, and never reach the model.
