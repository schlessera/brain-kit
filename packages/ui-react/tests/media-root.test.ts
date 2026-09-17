import { describe, expect, test } from "bun:test";
import { createBrainUiRoot } from "../src/root.js";
import { fetchAsFile, renderToFile } from "../src/lib/share.js";
import { uploadShare } from "../src/lib/share-intake.js";
import { repoImageSrc } from "../src/components/chat/brain-markdown-links.js";

describe("media services use their explicit UI root", () => {
  test("rendering, file bytes and multipart uploads retain their transport and base", async () => {
    const calls: Array<{ owner: string; url: string; init?: RequestInit }> = [];
    const make = (owner: string) => createBrainUiRoot({ storage: null, config: { backendUrl: `https://${owner}.example` }, request: async (url, init) => {
      calls.push({ owner, url, init });
      return url.endsWith("/share") ? Response.json({ dir: owner, files: [] }) : new Response(owner);
    } });
    const a = make("alpha"); const b = make("beta");
    try {
      const [png, file, upload] = await Promise.all([
        renderToFile(a, { content: "Alpha", contentType: "markdown", format: "png" }, "message.md"),
        fetchAsFile(b, b.backendUrl("/api/files/content?path=notes%2Fphoto.png&raw=1"), "photo.png"),
        uploadShare({ id: "shared", receivedAt: 1, title: "Example", files: [] }, b.request, b.apiBase()),
      ]);
      expect(await png.text()).toBe("alpha"); expect(png.name).toBe("message.png");
      expect(await file.text()).toBe("beta"); expect(upload.ok).toBe(true);
      expect(calls.map(c => c.url)).toEqual([
        "https://alpha.example/api/render", "https://beta.example/api/files/content?path=notes%2Fphoto.png&raw=1", "https://beta.example/api/share",
      ]);
      expect(calls[2].init?.headers).toBeUndefined();
      expect((calls[2].init!.body as FormData).get("title")).toBe("Example");
      expect(repoImageSrc("notes/photo.png", a)).toBe("https://alpha.example/api/files/content?path=notes%2Fphoto.png&raw=1");
      expect(repoImageSrc("/api/files/content?path=image.png&raw=1", b)).toBe("https://beta.example/api/files/content?path=image.png&raw=1");
      expect(repoImageSrc("https://images.example/picture.png", a)).toBe("https://images.example/picture.png");
    } finally { a.dispose(); b.dispose(); }
  });
});
