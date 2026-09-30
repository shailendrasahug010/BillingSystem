/**
 * A photographed or scanned page made ready to be read: sized so its print
 * is the height the reader reads best (letters about 40 px tall; much
 * larger or smaller and it misreads digits), lighting evened out (a shadow,
 * a dark table under the paper), contrast raised, and table rules erased
 * (the reader mistakes them for letters and loses the text beside them).
 * The work runs in a worker where the browser allows, so the screen stays
 * responsive.
 */

const MAX_PIXELS = 12_000_000;
const MAX_SIDE = 5000;
/** A quick first look, to measure the print. */
const MEASURE_PIXELS = 3_000_000;
/** Letters and digits (see printHeight) the reader reads best at, in pixels: lines about 38 px tall. */
const PRINT = 26;

/** The largest scale up to `want` that keeps a page of `width` x `height` within the limits. */
export function fitScale(width: number, height: number, want: number): number {
  return Math.min(want, Math.sqrt(MAX_PIXELS / (width * height)), MAX_SIDE / Math.max(width, height));
}

/** Grey levels (0 black - 255 white) of RGBA pixels. */
export function greyOf(rgba: Uint8ClampedArray): Uint8ClampedArray {
  const grey = new Uint8ClampedArray(rgba.length / 4);
  for (let i = 0; i < grey.length; i++) grey[i] = 0.299 * rgba[4 * i]! + 0.587 * rgba[4 * i + 1]! + 0.114 * rgba[4 * i + 2]!;
  return grey;
}

/** Cleans up the grey levels of a page in place (see above). */
export function preparePage(grey: Uint8ClampedArray, width: number, height: number): void {
  const W = width;
  const H = height;
  const long = Math.max(W, H);

  // 1. How bright the paper is around each point: the brightest pixel of each block, smoothed.
  const B = Math.max(16, Math.round(long / 48));
  const bw = Math.ceil(W / B);
  const bh = Math.ceil(H / B);
  const top = new Float32Array(bw * bh);
  for (let y = 0; y < H; y++) {
    const row = Math.floor(y / B) * bw;
    for (let x = 0; x < W; x++) {
      const k = row + Math.floor(x / B);
      const v = grey[y * W + x]!;
      if (v > top[k]!) top[k] = v;
    }
  }
  const paper = new Float32Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy >= 0 && yy < bh && xx >= 0 && xx < bw) {
            sum += top[yy * bw + xx]!;
            n++;
          }
        }
      }
      paper[y * bw + x] = sum / n;
    }
  }

  // 2. Each pixel against its paper, then faint grey to white and ink to black.
  for (let y = 0; y < H; y++) {
    const fy = Math.min(bh - 1, Math.max(0, y / B - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(bh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(bw - 1, Math.max(0, x / B - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(bw - 1, x0 + 1);
      const tx = fx - x0;
      const bg = (paper[y0 * bw + x0]! * (1 - tx) + paper[y0 * bw + x1]! * tx) * (1 - ty) + (paper[y1 * bw + x0]! * (1 - tx) + paper[y1 * bw + x1]! * tx) * ty;
      const v = (255 * grey[y * W + x]!) / Math.max(bg, 1);
      grey[y * W + x] = ((v - 90) * 255) / 140;
    }
  }

  // 3. Rules: dark runs far longer than any letter, across or down. A rule in a photo
  // taken at a slight angle steps a pixel now and then, so a run may carry on a pixel
  // up or down (left or right); only the dark pixels on the run are erased.
  const dark = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) dark[i] = grey[i]! < 190 ? 1 : 0;
  const erase = new Uint8Array(W * H);
  const across = Math.round(long / 30);
  const down = Math.round(long / 40);
  for (let y = 0; y < H; y++) {
    let start = -1;
    for (let x = 0; x <= W; x++) {
      const i = y * W + x;
      const d = x < W && (dark[i] || (y > 0 && dark[i - W]) || (y < H - 1 && dark[i + W]));
      if (d && start < 0) start = x;
      else if (!d && start >= 0) {
        if (x - start >= across) for (let k = y * W + start; k < i; k++) if (dark[k]) erase[k] = 1;
        start = -1;
      }
    }
  }
  for (let x = 0; x < W; x++) {
    let start = -1;
    for (let y = 0; y <= H; y++) {
      const i = y * W + x;
      const d = y < H && (dark[i] || (x > 0 && dark[i - 1]) || (x < W - 1 && dark[i + 1]));
      if (d && start < 0) start = y;
      else if (!d && start >= 0) {
        if (y - start >= down) for (let k = start; k < y; k++) if (dark[k * W + x]) erase[k * W + x] = 1;
        start = -1;
      }
    }
  }
  // The soft edge of an erased rule goes with it.
  for (let i = 0; i < W * H; i++) {
    if (erase[i] || ((erase[i - 1] || erase[i + 1] || erase[i - W] || erase[i + W]) && grey[i]! < 230)) grey[i] = 255;
  }
}

/**
 * How tall the print on a cleaned-up page is: the middle height of the
 * letter-sized dark shapes (a letter, a digit; not rules, specks or words
 * run together). Null when there is too little print to tell.
 */
export function printHeight(grey: Uint8ClampedArray, width: number, height: number): number | null {
  const W = width;
  const H = height;
  // Shapes: pixels joined across or down (union-find over the dark pixels).
  const parent = new Int32Array(W * H).fill(-1);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (grey[i]! >= 128) continue;
      parent[i] = i;
      if (x > 0 && parent[i - 1]! >= 0) parent[find(i)] = find(i - 1);
      if (y > 0 && parent[i - W]! >= 0) {
        const a = find(i);
        const b = find(i - W);
        if (a !== b) parent[a] = b;
      }
    }
  }
  const top = new Map<number, number[]>();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (parent[i]! < 0) continue;
      const r = find(i);
      const box = top.get(r);
      if (!box) top.set(r, [x, y, x, y]);
      else {
        if (x < box[0]!) box[0] = x;
        if (x > box[2]!) box[2] = x;
        box[3] = y;
      }
    }
  }
  const tall = Math.max(W, H) / 40;
  const heights: number[] = [];
  for (const [x0, y0, x1, y1] of top.values()) {
    const h = y1! - y0! + 1;
    const w = x1! - x0! + 1;
    if (h >= 5 && h <= tall && w <= 2 * h) heights.push(h);
  }
  if (heights.length < 30) return null;
  heights.sort((a, b) => a - b);
  return heights[Math.floor(heights.length / 2)]!;
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

function makeCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

function context(c: AnyCanvas) {
  const g = c.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!g) throw new Error("no 2d canvas");
  return g;
}

/** A cleaned-up page as a greyscale PNG. */
export async function encodePage(grey: Uint8ClampedArray, width: number, height: number): Promise<Blob> {
  const c = makeCanvas(width, height);
  const g = context(c);
  const img = g.createImageData(width, height);
  for (let i = 0; i < grey.length; i++) {
    img.data[4 * i] = img.data[4 * i + 1] = img.data[4 * i + 2] = grey[i]!;
    img.data[4 * i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  if ("convertToBlob" in c) return c.convertToBlob({ type: "image/png" });
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("png"))), "image/png"));
}

/** What the worker (or this page, without one) is asked to do with a drawn page. */
export interface PageJob {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  /** Only measure the print (see printHeight); else clean up and encode. */
  measure: boolean;
}

export async function doPageJob(job: PageJob): Promise<{ print: number | null } | { png: Blob }> {
  const grey = greyOf(job.rgba);
  preparePage(grey, job.width, job.height);
  return job.measure ? { print: printHeight(grey, job.width, job.height) } : { png: await encodePage(grey, job.width, job.height) };
}

let worker: Worker | null | undefined;

function pageWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" ? new Worker(new URL("./pageImage.worker.ts", import.meta.url), { type: "module" }) : null;
  } catch {
    worker = null;
  }
  return worker;
}

/** Draws the page at `scale` and has it measured or cleaned up, in the worker when there is one. */
async function drawn(source: CanvasImageSource, width: number, height: number, scale: number, measure: boolean) {
  const W = Math.max(1, Math.round(width * scale));
  const H = Math.max(1, Math.round(height * scale));
  const c = makeCanvas(W, H);
  const g = context(c);
  g.fillStyle = "#fff";
  g.fillRect(0, 0, W, H);
  g.imageSmoothingQuality = "high";
  g.drawImage(source, 0, 0, W, H);
  const job: PageJob = { rgba: g.getImageData(0, 0, W, H).data, width: W, height: H, measure };
  const w = pageWorker();
  if (w) {
    try {
      return await new Promise<Awaited<ReturnType<typeof doPageJob>>>((resolve, reject) => {
        w.onmessage = (e: MessageEvent<Awaited<ReturnType<typeof doPageJob>> | { error: string }>) => ("error" in e.data ? reject(new Error(e.data.error)) : resolve(e.data));
        w.onerror = (e) => reject(new Error(e.message));
        w.postMessage(job, [job.rgba.buffer]);
      });
    } catch {
      // The worker could not do it (an old browser): do it here instead.
      worker = null;
      return drawn(source, width, height, scale, measure);
    }
  }
  return doPageJob(job);
}

/**
 * A page (a photo, or a scanned PDF page drawn on a canvas) at the size it
 * reads best at, cleaned up, as a PNG to send to the reader. A quick first
 * look measures the print; the page is then drawn so it comes out the
 * right height.
 */
export async function pageForReading(source: CanvasImageSource, width: number, height: number): Promise<Blob> {
  const look = fitScale(width, height, Math.min(1, Math.sqrt(MEASURE_PIXELS / (width * height))));
  const measured = await drawn(source, width, height, look, true);
  const print = "print" in measured ? measured.print : null;
  // Too little print to measure: about 300 dpi for an A4 page.
  const scale = print ? fitScale(width, height, Math.min(3, (look * PRINT) / print)) : fitScale(width, height, Math.min(2.5, Math.sqrt(8_500_000 / (width * height))));
  const page = await drawn(source, width, height, scale, false);
  if (!("png" in page)) throw new Error("page not encoded");
  return page.png;
}
