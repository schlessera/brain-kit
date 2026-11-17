// Shared furniture for the GitHub stories (#3800): the two widths every state
// is drawn at, and avatars served from the Storybook page's own origin, which
// is the only origin `GitHubIdentity` loads an image from.

import type { GitHubPerson } from "../../src/index.js";
import { viewportAt } from "../_viewports.js";

/** A phone: the 320px viewport, so width media queries answer as they would on one. */
export const narrow = { globals: viewportAt(320), parameters: { stageWidth: "none" } };

/** The design's desktop card width. */
export const desktop = { parameters: { stageWidth: 680 } };

// `?no-inline` keeps each a real URL on the page's origin: Vite would
// otherwise inline these small files as `data:` URLs, which the component
// rightly refuses.
import antinous from "./_avatars/antinous.svg?no-inline";
import eurymachus from "./_avatars/eurymachus.svg?no-inline";
import penelope from "./_avatars/penelope.svg?no-inline";
import philoetius from "./_avatars/philoetius.svg?no-inline";
import telemachus from "./_avatars/telemachus.svg?no-inline";

export const AVATARS = { telemachus, philoetius, antinous, eurymachus, penelope };

/** A person with a loaded, same-origin avatar. */
export const withAvatar = (person: GitHubPerson, name: keyof typeof AVATARS): GitHubPerson => ({ ...person, avatarSrc: AVATARS[name] });

/** Waits until every avatar inside `root` has loaded or failed, so a capture never catches one mid-load. */
export async function avatarsLoaded(root: ParentNode) {
  await Promise.all(
    [...root.querySelectorAll("img")].map((img) =>
      img.complete
        ? Promise.resolve()
        : new Promise((done) => {
            img.addEventListener("load", done, { once: true });
            img.addEventListener("error", done, { once: true });
          }),
    ),
  );
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
}
