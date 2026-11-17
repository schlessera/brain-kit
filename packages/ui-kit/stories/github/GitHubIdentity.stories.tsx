import preview from "#.storybook/preview";
import { expect, waitFor } from "storybook/test";

import { antinous, brainBot, eurycleia, ghost, longLogin, penelope, philoetius, telemachus } from "../../fixtures/github.js";
import { GitHubIdentity, GitHubParticipants } from "../../src/github/GitHubIdentity.js";
import { Row, stage } from "../_stage.js";
import { avatarsLoaded, desktop, narrow, withAvatar } from "./_github.js";

/**
 * A person named on GitHub (#3800, design #3795 revision 2 §4′). The login
 * and its tags are the identity; the avatar is decoration and loads only
 * from the page's own origin (the brain's proxy).
 */
const meta = preview.meta({
  title: "GitHub/GitHubIdentity",
  component: GitHubIdentity,
  decorators: [stage],
  args: telemachus,
});

/** Every identity state: loaded, the initials (loading, failed and absent look the same on purpose), bot, ghost, a long login. */
export const States = meta.story({
  ...desktop,
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
      <Row caption="loaded">
        <GitHubIdentity {...withAvatar(telemachus, "telemachus")} />
      </Row>
      <Row caption="failed">
        <GitHubIdentity {...eurycleia} avatarSrc="./_avatars/missing-avatar.svg" />
      </Row>
      <Row caption="absent">
        <GitHubIdentity {...antinous} />
      </Row>
      <Row caption="refused">
        <GitHubIdentity {...penelope} avatarSrc="https://avatars.githubusercontent.com/u/1?v=4" />
      </Row>
      <Row caption="bot">
        <GitHubIdentity {...brainBot} />
      </Row>
      <Row caption="deleted">
        <GitHubIdentity {...ghost} />
      </Row>
      <Row caption="long login">
        <GitHubIdentity {...withAvatar(longLogin, "eurymachus")} />
      </Row>
    </div>
  ),
  play: async ({ canvasElement }) => {
    await avatarsLoaded(canvasElement);
    const imgs = [...canvasElement.querySelectorAll("img")];
    // Only the same-origin avatars render an image; the GitHub URL makes no element at all.
    await expect(imgs.map((img) => img.getAttribute("src")!).every((src) => new URL(src, document.baseURI).origin === location.origin)).toBe(true);
    await expect(imgs.some((img) => img.src.includes("githubusercontent"))).toBe(false);
    await waitFor(() => expect(canvasElement.querySelectorAll("[data-avatar-state='loaded']")).toHaveLength(2));
  },
});
export const StatesNarrow = States.extend({ ...narrow });

/**
 * The moment before the image arrives: the initials show at once, with no
 * shimmer, exactly as a failed or absent avatar does. The avatar is a
 * same-origin request the Storybook server holds open, so the story stays in
 * that state.
 */
export const AvatarLoading = meta.story({
  args: { ...penelope, avatarSrc: "/__held-avatar.svg" },
  ...desktop,
  play: async ({ canvasElement }) => {
    const avatar = canvasElement.querySelector("[data-avatar-state]")!;
    await expect(avatar.getAttribute("data-avatar-state")).toBe("pending");
    await expect(getComputedStyle(canvasElement.querySelector("img")!).visibility).toBe("hidden");
    await expect(avatar.textContent).toBe("PE");
  },
});
export const AvatarLoadingNarrow = AvatarLoading.extend({ ...narrow });

/** Participants: up to four faces, then +n, and the count in words. */
export const Participants = meta.story({
  ...desktop,
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <GitHubParticipants people={[withAvatar(telemachus, "telemachus"), withAvatar(philoetius, "philoetius"), eurycleia, withAvatar(antinous, "antinous")]} count={4} />
      <GitHubParticipants people={[withAvatar(telemachus, "telemachus"), withAvatar(philoetius, "philoetius"), withAvatar(antinous, "antinous"), withAvatar(longLogin, "eurymachus")]} count={11} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await avatarsLoaded(canvasElement);
    await expect(canvasElement.textContent).toContain("+7");
    await expect(canvasElement.textContent).toContain("11 people");
  },
});
export const ParticipantsNarrow = Participants.extend({ ...narrow });

