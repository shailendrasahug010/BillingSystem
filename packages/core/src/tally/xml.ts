/**
 * A small XML reader and writer for Tally's files. Tally writes plain XML
 * (no namespaces that matter, tags such as ADDRESS.LIST), often as UTF-16;
 * decoding is the caller's (see `decodeTallyFile`). Not a general parser:
 * no DTDs; comments, processing instructions and CDATA are understood.
 */
// Core is built without DOM or Node types; both runtimes have TextDecoder.
declare const TextDecoder: new (label?: string) => { decode(input: Uint8Array): string };

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      // Tally writes control characters such as &#4; for blank values.
      return code < 32 && code !== 9 && code !== 10 && code !== 13 ? "" : String.fromCodePoint(code);
    }
    return ENTITY[e.toLowerCase()] ?? whole;
  });
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Parses the document; the returned root holds the top-level elements. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const tag = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<![^>]*>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(xml))) {
    const top = stack[stack.length - 1]!;
    if (m.index > last) top.text += decodeEntities(xml.slice(last, m.index));
    last = tag.lastIndex;
    if (m[5] !== undefined) {
      top.text += m[5];
      continue;
    }
    if (!m[2]) continue;
    const [, closing, name, rawAttrs, selfClosing] = m;
    if (closing) {
      // Close up to the matching element (tolerates a stray unclosed tag).
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i]!.name === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of rawAttrs!.matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]!.toUpperCase()] = decodeEntities(a[2] ?? a[3] ?? "");
    const node: XmlNode = { name: name!.toUpperCase(), attrs, children: [], text: "" };
    top.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

/** Direct children named `name`. */
export function kids(node: XmlNode | undefined, name: string): XmlNode[] {
  return node ? node.children.filter((c) => c.name === name) : [];
}

/** The first direct child named `name`. */
export function kid(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((c) => c.name === name);
}

/** The trimmed text of the first direct child named `name` ("" if none). */
export function textOf(node: XmlNode | undefined, name: string): string {
  return kid(node, name)?.text.trim() ?? "";
}

/** Every descendant named `name`, in document order. */
export function descendants(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    descendants(c, name, out);
  }
  return out;
}

/**
 * Tally saves XML as UTF-16 (with a byte-order mark) or UTF-8; this reads
 * either from the file's bytes.
 */
export function decodeTallyFile(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  // UTF-16 without a mark: every other byte of "<ENVELOPE" is zero.
  if (bytes.length > 3 && bytes[0] === 0x3c && bytes[1] === 0) return new TextDecoder("utf-16le").decode(bytes);
  const text = new TextDecoder("utf-8").decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
