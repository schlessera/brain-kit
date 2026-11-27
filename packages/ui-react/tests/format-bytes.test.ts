import { describe, expect, test } from "bun:test";
import { bytesLabelGrew, formatBytes } from "../src/lib/format-bytes.js";
import { formatSize } from "../src/components/files/file-viewer-frame.js";
import { formatBytes as imageShareBytes } from "../src/lib/image-optimize.js";
import { buildSharePrompt } from "../src/lib/share-intake.js";

const share = (bytes: number) => buildSharePrompt({ id: "raft", dir: ".brain-ui/inbox/raft", receivedAt: 1, files: [{ name: "raft-plan.pdf", path: "raft/raft-plan.pdf", mediaType: "application/pdf", bytes }] });
const shareSize = (bytes: number) => /raft-plan\.pdf \(application\/pdf, ([^)]+)\)/.exec(share(bytes))?.[1];

describe("formatBytes: the kit's one rule (#4735)", () => {
  for (const [bytes, label] of [
    [0, "0 B"], [1_000, "1000 B"], [1_023, "1023 B"], [1_024, "1 KB"], [1_536, "2 KB"],
    [1_048_576, "1 MB"], [1_572_864, "1.5 MB"], [52_428_800, "50 MB"],
  ] as const) test(`${bytes} → ${label}`, () => {
    expect(formatBytes(bytes)).toBe(label);
  });

  test("the file viewer and a share print one file's size the same way", () => {
    expect(formatSize(1_572_864)).toBe("1.5 MB");
    expect(shareSize(1_572_864)).toBe("1.5 MB");
  });
});

describe("bytesLabelGrew (#4735)", () => {
  test("true when the displayed figure grows", () => {
    expect(bytesLabelGrew(4096, 8192)).toBe(true);
  });
  test("false when the label stays the same or the size does not grow", () => {
    expect(bytesLabelGrew(4096, 4097)).toBe(false);
    expect(bytesLabelGrew(8192, 4096)).toBe(false);
    expect(bytesLabelGrew(4096, 4096)).toBe(false);
  });
});

describe("share text and image share hints agree (#4773)", () => {
  test("a 1,536-byte file reads the same in the share message as in an image share hint", () => {
    expect(shareSize(1_536)).toBe(imageShareBytes(1_536));
  });
});
