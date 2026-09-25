/**
 * Prepares a picked image as the firm's logo: shrunk on this device to at
 * most 512 px on its longer side (keeping transparency), then encoded as
 * WebP where the browser can, else PNG, getting smaller until it fits the
 * server's limit.
 */
const MAX_BYTES = 290 * 1024;

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("INVALID_IMAGE"));
    };
    img.src = url;
  });
}

const bytesOf = (dataUrl: string) => Math.floor(((dataUrl.length - dataUrl.indexOf(",") - 1) * 3) / 4);

export async function prepareLogo(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp|svg\+xml|gif|bmp)$/.test(file.type)) throw new Error("INVALID_IMAGE");
  const img = await loadImage(file);
  for (const side of [512, 384, 256, 192]) {
    const scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const [type, quality] of [
      ["image/webp", 0.9],
      ["image/png", undefined],
    ] as const) {
      const url = canvas.toDataURL(type, quality);
      // Safari cannot encode WebP and hands back PNG: accept whatever came out.
      if (/^data:image\/(png|webp);base64,/.test(url) && bytesOf(url) <= MAX_BYTES) return url;
    }
  }
  throw new Error("IMAGE_TOO_LARGE");
}
