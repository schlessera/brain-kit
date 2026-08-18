import { describe, expect, test } from "bun:test";
import { imageFilenameFromSrc } from "../src/lib/image-source.js";

describe("imageFilenameFromSrc", () => {
  test("recovers the repo filename from a files-API url", () => {
    const src = "/api/files/content?path=assets%2Fimages%2Fweekly-plan.png&raw=1";
    expect(imageFilenameFromSrc(src)).toBe("weekly-plan.png");
  });

  test("prefers the path parameter over the route's own last segment", () => {
    const src = "https://brain.example/api/files/content?path=notes%2Fa.jpg&raw=1";
    expect(imageFilenameFromSrc(src)).toBe("a.jpg");
  });

  test("handles a path with spaces and unicode", () => {
    const src = `/api/files/content?path=${encodeURIComponent("travel/kyoto trip/café.png")}&raw=1`;
    expect(imageFilenameFromSrc(src)).toBe("café.png");
  });

  test("falls back for data and blob urls, using the mime for the extension", () => {
    expect(imageFilenameFromSrc("data:image/png;base64,AAAA", "image/png")).toBe("image.png");
    expect(imageFilenameFromSrc("blob:http://x/abc-123", "image/jpeg")).toBe("image.jpg");
    expect(imageFilenameFromSrc("blob:http://x/abc-123")).toBe("image");
  });

  test("uses the last url segment for a plain image url", () => {
    expect(imageFilenameFromSrc("https://example.com/a/b/diagram.svg")).toBe("diagram.svg");
    expect(imageFilenameFromSrc("https://example.com/a/b/photo.jpg?w=200")).toBe("photo.jpg");
  });

  test("a segment with no extension is not a filename", () => {
    expect(imageFilenameFromSrc("https://example.com/images/latest")).toBe("image");
    expect(imageFilenameFromSrc("https://example.com/images/latest", "image/webp")).toBe(
      "image.webp"
    );
  });

  test("never returns an empty name", () => {
    expect(imageFilenameFromSrc("")).toBe("image");
    expect(imageFilenameFromSrc("/")).toBe("image");
    // Malformed percent-encoding must not throw out of the helper.
    expect(imageFilenameFromSrc("/api/files/content?path=%E0%A4%A&raw=1")).toBe("image");
  });
});
