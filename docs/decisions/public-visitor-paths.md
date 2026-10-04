# Public visitor paths and release email

Maintainer rulings of 2026-10-01 and 2026-10-02 under
[#616](https://github.com/schlessera/brain-kit/issues/616) and the
[public-launch epic](https://github.com/schlessera/brain-kit/issues/608).
The [dated investigation](../visitor-feedback-investigation.md) compares
visitor journeys and mailing services. These choices bind the public website;
they do not authorize account creation, a paid plan, live signup, sending or
publication.

## Keep the useful outbound paths

Provide get-started, docs/source, GitHub question and bug-report links, the
existing security-reporting policy, and optional GitHub release notifications.
Name destinations and explain when posting needs a GitHub account or becomes
public. Preserve the product's maturity and template-availability limits.
GitHub release watching is separate from npm publication and from the email
list; the website cannot confirm a visitor's GitHub notification preferences.

The maintainer [selected outbound paths plus email release notifications](https://github.com/schlessera/brain-kit/issues/616#issuecomment-5940380662)
for visitors who do not use GitHub. A signup remains optional: no popup or
email wall interrupts first capture/search. Outbound links alone would omit
that approved audience. A private feedback/contact form and visitor analytics
were not selected; they would add collection and inbox ownership without the
chosen release-only purpose. Hosting and destination services have their own
operational data, so this policy makes no claim that visiting stores no data.

## Why Buttondown and a website form

The maintainer [selected Buttondown after the researched comparison](https://github.com/schlessera/brain-kit/issues/616#issuecomment-5940845881).
Managed delivery, Markdown drafts, confirmation and optional engagement
tracking fit a small release list. EmailOctopus offered more free capacity
but needed explicit confirmation and per-campaign tracking configuration.
MailerLite's broader automation and team features were unnecessary for this
workflow, with different capacity and deletion tradeoffs. listmonk would make
the project operate its service, database and mail delivery. Brevo's documented
free daily-send cap was a weaker fit for larger same-day release bursts;
that was a fit judgment, not inability to support the workflow. The dated
comparison preserves the prices and limits assessed, not permanent promises
or a measured deliverability ranking.

The [later presentation ruling selects a styled HTML form](https://github.com/schlessera/brain-kit/issues/616#issuecomment-5941850621),
superseding the earlier hosted-link choice. An ordinary POST navigates to
Buttondown's public embed-subscribe destination. Its
[official signup guide](https://docs.buttondown.com/building-your-subscriber-base)
requires that flow for provider validation and CAPTCHA responses. Use no
JavaScript fetch for this endpoint, secret browser API key or subscriber proxy.
The website owns accessible fields, validation and focus; Buttondown owns its
submission response. A hosted link offered less styling control, while an
iframe or custom API integration would change the selected interaction.
The public project submission URL must be verified, rather than invented.

## Minimal input and truthful confirmation

The [maintainer owns and operates one dedicated project newsletter](https://github.com/schlessera/brain-kit/issues/616#issuecomment-5941692714).
This accepts a single operator's ongoing release-editor, subscriber-request
and recovery responsibility instead of initial team-access setup.
The [only visitor-entered field is email address](https://github.com/schlessera/brain-kit/issues/616#issuecomment-5941746319):
names and custom profile fields add data and friction without serving release
notifications.

The [consent and confirmation ruling](https://github.com/schlessera/brain-kit/issues/616#issuecomment-5942150979)
selects clear release-announcement purpose beside **Subscribe**, no extra
checkbox, emailed confirmation before activation, unsubscribe access, and
both open and click engagement tracking disabled. Keep a persistent
**Email address** label and associated, actionable validation. Ordinary
form navigation must preserve the provider's challenge and error flow.
Submitting is not proof of acceptance, and accepted signup is not activation:
[double opt-in](https://docs.buttondown.com/double-opt-in) keeps a request
unactivated until its confirmation link is used. Explain pending confirmation;
describe confirmed subscription only after that result is established. A
failed or unverified response must not produce a success claim.

Tracking off does not remove the provider's operational metadata or anti-bot
safeguards. Its [canary-link documentation](https://docs.buttondown.com/canary-links)
distinguishes scanner protection from engagement analytics. Do not promise
that turning tracking off means the service stores only the visible email
field or guarantees no unwanted signup attempts.

## Cleanup retains suppression

The [retention ruling selects built-in soft-deletion cleanup](https://github.com/schlessera/brain-kit/issues/616#issuecomment-5942229382).
Enable the documented setting: unactivated and complained entries after
30 days, unsubscribed and blocked entries after 7 days. Confirmed addresses
remain while subscribed; unsubscribe stops release sending. These are the
provider's [documented cleanup intervals](https://docs.buttondown.com/subscriber-cleanup),
not measured project-account behavior. Suppression records remain to protect
opt-outs from stale imports. Ordinary cleanup is not complete erasure.

Provider-enabled hard deletion was rejected because it adds setup and
consistent deletion duties for exported copies. Do not maintain a separate
permanent subscriber list, prune by engagement with tracking off, or reactivate
someone from an old export without fresh confirmation. The maintainer owns
erasure requests and temporary copies. The provider's
[privacy policy](https://buttondown.com/legal/privacy) and
[DPA](https://buttondown.com/legal/data-processing-agreement) do not establish
a seven-day global backup/log purge. Disclose verified operational retention;
the earlier seven-day/90-day project proposals and a request-response deadline
were not adopted.

## Curated stable-release announcements

The [sending ruling selects manually reviewed meaningful stable releases](https://github.com/schlessera/brain-kit/issues/616#issuecomment-5942380758).
Write and review one project announcement after successful stable publication,
link public shipped changes, batch routine patches when useful, and allow
prompt corrective/security notices. Promise no fixed cadence. Per-version
mail would add repetitive low-value messages; a monthly digest could delay
useful updates. Curated sending accepts maintainer judgment and reminders.

Buttondown's [draft and sending workflow](https://docs.buttondown.com/sending-emails)
supports the manual approach. No per-package announcement, pre-release
campaign, RSS integration or automatic send trigger is selected. Publication
of lockstep packages does not itself send mail, and a policy ruling does not
authorize an actual message.

## Verification and ownership boundaries

The [website decision](public-website.md) supplies static Astro, canonical
Markdown and the project base. The homepage owns layout and the outbound
journeys; [#899](https://github.com/schlessera/brain-kit/issues/899) owns signup and provider handoff;
the launch review owns final integration, anonymous destination access and
separately authorized publication. All examples follow the
[sole-Odysseus world](example-corpus.md).

Offline browser proof uses fictional input and a controlled destination to
observe real form POST/navigation, validation, keyboard focus, 320px/desktop
layout, zoom and pending/error states. It never activates a real subscriber
or establishes the configured provider's delivery, CAPTCHA, unsubscribe or
cleanup behavior. Those require separately authorized account/browser evidence,
including the verified public submission destination, selected privacy
settings and truthful retention disclosure. No account credential or actual
subscriber belongs in public evidence. A green local harness or merged policy
record alone does not approve collection or launch.
