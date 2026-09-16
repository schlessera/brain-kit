// The chat UI's own in-process tools, rendered from their contracts.
//
// Unlike the per-backend packs, this one is GLOBAL: the same contract is
// exposed by every backend under that backend's spelling of the name, so
// `bind()` registers each spelling and resolution does not depend on which
// backend owns the session. That also fixes a real gap — the location result
// only ever had a renderer under Claude's MCP-prefixed name, so the identical
// tool on pi fell through to the generic JSON view.

import type { RendererPack } from "@schlessera/brain-ui-sdk/client";
import { GET_CURRENT_LOCATION_CONTRACT } from "@schlessera/brain-ui-sdk/client";
import { MapPin } from "lucide-react";
import { LocationResultCard } from "../tool-cards/location-card.js";
import { ClampedPre } from "../tool-views.js";
import { bind } from "./bind.js";

export const brainUiToolPack: RendererPack = {
  renderers: [
    ...bind(GET_CURRENT_LOCATION_CONTRACT, LocationResultCard, {
      icon: MapPin,
      label: "Location",
      summary: (payload) => payload.place ?? payload.address ?? null,
      meta: (payload) => `±${Math.round(payload.accuracyMeters)} m`,
      // A denial, a timeout or a browser without geolocation answers with a
      // message, not a payload — the reader needs to see WHY there is no fix.
      Fallback: ({ tool }) =>
        tool.output ? <ClampedPre text={tool.output} isError={tool.isError} /> : null,
    }),
  ],
};
