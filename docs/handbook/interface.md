# Use the rich interface

The interface brings conversation, your files and the agent's work into one
place. It helps you understand a result and respond to the parts that need
your judgment, rather than treating every answer as a block of chat text.

## Read the result in the form it needs

Answers can contain structured tables, checklists, maps and diagrams. Question
cards let you choose answers or rank priorities. A departure discussion can
show a supply table and ask which preparation matters first, then use your
answer in the next step.

Source links give you a way to inspect supporting records. Keep the distinction
between a generated suggestion and the files that substantiate it.

## Open the file behind the answer

The file viewer displays Markdown, images, PDFs, HTML and diagrams. Markdown
frontmatter starts collapsed so you can read the body first and inspect the
metadata when needed. Related links let you follow the context into another
record.

Sharing depends on the content and available services. Supported menus offer
original files, text or richer exports such as images and PDFs. A configured
renderer provides server-generated exports; browser and device support affect
the native share sheet and download behavior.

## Follow the work and make the decision

Run views expose agent activity and tool steps. Approval cards ask you to allow
or deny a gated operation. Read the operation and its scope before approving
it. A structured question or ranking card is another way to supply the
judgment the agent needs to continue.

## Capture from a phone when the host supports it

Configured voice capture lets you review and edit a transcription before
sending it. A PWA host can also provide reviewed operating-system share intake,
notifications and durable local recordings. Microphone permissions, browser
support, connectivity and the chosen voice provider affect what is available.

Cached offline recording is limited. Server history, transcription and agent
execution require a connection; an installable shell does not make the whole
system work offline.

## Where to try it, and what is available today

The [website demo](https://schlessera.github.io/brain-kit/#demo) uses the real
components with staged Odyssey data. It lets you explore these interactions
without a model account or access to your own brain.

Brain-kit publishes UI and server packages for a host to compose. The public
hosting starter is still in development; the toolkit does not create a hosted
account for you. [Back up and sync](hosting.md) separates the useful local
workflow from optional hosting. Developers can use the
[UI package reference on GitHub](../../packages/ui-react/README.md).
