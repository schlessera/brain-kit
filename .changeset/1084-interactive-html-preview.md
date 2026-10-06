---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
"@schlessera/brain-ui-sdk": patch
---

Run the scripts of HTML files in the file viewer, isolated from the app. A new authenticated `GET /api/files/html?path=…` serves an `.html`/`.htm` file under the same path, auth and size rules as `?raw=1`. Its CSP `sandbox allow-scripts` directive gives the document an opaque origin, and `connect-src 'none'` and `form-action 'none'` keep it off the network. It is the only response sent with `X-Frame-Options: SAMEORIGIN`; every other response keeps `DENY`. The viewer's preview now loads that route in an `allow-scripts` iframe, and an "Open in new tab" link opens it full-screen with the same isolation. A previewed page cannot read the app's DOM, cookies or storage, call `/api/*`, open popups, submit forms, download files or navigate the app. It can still navigate itself to another site, carrying what it can read, and a tab shows it under the app's host: both are accepted residual risks (#1084). The SDK's default service-worker policy never answers an `/api` navigation from the app shell.
