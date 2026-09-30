import { schema } from "@vyapaar/db";
import { eq } from "drizzle-orm";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { minified, parseStack, placesOf, type ErrorEntry, type Frame } from "../lib/errorLog.js";
import type { ApiModule } from "./types.js";

const ClientErrorBody = z.strictObject({
  kind: z.enum(["error", "unhandledrejection", "render"]),
  name: z.string().max(100).optional(),
  message: z.string().max(2000),
  stack: z.string().max(16_000).optional(),
  /** React's list of the components the failing one sat in (render errors). */
  componentStack: z.string().max(8000).optional(),
  /** The stack already points at source files (the development server maps it in the browser). */
  mapped: z.boolean().optional(),
  /** The screen the person was on, e.g. "reports". */
  screen: z.string().max(100).optional(),
  page: z.string().max(500).optional(),
  appVersion: z.string().max(40).optional(),
  /** Made by the app so it can show it at once, even before this arrives. */
  reference: z.uuid().optional(),
});

/** "Chrome 129 on Android", "Safari 17 on iPhone", from a user agent. */
export function browserOf(ua: string | undefined): string | undefined {
  if (!ua) return undefined;
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "another system";
  const m = /(Edg|OPR|SamsungBrowser|Firefox|Chrome|Version)\/(\d+)/.exec(ua);
  const names: Record<string, string> = { Edg: "Edge", OPR: "Opera", SamsungBrowser: "Samsung Internet", Firefox: "Firefox", Chrome: "Chrome", Version: "Safari" };
  return m ? `${names[m[1]!]} ${m[2]} on ${os}` : `a browser on ${os}`;
}

/**
 * The components a render error happened in, innermost first: "GroupedReport › Reports › Suspense".
 * In a built app React names them as minified; each is then named from its place in the source.
 */
async function componentsOf(componentStack: string | undefined, mapped: boolean, map: (f: Frame[]) => Promise<Frame[]>): Promise<string | undefined> {
  if (!componentStack) return undefined;
  const names: string[] = [];
  for (const line of componentStack.split("\n")) {
    const frame = parseStack(line)[0];
    // "at Name (url:1:2)" or "at Name" (Chrome), "Name@url:1:2" (Firefox, Safari); an unnamed one is just "at url:1:2".
    const plain = /^\s*at\s+([A-Za-z_$][\w$.]*)(?:\s+\(|\s*$)/.exec(line)?.[1] ?? /^\s*([A-Za-z_$][\w$.]*)@/.exec(line)?.[1];
    if (frame && !mapped) {
      const [m] = await map([frame]);
      // Our own components by their name in the source; a library's by the name React shows.
      const name = (!m!.file.includes("node_modules") && m!.fn) || plain;
      if (!minified(name)) names.push(name!);
    } else if (plain && /^[A-Z]/.test(plain) && !minified(plain)) names.push(plain);
    if (names.length >= 8) break;
  }
  return names.length ? names.join(" › ") : undefined;
}

/**
 * Errors the web app meets in the browser (a screen that crashed, a failed
 * promise) are sent here and written to the same error log as the API's,
 * mapped back to the source file and line with the build's private source
 * maps. Works before sign-in too; signed in, the person is noted.
 */
export const clientErrorsModule: ApiModule = async (app, deps) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/client-errors",
    { bodyLimit: 64 * 1024, config: { rateLimit: { max: 20, timeWindow: "1 minute" } }, schema: { tags: ["system"], body: ClientErrorBody } },
    async (request, reply) => {
      const body = request.body;
      let user: ErrorEntry["user"];
      const header = request.headers.authorization;
      if (header?.startsWith("Bearer ")) {
        try {
          const who = await deps.tokens.verifyAccess(header.slice(7));
          const [row] = await deps.db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, who.userId));
          user = { id: who.userId, name: row?.name ?? null, businessId: who.businessId };
        } catch {
          // An expired or bad token: the error is still worth keeping.
        }
      }
      const frames = parseStack(body.stack);
      const { where, stack } = placesOf(body.mapped ? frames : await deps.errors.maps.map(frames), "apps/web/");
      const components = await componentsOf(body.componentStack, body.mapped === true, (f) => deps.errors.maps.map(f));
      const entry = deps.errors.write({
        reference: body.reference ?? uuidv7(),
        source: "web",
        message: body.message || "(no message)",
        kind: `${body.name ?? "Error"}${body.kind === "render" ? " while showing a screen" : body.kind === "unhandledrejection" ? " in a promise nothing handled" : ""}`,
        where,
        stack,
        ...(body.screen ? { screen: body.screen } : {}),
        ...(body.page ? { page: body.page } : {}),
        ...(browserOf(request.headers["user-agent"]) ? { browser: browserOf(request.headers["user-agent"])! } : {}),
        ...(body.appVersion ? { appVersion: body.appVersion } : {}),
        ...(user ? { user } : {}),
        ...(components ? { details: { components } } : {}),
      });
      reply.code(202);
      return { reference: entry.reference };
    },
  );
};
