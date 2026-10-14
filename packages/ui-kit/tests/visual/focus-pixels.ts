export async function pixels(base64: string) {
  const img = new Image(); img.src = `data:image/png;base64,${base64}`; await img.decode();
  const canvas = document.createElement("canvas"); canvas.width = img.width; canvas.height = img.height;
  const ctx = canvas.getContext("2d")!; ctx.drawImage(img, 0, 0);
  return { data: ctx.getImageData(0, 0, img.width, img.height).data, width: img.width, height: img.height };
}

/** The 45-degree arc must contain INK, not just a computed outline clipped away.
 * Sample a neighbourhood to allow native antialiasing, never the rectangle's
 * straight top/side segments. Missing, rectangular and chopped rings all fail. */
export function cornerInk(png: Awaited<ReturnType<typeof pixels>>, theme: string, right = false, bottom = false, radius = 15) {
  const at = Math.round(radius * (1 - Math.SQRT1_2)) + 2;
  let ink = 0;
  for (let y = at - 2; y <= at + 2; y++) for (let x = at - 2; x <= at + 2; x++) {
    const i = ((bottom ? png.height - 1 - y : y) * png.width + (right ? png.width - 1 - x : x)) * 4;
    const light = (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
    if (theme === "dark" ? light > 160 : light < 100) ink++;
  }
  return ink;
}
