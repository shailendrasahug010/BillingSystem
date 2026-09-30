// Bundles the API and the workspace packages it uses (@vyapaar/*, shipped as
// TypeScript source) into dist/main.js (server) and dist/deploy.js
// (migrations + app role + reference data, run once per release) and dist/errors.js (reads the error
// log: node dist/errors.js). Third-party dependencies declared by
// this package stay external and are installed with `pnpm deploy --prod`.
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith("@vyapaar/"));

await build({
  entryPoints: ["src/main.ts", "src/deploy.ts", "src/errors.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outdir: "dist",
  sourcemap: true,
  external: [...external, "pino-pretty"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});
