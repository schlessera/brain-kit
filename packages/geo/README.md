# Shared geo operations

`@schlessera/brain-geo` is the concrete geospatial library shared by the CLI,
SDK server and travel module. It depends on none of its consumers. Endpoints
configure concrete services; there is no provider registry.

## Track parsing

The root export contains geometry helpers without server I/O or a rasterizer.
`parseGpx` preserves travel's strict parser and result: invalid coordinates reject;
track segments take precedence over routes; short sections are omitted.
`parseTrackGpx` uses the same XML reader with explicit recovery. It reports exact
input/retained/omitted counts and per-point reasons, splits at each invalid
coordinate and retains valid isolated points as source evidence. `no_line` means
no section has at least two points. Original segment gaps are preserved. Valid
zero, polar and repeated coordinates remain valid. Neither API changes the input.

Both refuse malformed XML, doctypes/entities, unsupported encodings/namespaces,
more than 128 nesting levels, 20 MiB inputs and more than 200,000 source points.
Invalid points count toward that limit. Missing/invalid optional elevation and
time remain unknown. File timestamps do not prove a route was travelled.

Travel's existing `routeMetrics`, trimming, quantization and whitelist GPX writer
are shared here with their existing meanings. Distances sum great-circle edges
within continuous sections; gaps contribute nothing. Elevation requires complete
samples, a three-point median and 3 m hysteresis. Ordered complete timestamps
supply elapsed intervals including pauses, without inter-section gaps.
