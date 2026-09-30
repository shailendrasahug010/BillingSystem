import { SourceMapConsumer, type RawSourceMap } from "source-map-js";

/**
 * Development only: the dev server's modules carry their source map inline,
 * so a stack from them is mapped here to the source file and line before it
 * is sent to the error log. (A production build is mapped by the server.)
 */
const consumers = new Map<string, Promise<{ map: SourceMapConsumer; dir: string } | null>>();

function consumerFor(url: string) {
  let found = consumers.get(url);
  if (!found) {
    found = (async () => {
      const text = await (await fetch(url)).text();
      const inline = /\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)\s*$/.exec(text);
      if (!inline) return null;
      const raw = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(inline[1]!), (c) => c.charCodeAt(0)))) as RawSourceMap;
      return { map: new SourceMapConsumer(raw), dir: new URL(url).pathname.replace(/[^/]*$/, "") };
    })().catch(() => null);
    consumers.set(url, found);
  }
  return found;
}

export async function mapDevStack(stack: string): Promise<string> {
  const lines = await Promise.all(
    stack.split("\n").map(async (line) => {
      const m = /(https?:\/\/[^\s()]+?):(\d+):(\d+)/.exec(line);
      if (!m || new URL(m[1]!).origin !== location.origin) return line;
      const found = await consumerFor(m[1]!);
      const pos = found?.map.originalPositionFor({ line: Number(m[2]), column: Number(m[3]) - 1 });
      if (!pos?.source || !pos.line) return line;
      // Sources are absolute paths (/home/…/apps/web/src/…) or names next to the module.
      const source = pos.source.includes("/") ? pos.source : `${found!.dir}${pos.source}`;
      return line.replace(m[0], `${source}:${pos.line}:${(pos.column ?? 0) + 1}`);
    }),
  );
  return lines.join("\n");
}
