# Interactive HTML preview

**Decided by the maintainer on 2026-10-06 in #1084 (option A).**

An HTML file's script runs in the file viewer and in a new tab. It runs in an
opaque origin, never at the app's origin. `GET /api/files/html` serves the
file with a CSP whose `sandbox allow-scripts` directive gives the document
that opaque origin, whether it is framed or top-level. The viewer frames it
with `sandbox="allow-scripts"`. Neither grants `allow-same-origin`,
`allow-popups`, `allow-forms`, `allow-downloads` or `allow-top-navigation`.
`connect-src 'none'` and `form-action 'none'` keep the page off the network.
The headers are specified in
[the HTTP API](../http-api.md#interactive-html-preview-additive-1084).

## What the isolation rests on

- **The browser, not the cookie.** In `AUTH_MODE=password` a request from the
  opaque origin carries no `SameSite=Strict` session cookie. In `tailscale`,
  `proxy` and `none` modes the server would authorize a GET from it, because
  the origin policy covers non-GET methods only. `connect-src 'none'` is
  therefore the API barrier in every mode. The runtime test proves it by
  showing that no probe request reaches the server, including in `none` mode,
  where a control request does.
- **Two layers that each hold alone.** The response's CSP `sandbox` isolates a
  tab, where no iframe attribute exists. The iframe attribute isolates the
  preview even with the CSP `sandbox` removed. Mutation receipts for each are
  in the PR that added them.

## Accepted residual risks

No CSP directive restricts navigation (`navigate-to` never shipped), and a
sandboxed document may navigate itself.

- A script in the preview can navigate its frame to any URL, and a script in
  the tab can navigate the tab. Either can carry what the page can read: its
  own file and anything typed into it. It cannot read other brain data.
- The tab shows untrusted content under the app's host, so a page could
  imitate an app screen.

`packages/ui-react/tests/html-preview-runtime.test.ts` asserts both as
documented behaviour, so a change to either is a reviewed diff. The response
sends `Referrer-Policy: no-referrer`, so such a navigation does not also
disclose the file's path.

## Alternatives rejected

Each is set out in the #1084 readiness comment.

- **An app-owned wrapper page for the new tab (B).** It would remove the
  same-host display risk, at the cost of a new SPA route.
- **Preview only, no new tab (C).** It would drop a requested capability.
- **A separate origin for untrusted content (D).** It is the only option that
  lets the address bar tell the content apart from the app. It needs
  deployment configuration that self-hosters do not have by default.
- **Running the file at the app's origin.** The file would act as the
  signed-in user. That is why `?raw=1` runs no script, which is unchanged, and
  why the preview this replaces used a script-less `sandbox=""` srcdoc.
