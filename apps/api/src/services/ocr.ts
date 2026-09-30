import { createRequire } from "node:module";
import path from "node:path";
import { createWorker, OEM, type Worker } from "tesseract.js";
import { ApiError, badRequest } from "../lib/errors.js";

/**
 * Reading the printed text of a photographed or scanned page (a supplier's
 * bill) with Tesseract, on the server so phones do not download the engine.
 * The app sends each page as a PNG or JPEG it has already straightened out
 * (lighting evened, table rules erased); the reply is the page's lines of
 * text, each split into cells where the printed gap is wider than a word
 * space. The app then rebuilds the bill's table from them the same way as
 * for a PDF made by billing software.
 */
export interface OcrCell {
  text: string;
  /** Left and right edge, in pixels. */
  x0: number;
  x1: number;
}

export interface OcrLine {
  /** Baseline, in pixels from the top of the page. */
  y: number;
  /** Height of the letters (capital to descender), in pixels. */
  height: number;
  cells: OcrCell[];
}

export interface OcrPage {
  width: number;
  height: number;
  lines: OcrLine[];
}

const MAX_SIDE = 6000;
const MAX_PIXELS = 24_000_000;
/** Pages waiting their turn beyond this are refused: try again in a moment. */
const MAX_WAITING = 4;
const JOB_TIMEOUT_MS = 60_000;
const IDLE_MS = 5 * 60_000;

/** Kind and size of a PNG or JPEG from its header, without decoding it. */
export function imageSize(file: Buffer): { type: "png" | "jpeg"; width: number; height: number } | null {
  if (file.length >= 24 && file.readUInt32BE(0) === 0x89504e47 && file.readUInt32BE(4) === 0x0d0a1a0a && file.toString("latin1", 12, 16) === "IHDR") {
    return { type: "png", width: file.readUInt32BE(16), height: file.readUInt32BE(20) };
  }
  if (file.length < 4 || file[0] !== 0xff || file[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < file.length) {
    if (file[i] !== 0xff) return null;
    const marker = file[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    // Markers without a length: restart markers, start/end of image, TEM.
    if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      i += 2;
      continue;
    }
    // Start of frame (any kind but DHT, JPG and DAC) holds the size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { type: "jpeg", height: file.readUInt16BE(i + 5), width: file.readUInt16BE(i + 7) };
    }
    i += 2 + file.readUInt16BE(i + 2);
  }
  return null;
}

/** Rules and specks the reader turned into characters: nothing but punctuation. */
const EDGE_JUNK = /^[|[\]{}"'‘’“”`~_=+—–«»]+|[|[\]{}"'‘’“”`~_=+—–«»]+$/gu;
const MEANINGFUL = /[\p{L}\p{N}₹%]/u;

interface TessWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}
interface TessLine {
  text: string;
  words: TessWord[];
  baseline: { x0: number; y0: number; x1: number; y1: number };
  rowAttributes: { rowHeight: number; descenders: number; ascenders: number };
}

/**
 * The page's lines, each cut into cells. Words the reader separated by a
 * single space stay together ("Parle-G Biscuit 100g"); a wider gap, or a
 * scrap of a table rule between two words, starts a new cell.
 */
export function pageLines(lines: readonly TessLine[]): OcrLine[] {
  const out: OcrLine[] = [];
  for (const line of lines) {
    const cells: OcrCell[] = [];
    let cursor = 0;
    let broken = true;
    for (const word of line.words) {
      // How many spaces the reader put before this word (the gap it saw).
      const at = line.text.indexOf(word.text, cursor);
      const spaces = at < 0 ? 2 : line.text.slice(cursor, at).length;
      if (at >= 0) cursor = at + word.text.length;
      const text = word.text.replace(EDGE_JUNK, "");
      if (word.confidence < 20 || !MEANINGFUL.test(text)) {
        broken = true;
        continue;
      }
      const last = cells.at(-1);
      if (last && !broken && spaces <= 1) {
        last.text += ` ${text}`;
        last.x1 = word.bbox.x1;
      } else cells.push({ text, x0: word.bbox.x0, x1: word.bbox.x1 });
      broken = false;
    }
    if (!cells.length) continue;
    out.push({
      y: Math.round((line.baseline.y0 + line.baseline.y1) / 2),
      height: Math.max(1, Math.round(line.rowAttributes.rowHeight + line.rowAttributes.descenders)),
      cells,
    });
  }
  return out;
}

let worker: Promise<Worker> | null = null;
let queue: Promise<unknown> = Promise.resolve();
let waiting = 0;
let idleTimer: NodeJS.Timeout | null = null;

function languageDir(): string {
  const resolve = createRequire(import.meta.url).resolve;
  return path.join(path.dirname(resolve("@tesseract.js-data/eng/package.json")), "4.0.0_best_int");
}

function startWorker(): Promise<Worker> {
  worker ??= (async () => {
    const w = await createWorker("eng", OEM.LSTM_ONLY, { langPath: languageDir(), gzip: true, cacheMethod: "none" });
    // 6: the page as one block of text, so a table row stays one line across its columns.
    await w.setParameters({ tessedit_pageseg_mode: "6" as never, preserve_interword_spaces: "1", debug_file: "/dev/null" });
    return w;
  })().catch((e) => {
    worker = null;
    throw e;
  });
  return worker;
}

async function stopWorker(): Promise<void> {
  const w = worker;
  worker = null;
  if (w) await (await w.catch(() => null))?.terminate();
}

async function recognise(image: Buffer): Promise<OcrLine[]> {
  const w = await startWorker();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ApiError(503, "OCR_FAILED")), JOB_TIMEOUT_MS);
  });
  try {
    // Straightened first (a photo taken at a slight angle), so columns line up down the page.
    const { data } = await Promise.race([w.recognize(image, { rotateAuto: true }, { blocks: true, text: false }), timeout]);
    const lines = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines)) as unknown as TessLine[];
    return pageLines(lines);
  } catch (e) {
    // A stuck or broken reader is replaced for the next page.
    await stopWorker();
    throw e instanceof ApiError ? e : new ApiError(503, "OCR_FAILED");
  } finally {
    clearTimeout(timer);
  }
}

/** Reads one page image. Pages are read one at a time; the reader stops after a few idle minutes. */
export async function readPageImage(image: Buffer): Promise<OcrPage> {
  const size = imageSize(image);
  if (!size || size.width < 1 || size.height < 1) throw badRequest("OCR_IMAGE_UNSUPPORTED");
  if (size.width > MAX_SIDE || size.height > MAX_SIDE || size.width * size.height > MAX_PIXELS) throw badRequest("OCR_IMAGE_TOO_LARGE", { max: MAX_SIDE });
  if (waiting >= MAX_WAITING) throw new ApiError(503, "OCR_BUSY");
  waiting++;
  if (idleTimer) clearTimeout(idleTimer);
  const job = queue.then(() => recognise(image));
  queue = job.catch(() => undefined);
  try {
    return { width: size.width, height: size.height, lines: await job };
  } finally {
    waiting--;
    if (waiting === 0) {
      idleTimer = setTimeout(() => void stopWorker(), IDLE_MS);
      idleTimer.unref();
    }
  }
}

/** Stops the reader (server shutdown, tests). */
export async function closeOcr(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  await stopWorker();
}
